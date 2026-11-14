import net from 'node:net';

/**
 * 本地合成 FTP 来源（协议子集）。
 *
 * 双通道模型：控制连接负责命令与回复（含 150 初步回复和 226/4xx 最终回复），
 * 数据连接只承载文件字节。命令在每条控制连接上串行处理，故障注入用于在
 * 一台机器上复现：数据收完但最终失败、领取中文件被替换、数据通道中途切断、
 * PASV 回复里的任意主机等场景。
 *
 * 状态字段（可通过 state 直接修改，或经 HTTP /control 修改）：
 * - files: 文件名 -> { content: Buffer, mtime: string(YYYYMMDDHHMMSS), version: number }
 * - faults: 文件名 -> { finalFail?, replaceAtOpen?, cutAfterBytes?, restartSupported? }
 * - finalFail / replaceDuring / pasvHost / finalDelay：兼容旧单文件夹具的顶层字段
 */

const DEFAULT_PASV_HOST = '127,0,0,1';

function toBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function mtimeNow(date = new Date()) {
  return (
    String(date.getUTCFullYear()) +
    pad2(date.getUTCMonth() + 1) +
    pad2(date.getUTCDate()) +
    pad2(date.getUTCHours()) +
    pad2(date.getUTCMinutes()) +
    pad2(date.getUTCSeconds())
  );
}

function parsePasvHost(raw) {
  const parts = String(raw ?? DEFAULT_PASV_HOST).split(',').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return [127, 0, 0, 1];
  }
  return parts;
}

export function createFtpServer(state = {}, { host = '127.0.0.1', port = 0 } = {}) {
  const sockets = new Set();
  const passives = new Set();

  // 兼容旧夹具：content/version 描述单一 sample.txt。
  if (!state.files) {
    state.files = {
      'sample.txt': {
        content: toBuffer(state.content ?? 'alpha\nbeta\n'),
        mtime: `202611130000${pad2(state.version ?? 1)}`,
        version: state.version ?? 1,
      },
    };
  }
  for (const file of Object.values(state.files)) {
    file.content = toBuffer(file.content);
    file.mtime = file.mtime ?? mtimeNow();
    file.version = file.version ?? 1;
  }
  state.faults = state.faults ?? {};
  state.pasvHost = state.pasvHost ?? DEFAULT_PASV_HOST;
  state.finalDelay = state.finalDelay ?? 20;

  function faultFor(name) {
    const fault = state.faults[name] ?? {};
    return {
      finalFail: Boolean(fault.finalFail ?? (name === 'sample.txt' && state.finalFail)),
      replaceAtOpen: Boolean(fault.replaceAtOpen ?? (name === 'sample.txt' && state.replaceDuring)),
      cutAfterBytes: Number.isInteger(fault.cutAfterBytes) ? fault.cutAfterBytes : null,
      restartSupported: fault.restartSupported !== false,
    };
  }

  function mutateFile(name, content, { mtime = mtimeNow(), bumpVersion = true } = {}) {
    const file = state.files[name];
    if (!file) return false;
    file.content = toBuffer(content);
    file.mtime = mtime;
    if (bumpVersion) file.version += 1;
    if (name === 'sample.txt') {
      state.content = file.content.toString('utf8');
      state.version = file.version;
    }
    return true;
  }

  const server = net.createServer((control) => {
    sockets.add(control);
    control.on('close', () => sockets.delete(control));
    control.on('error', () => {});
    control.write('220 local synthetic archive\r\n');

    let pending = '';
    let representation = 'A';
    let offset = 0;
    let passive;
    let dataReady;
    let chain = Promise.resolve();

    async function command(line) {
      const space = line.indexOf(' ');
      const verb = (space < 0 ? line : line.slice(0, space)).toUpperCase();
      const argument = space < 0 ? '' : line.slice(space + 1).trim();

      switch (verb) {
        case 'USER':
          return control.write('331 Password required\r\n');
        case 'PASS':
          return control.write('230 Logged in\r\n');
        case 'QUIT':
          control.end('221 Goodbye\r\n');
          return;
        case 'NOOP':
          return control.write('200 Noop ok\r\n');
        case 'PWD':
          return control.write('257 "/" is current directory\r\n');
        case 'TYPE': {
          if (argument === 'A' || argument === 'I') {
            representation = argument;
            // 切换表示后，上一轮 REST 偏移不再成立。
            offset = 0;
            return control.write('200 Type set\r\n');
          }
          return control.write('504 Type unsupported\r\n');
        }
        case 'SIZE': {
          const file = state.files[argument];
          if (!file) return control.write('550 File not found\r\n');
          // SIZE 永远是服务器存储字节数，与当前 TYPE 无关。
          return control.write(`213 ${file.content.length}\r\n`);
        }
        case 'MDTM': {
          const file = state.files[argument];
          if (!file) return control.write('550 File not found\r\n');
          return control.write(`213 ${file.mtime}\r\n`);
        }
        case 'PASV': {
          if (passive) passive.close();
          passive = net.createServer();
          passives.add(passive);
          dataReady = new Promise((resolve) =>
            passive.once('connection', (socket) => {
              sockets.add(socket);
              socket.on('error', () => {});
              socket.on('close', () => sockets.delete(socket));
              resolve(socket);
            }),
          );
          await new Promise((resolve) => passive.listen(0, host, resolve));
          const port = passive.address().port;
          const advertised = parsePasvHost(state.pasvHost);
          return control.write(
            `227 Entering Passive Mode (${advertised.join(',')},${port >> 8},${port & 255})\r\n`,
          );
        }
        case 'REST': {
          const nextOffset = Number(argument);
          if (!Number.isInteger(nextOffset) || nextOffset < 0) {
            return control.write('501 Invalid restart offset\r\n');
          }
          if (representation !== 'I') {
            // 文本表示经过换行转换，服务器不接受文本模式续传偏移。
            return control.write('504 Text restart unsupported\r\n');
          }
          offset = nextOffset;
          return control.write('350 Restart set\r\n');
        }
        case 'RETR': {
          const name = argument;
          const file = state.files[name];
          if (!file) return control.write('550 File not found\r\n');
          if (!dataReady) return control.write('425 Use PASV first\r\n');
          const fault = faultFor(name);

          if (representation === 'I' && offset > 0 && !fault.restartSupported) {
            offset = 0;
            passive?.close();
            passives.delete(passive);
            passive = undefined;
            dataReady = undefined;
            return control.write('502 Restart not supported here\r\n');
          }

          // 领取身份在打开数据时确定；若配置替换故障，此刻文件身份发生变化。
          if (fault.replaceAtOpen) {
            mutateFile(name, Buffer.concat([file.content, Buffer.from('replaced-line\n', 'utf8')]));
          }

          control.write('150 Opening data connection\r\n');
          const data = await dataReady;
          const stored = state.files[name];
          let bytes = representation === 'A'
            ? Buffer.from(stored.content.toString('utf8').replace(/\n/g, '\r\n'))
            : Buffer.from(stored.content);
          bytes = bytes.subarray(offset);
          offset = 0;

          if (fault.cutAfterBytes !== null && fault.cutAfterBytes < bytes.length) {
            data.write(bytes.subarray(0, fault.cutAfterBytes));
            data.destroy();
            passive.close();
            passives.delete(passive);
            passive = undefined;
            dataReady = undefined;
            await new Promise((resolve) => setTimeout(resolve, state.finalDelay));
            return control.write('426 Connection closed; transfer aborted\r\n');
          }

          data.end(bytes);
          passive.close();
          passives.delete(passive);
          passive = undefined;
          dataReady = undefined;

          await new Promise((resolve) => setTimeout(resolve, state.finalDelay));
          // 主动的最终状态回复：即使字节已经全部送达，失败也必须显式到达。
          return control.write(fault.finalFail ? '451 Transfer failed\r\n' : '226 Transfer complete\r\n');
        }
        default:
          return control.write('502 Not implemented\r\n');
      }
    }

    control.on('data', (chunk) => {
      pending += chunk.toString('latin1');
      let boundary;
      while ((boundary = pending.indexOf('\r\n')) >= 0) {
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        chain = chain.then(() => command(line)).catch(() => control.destroy());
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const endpoint = { host, port: server.address().port };
      resolve({
        endpoint,
        mutateFile,
        close: async () => {
          for (const socket of sockets) socket.destroy();
          for (const listener of passives) listener.close();
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

/** 兼容旧入口：把 FTP 后端挂到 state 上并回填 endpoint。 */
export async function attach(state) {
  const backend = await createFtpServer(state);
  state.endpoint = backend.endpoint;
  return backend;
}

/** 只读取欢迎语，用于健康探测。 */
export async function readBanner(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint.port, endpoint.host);
    socket.setTimeout(1000, () => socket.destroy(new Error('FTP超时')));
    socket.once('data', (chunk) => {
      resolve(chunk.toString());
      socket.end();
    });
    socket.on('error', reject);
  });
}
