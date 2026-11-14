import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createSource } from '../src/source.mjs';
import { createFtpServer } from '../src/ftp-server.mjs';
import { FtpClient, FtpError } from '../src/ftp-client.mjs';
import { Collector, canonicalizeText } from '../src/collector.mjs';
import { inspect, readRaw } from '../src/client.mjs';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function withSource(callback) {
  const source = await createSource();
  try {
    return await callback(source);
  } finally {
    await source.close();
  }
}

async function workspace() {
  return mkdtemp(join(tmpdir(), 'ftp-collector-test-'));
}

function demoState() {
  return {
    finalDelay: 5,
    pasvHost: '127,0,0,1',
    files: {
      'observe.txt': { content: '站点A,21.4\n站点B,19.8\n', mtime: '20261114090000', version: 1 },
      'observe.bin': { content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), mtime: '20261114090500', version: 1 },
      'resume.bin': { content: Buffer.from('0123456789abcdef0123456789abcdef'), mtime: '20261114091500', version: 1 },
    },
    faults: {},
  };
}

async function withFtp(state, callback) {
  const server = await createFtpServer(state);
  try {
    return await callback(server);
  } finally {
    await server.close();
  }
}

test('HTTP 外壳健康检查与 FTP 欢迎语仍可用', () =>
  withSource(async (source) => {
    const response = await fetch(`${source.url}/health`);
    assert.equal((await response.json()).status, 'ok');
    const { readBanner } = await import('../src/ftp-server.mjs');
    assert.match(await readBanner(source.state.endpoint), /^220 /);
  }));

test('未知路径与坏控制请求明确拒绝', () =>
  withSource(async (source) => {
    const missing = await fetch(`${source.url}/missing`);
    assert.equal(missing.status, 404);
    const invalid = await fetch(`${source.url}/control`, { method: 'POST', body: 'not-json' });
    assert.equal(invalid.status, 400);
  }));

test('inspect 通过 FTP 控制通道读取 SIZE/MDTM 元数据', () =>
  withFtp(demoState(), async (server) => {
    const inventory = await inspect(server.endpoint, ['observe.txt', 'missing.txt']);
    assert.equal(inventory['observe.txt'].size, Buffer.byteLength('站点A,21.4\n站点B,19.8\n'));
    assert.match(inventory['observe.txt'].mtime, /^20261114090000$/);
    assert.match(inventory['missing.txt'].error, /550/);
  }));

test('文本表示：CRLF 网络字节与 LF 规范内容分别留存，SIZE 不套用', () =>
  withFtp(demoState(), async (server) => {
    const root = await workspace();
    const collector = new Collector({ workspace: root, endpoint: server.endpoint, pinHosts: ['127.0.0.1'] });
    const receipt = await collector.claim('observe.txt', { representation: 'A' });
    assert.equal(receipt.status, 'succeeded');
    const raw = await readFile(receipt.received.rawPath);
    const canonical = await readFile(join(root, 'inbox', 'observe.txt'));
    assert.ok(raw.includes(Buffer.from('\r\n')), '网络表示必须保留 CRLF 事实');
    assert.ok(!canonical.includes(Buffer.from('\r\n')), '规范内容折回 LF');
    assert.equal(canonical.toString('utf8'), '站点A,21.4\n站点B,19.8\n');
    assert.ok(raw.length > canonical.length, '文本转换前后字节本来就不同');
    assert.match(receipt.verification.join('\n'), /不套用于转换产物/);
    assert.deepEqual(canonicalizeText(raw), canonical);
  }));

test('二进制表示：无转换，接收长度与服务器 SIZE 直接核对', () =>
  withFtp(demoState(), async (server) => {
    const root = await workspace();
    const collector = new Collector({ workspace: root, endpoint: server.endpoint, pinHosts: ['127.0.0.1'] });
    const expected = sha256(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
    const receipt = await collector.claim('observe.bin', { representation: 'I', expectedSha256: expected });
    assert.equal(receipt.status, 'succeeded');
    const inbox = await readFile(join(root, 'inbox', 'observe.bin'));
    assert.deepEqual([...inbox], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  }));

test('最终失败不被下一次领取吞掉，且失败版本不进 inbox', async () => {
  const state = demoState();
  await withFtp(state, async (server) => {
    const root = await workspace();
    const collector = new Collector({ workspace: root, endpoint: server.endpoint, pinHosts: ['127.0.0.1'] });
    state.faults['observe.bin'] = { finalFail: true };
    const failed = await collector.claim('observe.bin', { representation: 'I' });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failure.reason, 'ftp-451');
    assert.deepEqual(await collector.listInbox(), []);
    assert.match(failed.received.note, /未进入目录/);
    // 收件确认与隔离字节都在。
    const receipts = await readdir(join(root, 'receipts'));
    const quarantined = await readdir(join(root, 'staging', 'quarantine'));
    assert.equal(receipts.length, 1);
    assert.equal(quarantined.length, 1);

    state.faults['observe.bin'] = {};
    const retry = await collector.claim('observe.bin', { representation: 'I' });
    assert.equal(retry.status, 'succeeded');
    assert.deepEqual(await collector.listInbox(), ['observe.bin']);
  });
});

test('晚到的最终失败属于当前命令，不会污染下一次领取', async () => {
  const state = demoState();
  await withFtp(state, async (server) => {
    const client = new FtpClient({ host: server.endpoint.host, port: server.endpoint.port, pinHosts: ['127.0.0.1'] });
    await client.connect();
    state.faults['observe.bin'] = { finalFail: true };
    await assert.rejects(() => client.retrieve('observe.bin', { representation: 'I' }), (error) => {
      assert.ok(error instanceof FtpError);
      assert.equal(error.code, 451);
      assert.equal(error.partial.dataBytes, 6);
      return true;
    });
    state.faults['observe.bin'] = {};
    const ok = await client.retrieve('observe.bin', { representation: 'I' });
    assert.equal(ok.closing.code, 226);
    await client.close();
  });
});

test('领取中文件被替换：前后元数据不一致则隔离失败，重取成功', async () => {
  const state = demoState();
  await withFtp(state, async (server) => {
    const root = await workspace();
    const collector = new Collector({ workspace: root, endpoint: server.endpoint, pinHosts: ['127.0.0.1'] });
    state.faults['observe.txt'] = { replaceAtOpen: true };
    const replaced = await collector.claim('observe.txt', { representation: 'A' });
    assert.equal(replaced.status, 'failed');
    assert.equal(replaced.failure.reason, 'source-identity-changed');
    assert.deepEqual(await collector.listInbox(), []);

    state.faults['observe.txt'] = {};
    const retry = await collector.claim('observe.txt', { representation: 'A' });
    assert.equal(retry.status, 'succeeded');
    assert.deepEqual(await collector.listInbox(), ['observe.txt']);
  });
});

test('二进制截断：登记身份绑定的续传标记，REST 续传重组完整文件', async () => {
  const state = demoState();
  await withFtp(state, async (server) => {
    const root = await workspace();
    const collector = new Collector({ workspace: root, endpoint: server.endpoint, pinHosts: ['127.0.0.1'] });
    state.faults['resume.bin'] = { cutAfterBytes: 12 };
    const cut = await collector.claim('resume.bin', { representation: 'I' });
    assert.equal(cut.status, 'failed');
    assert.equal(cut.failure.reason, 'ftp-426');
    const marker = JSON.parse(await readFile(join(root, 'state', 'resume.bin.marker.json'), 'utf8'));
    assert.equal(marker.bytesReceived, 12);
    assert.equal(marker.representation, 'I');
    assert.equal(marker.mtime, '20261114091500');

    state.faults['resume.bin'] = {};
    const resumed = await collector.claim('resume.bin', {
      representation: 'I',
      expectedSha256: sha256(Buffer.from('0123456789abcdef0123456789abcdef')),
    });
    assert.equal(resumed.status, 'succeeded');
    assert.equal(resumed.resume.resume, true);
    assert.ok(resumed.exchange.some((event) => event.direction === 'C' && event.line === 'REST 12'));
    assert.match(resumed.verification.join('\n'), /续传重组/);
    const inbox = await readFile(join(root, 'inbox', 'resume.bin'));
    assert.equal(inbox.toString('utf8'), '0123456789abcdef0123456789abcdef');
  });
});

test('文本表示截断不登记续传偏移，下一次整份重取', async () => {
  const state = demoState();
  await withFtp(state, async (server) => {
    const root = await workspace();
    const collector = new Collector({ workspace: root, endpoint: server.endpoint, pinHosts: ['127.0.0.1'] });
    state.faults['observe.txt'] = { cutAfterBytes: 8 };
    const cut = await collector.claim('observe.txt', { representation: 'A' });
    assert.equal(cut.status, 'failed');
    assert.deepEqual(await readdir(join(root, 'state')), []);
    assert.match(cut.verification.join('\n'), /文本表示不登记续传偏移/);

    state.faults['observe.txt'] = {};
    const retry = await collector.claim('observe.txt', { representation: 'A' });
    assert.equal(retry.status, 'succeeded');
    assert.equal(retry.resume.resume, false);
    assert.ok(!retry.exchange.some((event) => event.line?.startsWith('REST ')));
  });
});

test('来源身份变化后旧续传标记作废，整份重取', async () => {
  const state = demoState();
  await withFtp(state, async (server) => {
    const root = await workspace();
    const collector = new Collector({ workspace: root, endpoint: server.endpoint, pinHosts: ['127.0.0.1'] });
    state.faults['resume.bin'] = { cutAfterBytes: 10 };
    await collector.claim('resume.bin', { representation: 'I' });
    // 来源文件被替换：尺寸与修改时间都变了。
    server.mutateFile('resume.bin', Buffer.from('changed-content-payload'), { mtime: '20261114103000' });
    state.faults['resume.bin'] = {};
    const receipt = await collector.claim('resume.bin', { representation: 'I' });
    assert.equal(receipt.status, 'succeeded');
    assert.equal(receipt.resume.resume, false);
    assert.match(receipt.resume.note, /身份/);
  });
});

test('服务器拒绝 REST 时放弃偏移，整份重取并在确认中说明', async () => {
  const state = demoState();
  await withFtp(state, async (server) => {
    const root = await workspace();
    const collector = new Collector({ workspace: root, endpoint: server.endpoint, pinHosts: ['127.0.0.1'] });
    state.faults['resume.bin'] = { cutAfterBytes: 10 };
    await collector.claim('resume.bin', { representation: 'I' });
    state.faults['resume.bin'] = { restartSupported: false };
    const receipt = await collector.claim('resume.bin', { representation: 'I' });
    assert.equal(receipt.status, 'succeeded');
    assert.match(receipt.verification.join('\n'), /续传被服务器拒绝/);
    assert.match(receipt.resume.note, /整份重取/);
  });
});

test('PASV 回复指向未批准主机时拒绝建立数据连接', async () => {
  const state = demoState();
  await withFtp(state, async (server) => {
    state.pasvHost = '10,0,0,9';
    const client = new FtpClient({ host: server.endpoint.host, port: server.endpoint.port, pinHosts: ['127.0.0.1'] });
    await client.connect();
    await assert.rejects(
      () => client.retrieve('observe.bin', { representation: 'I' }),
      /不在允许清单/,
    );
    await client.close();
  });
});

test('readRaw 必须声明表示，且等待 226 最终回复才返回字节', () =>
  withFtp(demoState(), async (server) => {
    const bytes = await readRaw(server.endpoint, 'observe.txt', { representation: 'A', pinHosts: ['127.0.0.1'] });
    assert.ok(bytes.includes(Buffer.from('\r\n')));
  }));

test('续传历史片段丢失时放弃重组并判定失败，不写入不完整 inbox', async () => {
  const state = demoState();
  await withFtp(state, async (server) => {
    const root = await workspace();
    const collector = new Collector({ workspace: root, endpoint: server.endpoint, pinHosts: ['127.0.0.1'] });
    state.faults['resume.bin'] = { cutAfterBytes: 10 };
    await collector.claim('resume.bin', { representation: 'I' });
    // 模拟隔离片段被外部清理，标记仍在。
    for (const file of await readdir(join(root, 'staging', 'quarantine'))) {
      await rm(join(root, 'staging', 'quarantine', file));
    }
    state.faults['resume.bin'] = {};
    const receipt = await collector.claim('resume.bin', { representation: 'I' });
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.failure.reason, 'resume-history-missing');
    assert.deepEqual(await collector.listInbox(), []);
  });
});

test('PASV 钉扎拒绝时不发起越界数据连接，客户端仍可继续领取批准主机', async () => {
  const state = demoState();
  await withFtp(state, async (server) => {
    state.pasvHost = '10,0,0,9';
    const client = new FtpClient({ host: server.endpoint.host, port: server.endpoint.port, pinHosts: ['127.0.0.1'] });
    await client.connect();
    await assert.rejects(() => client.retrieve('observe.bin', { representation: 'I' }), /不在允许清单/);
    state.pasvHost = '127,0,0,1';
    const ok = await client.retrieve('observe.bin', { representation: 'I' });
    assert.equal(ok.closing.code, 226);
    await client.close();
  });
});
