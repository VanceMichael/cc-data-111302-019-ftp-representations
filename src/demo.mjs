import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createFtpServer } from './ftp-server.mjs';
import { Collector } from './collector.mjs';
import { FtpClient, FtpError } from './ftp-client.mjs';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const line = (title) => console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);

async function makeWorkspace(label) {
  const root = await mkdtemp(join(tmpdir(), `ftp-claim-${label}-`));
  return { root, collector: null };
}

async function showTree(root) {
  async function walk(dir, prefix = '') {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        console.log(`${prefix}${entry.name}/`);
        await walk(full, `${prefix}  `);
      } else {
        const size = (await stat(full)).size;
        console.log(`${prefix}${entry.name} (${size} B)`);
      }
    }
  }
  console.log(`工作区 ${root} 的落盘结构：`);
  await walk(root);
}

async function showReceipt(receipt) {
  console.log(`收件确认：status=${receipt.status} representation=${receipt.representation} attempt=${receipt.attemptId}`);
  if (receipt.resume) console.log(`  续传决策：${receipt.resume.note}`);
  if (receipt.preMeta) console.log(`  前置元数据：SIZE=${receipt.preMeta.size} MDTM=${receipt.preMeta.mtime}`);
  if (receipt.postMeta) console.log(`  后置元数据：SIZE=${receipt.postMeta.size} MDTM=${receipt.postMeta.mtime}`);
  if (receipt.received) {
    console.log(`  原始接收：${receipt.received.dataBytes} 网络字节 sha256=${receipt.received.rawSha256.slice(0, 16)}…`);
  }
  if (receipt.canonical) console.log(`  规范内容：${receipt.canonical.bytes} B sha256=${receipt.canonical.sha256.slice(0, 16)}…`);
  for (const note of receipt.verification) console.log(`  核对：${note}`);
  if (receipt.failure) console.log(`  失败原因：[${receipt.failure.reason}] ${receipt.failure.message}`);
  if (receipt.inboxEntry) console.log(`  入目录：${receipt.inboxEntry}`);
}

async function main() {
  // 同一台机器上起合成 FTP 来源：控制连接 + 动态 PASV 数据端口，全在回环地址。
  const state = {
    finalDelay: 15,
    pasvHost: '127,0,0,1',
    files: {
      // LF 存储；TYPE A 时服务器在数据通道转 CRLF。
      'observe.txt': { content: '站点A,21.4\n站点B,19.8\n站点C,22.1\n', mtime: '20261114090000', version: 1 },
      'observe.bin': {
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0xfd]),
        mtime: '20261114090500',
        version: 1,
      },
      'ledger.txt': { content: 'row-1\nrow-2\nrow-3\nrow-4\n', mtime: '20261114091000', version: 1 },
      'resume.bin': {
        content: Buffer.concat([Buffer.from('0123456789abcdef'.repeat(4)), Buffer.from([0, 1, 2, 3, 4, 5])]),
        mtime: '20261114091500',
        version: 1,
      },
    },
    faults: {},
  };
  const server = await createFtpServer(state);
  const endpoint = server.endpoint;
  console.log(`合成 FTP 来源就绪：控制通道 ${endpoint.host}:${endpoint.port}（PASV 数据端口动态分配，均绑定回环）`);

  try {
    // 场景一：文本表示换行 —— 网络字节与落盘字节本来就不同，尺寸不能乱套。
    line('场景 1：文本传输表示（TYPE A）—— CRLF 是网络事实，规范内容折回 LF');
    {
      const { root } = await makeWorkspace('text');
      const collector = new Collector({ workspace: root, endpoint, pinHosts: ['127.0.0.1'] });
      const receipt = await collector.claim('observe.txt', { representation: 'A' });
      await showReceipt(receipt);
      const stored = state.files['observe.txt'].content;
      const inboxBytes = await readFile(join(root, 'inbox', 'observe.txt'));
      console.log(`  来源存储 ${stored.length} B（LF），网络接收 ${receipt.received.dataBytes} B（CRLF），inbox 规范 ${inboxBytes.length} B（LF）`);
      console.log(`  inbox 与来源存储逐字节一致：${inboxBytes.equals(stored)}`);
      await showTree(root);
    }

    // 场景二：数据已收完，最终回复却是失败 —— 不能当成功，重取后成功。
    line('场景 2：数据流完整结束但最终回复 451 —— 数据关闭 ≠ 成功');
    {
      const { root } = await makeWorkspace('finalfail');
      const collector = new Collector({ workspace: root, endpoint, pinHosts: ['127.0.0.1'] });
      state.faults['observe.bin'] = { finalFail: true };
      const first = await collector.claim('observe.bin', { representation: 'I' });
      await showReceipt(first);
      console.log(`  第一次领取后 inbox 内容：${(await collector.listInbox()).join(', ') || '（空，失败版本被挡在目录外）'}`);
      state.faults['observe.bin'] = {};
      const second = await collector.claim('observe.bin', {
        representation: 'I',
        expectedSha256: sha256(state.files['observe.bin'].content),
      });
      await showReceipt(second);
      console.log(`  第二次领取后 inbox 内容：${(await collector.listInbox()).join(', ')}`);
      await showTree(root);
    }

    // 场景三：文件在领取过程中被替换 —— 前后元数据不一致，拒绝入目录。
    line('场景 3：领取中来源文件被替换 —— 前后身份核对失败，隔离不入目录');
    {
      const { root } = await makeWorkspace('replace');
      const collector = new Collector({ workspace: root, endpoint, pinHosts: ['127.0.0.1'] });
      state.faults['ledger.txt'] = { replaceAtOpen: true };
      const receipt = await collector.claim('ledger.txt', { representation: 'A' });
      await showReceipt(receipt);
      console.log(`  inbox 内容：${(await collector.listInbox()).join(', ') || '（空）'}`);
      state.faults['ledger.txt'] = {};
      const retry = await collector.claim('ledger.txt', { representation: 'A' });
      await showReceipt(retry);
      console.log(`  重取后 inbox 内容：${(await collector.listInbox()).join(', ')}`);
    }

    // 场景四：恢复领取 —— 二进制截断后续传；文本只能整份重取。
    line('场景 4：恢复领取 —— 二进制按身份续传，文本偏移不可靠必须重取');
    {
      const { root } = await makeWorkspace('resume');
      const collector = new Collector({ workspace: root, endpoint, pinHosts: ['127.0.0.1'] });
      const fullSize = state.files['resume.bin'].content.length;
      state.faults['resume.bin'] = { cutAfterBytes: 24 };
      const cut = await collector.claim('resume.bin', { representation: 'I' });
      await showReceipt(cut);
      console.log(`  服务器文件 ${fullSize} B，截断在 24 B；标记文件：${(await readdir(join(root, 'state'))).join(', ')}`);
      state.faults['resume.bin'] = {};
      const resumed = await collector.claim('resume.bin', {
        representation: 'I',
        expectedSha256: sha256(state.files['resume.bin'].content),
      });
      await showReceipt(resumed);
      console.log(`  续传交换中的 REST 命令：${resumed.exchange.some((e) => e.direction === 'C' && e.line.startsWith('REST '))}`);
      const inboxBytes = await readFile(join(root, 'inbox', 'resume.bin'));
      console.log(`  inbox 与来源逐字节一致：${inboxBytes.equals(state.files['resume.bin'].content)}`);

      // 文本表示即使留下半截也不能拿本地位置当服务器偏移。
      state.faults['observe.txt'] = { cutAfterBytes: 10 };
      const textCut = await collector.claim('observe.txt', { representation: 'A' });
      await showReceipt(textCut);
      state.faults['observe.txt'] = {};
      const textRetry = await collector.claim('observe.txt', { representation: 'A' });
      await showReceipt(textRetry);
      console.log(`  文本重取交换中是否含 REST：${textRetry.exchange.some((e) => e.direction === 'C' && e.line.startsWith('REST '))}`);
    }

    // 场景五：PASV 钉扎 —— 控制回复指向未批准主机时拒绝连接数据端点。
    line('场景 5：PASV 主机钉扎 —— 只连接本地配置批准的数据端点');
    {
      const evilClient = new FtpClient({
        host: endpoint.host,
        port: endpoint.port,
        pinHosts: ['127.0.0.1'],
      });
      state.pasvHost = '10,0,0,9'; // 控制回复里的任意地址，不可信。
      await evilClient.connect();
      await evilClient.setType('I');
      await evilClient.command('PASV');
      await assertRejects(
        () => evilClient.retrieve('observe.bin', { representation: 'I' }),
        /不在允许清单/,
        '必须拒绝未批准的数据端点',
      );
      await evilClient.close();
      state.pasvHost = '127,0,0,1';

      const goodClient = new FtpClient({ host: endpoint.host, port: endpoint.port, pinHosts: ['127.0.0.1'] });
      await goodClient.connect();
      const ok = await goodClient.retrieve('observe.bin', { representation: 'I' });
      console.log(`  批准主机上的领取成功：${ok.closing.text.trim()}，收到 ${ok.dataBytes} B`);
      await goodClient.close();
    }

    line('双通道时序留痕（场景 2 第二次成功领取的命令/回复流水）');
    {
      // 重新取一次用于展示完整关联：命令 → 150 初步回复 → 数据流 → 226 最终回复。
      const probe = new FtpClient({ host: endpoint.host, port: endpoint.port, pinHosts: ['127.0.0.1'] });
      await probe.connect();
      await probe.retrieve('observe.bin', { representation: 'I' });
      for (const event of probe.exchangeLog) {
        console.log(`  ${event.direction === 'C' ? '控制→' : '控制←'} ${event.line}`);
      }
      await probe.close();
    }
  } finally {
    await server.close();
  }
}

async function assertRejects(task, matcher, message) {
  try {
    await task();
  } catch (error) {
    if (!(error instanceof FtpError) || !matcher.test(error.message)) {
      throw new Error(`${message}；实际错误：${error.message}`);
    }
    console.log(`  已按预期拒绝：${error.message}`);
    return;
  }
  throw new Error(message);
}

main().catch((error) => {
  console.error('演示失败：', error);
  process.exitCode = 1;
});
