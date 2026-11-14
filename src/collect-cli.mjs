import { resolve } from 'node:path';
import { Collector } from './collector.mjs';

/**
 * 单机采集入口：
 *   FTP_HOST=127.0.0.1 FTP_PORT=2121 \
 *   FTP_WORKSPACE=.local/run FTP_FILES=observe.txt,observe.bin \
 *   FTP_TYPES=observe.txt:A,observe.bin:I node src/collect-cli.mjs
 *
 * 环境变量：
 * - FTP_HOST/FTP_PORT：控制通道（默认 127.0.0.1 / 2121）
 * - FTP_PIN：允许连接的 PASV 数据主机清单，逗号分隔，默认同 FTP_HOST
 * - FTP_WORKSPACE：留存工作区（默认 .local/collector）
 * - FTP_FILES：要领取的远程文件名，逗号分隔
 * - FTP_TYPES：按文件覆盖表示，name:A 或 name:I；默认全部 TYPE I
 * - FTP_USER/FTP_PASS/FTP_TIMEOUT_MS
 */
const env = process.env;
const endpoint = { host: env.FTP_HOST ?? '127.0.0.1', port: Number(env.FTP_PORT ?? 2121) };
const pinHosts = env.FTP_PIN ? env.FTP_PIN.split(',').map((value) => value.trim()) : [endpoint.host];
const workspace = resolve(env.FTP_WORKSPACE ?? '.local/collector');
const files = (env.FTP_FILES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
const typeOverrides = Object.fromEntries(
  (env.FTP_TYPES ?? '')
    .split(',')
    .filter(Boolean)
    .map((pair) => pair.split(':'))
    .map(([name, type]) => [name.trim(), type.trim()]),
);

if (!files.length) {
  console.error('未指定 FTP_FILES，拒绝空领取');
  process.exit(2);
}

const collector = new Collector({
  workspace,
  endpoint,
  pinHosts,
  user: env.FTP_USER,
  password: env.FTP_PASS,
  timeoutMs: Number(env.FTP_TIMEOUT_MS ?? 5000),
});

let failed = 0;
for (const name of files) {
  const representation = typeOverrides[name] ?? 'I';
  const receipt = await collector.claim(name, { representation });
  console.log(
    JSON.stringify({
      remotePath: receipt.remotePath,
      representation: receipt.representation,
      status: receipt.status,
      failure: receipt.failure,
      inboxEntry: receipt.inboxEntry,
      receiptPath: receipt.receiptPath,
    }),
  );
  if (receipt.status !== 'succeeded') failed += 1;
}
process.exitCode = failed ? 1 : 0;
