import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createFtpServer } from './ftp-server.mjs';

/**
 * 独立合成 FTP 来源，用于在一台机器上复现控制/数据双通道：
 *   FTP_PORT=2121 node src/ftp-cli.mjs
 *   FTP_FIXTURE=.local/fixtures.json FTP_PORT=2121 node src/ftp-cli.mjs
 *
 * 夹具 JSON：
 * {
 *   "pasvHost": "127,0,0,1",
 *   "finalDelay": 15,
 *   "files": { "observe.txt": { "content": "a\nb\n", "mtime": "20261114090000" } },
 *   "faults": { "observe.txt": { "finalFail": true } }
 * }
 * 故障字段：finalFail（最终回复失败）、replaceAtOpen（领取时替换）、
 * cutAfterBytes（数据通道截断）、restartSupported（false 时拒绝 REST）。
 */
const fixturePath = resolve(process.env.FTP_FIXTURE ?? 'fixtures/source.json');
const state = existsSync(fixturePath)
  ? JSON.parse(await readFile(fixturePath, 'utf8'))
  : {};
const host = process.env.FTP_HOST ?? '127.0.0.1';
const port = Number(process.env.FTP_PORT ?? 0);
const backend = await createFtpServer(state, { host, port });
console.log(
  JSON.stringify({
    status: 'FTP 来源就绪',
    control: `${host}:${backend.endpoint.port}`,
    files: Object.keys(state.files),
    fixture: fixturePath,
  }),
);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await backend.close();
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
