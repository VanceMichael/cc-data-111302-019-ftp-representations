import net from 'node:net';

/** 带 FTP 三位回复码的错误，调用方可以按码区分"最终失败"和协议故障。 */
export class FtpError extends Error {
  constructor(message, code = 0, reply = '') {
    super(message);
    this.name = 'FtpError';
    this.code = code;
    this.reply = reply;
  }
}

/**
 * 最小 FTP 客户端。
 *
 * 关键约束：
 * - 命令、初步回复（1xx）、数据连接上的字节流、最终回复（2xx/4xx/5xx）在一次
 *   retrieve 调用内完整关联；数据连接关闭本身不算成功，必须等控制连接上的
 *   最终 2xx 才 resolve。最终 4xx/5xx 抛出带码错误，不会被后续命令吞掉。
 * - PASV 回复里的地址只用于取端口，主机必须命中配置允许清单，防止控制回复
 *   把数据连接指到任意主机。
 * - 每个实例内部串行（一把互斥锁），晚到的失败属于当前调用。
 */
export class FtpClient {
  #socket;
  #lines = [];
  #waiters = [];
  #tail = '';
  #exchange = [];
  #tailLock = Promise.resolve();
  #closed = true;

  constructor({ host, port, user = 'local', password = 'local', pinHosts, timeoutMs = 5000 } = {}) {
    if (!host || !port) throw new FtpError('缺少 FTP 主机或端口');
    this.host = host;
    this.port = port;
    this.user = user;
    this.password = password;
    // 未显式给出允许清单时，默认只允许连接控制连接本身的主机。
    this.pinHosts = new Set(pinHosts ?? [host]);
    this.timeoutMs = timeoutMs;
  }

  /** 本次连接上的命令/回复流水，采集器写进收件确认留痕。 */
  get exchangeLog() {
    return this.#exchange.slice();
  }

  /** 把一个任务排到串行队列尾部，保证命令一条接一条。 */
  #serial(task) {
    const run = this.#tailLock.then(task, task);
    // 不让单个任务的异常炸断整条队列，只向调用方传播。
    this.#tailLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async connect() {
    return this.#serial(async () => {
      if (!this.#closed) return; // 已连接，幂等返回
      const socket = net.connect({ port: this.port, host: this.host });
      this.#socket = socket;
      this.#closed = false;
      socket.setTimeout(this.timeoutMs);
      socket.on('data', (chunk) => this.#onData(chunk));
      socket.on('timeout', () => socket.destroy(new FtpError('FTP 控制连接超时')));
      socket.on('error', (error) => this.#failAll(error));
      socket.on('close', () => {
        this.#closed = true;
        this.#failAll(new FtpError('FTP 控制连接已关闭'));
      });
      await this.#nextReply(220);
      await this.#sendOnly(`USER ${this.user}`, 331);
      await this.#sendOnly(`PASS ${this.password}`, 230);
    });
  }

  async close() {
    return this.#serial(async () => {
      if (this.#closed) return;
      try {
        await this.#sendOnly('QUIT', 221);
      } catch {
        // 关闭路径上吞掉回复异常，直接销毁套接字。
      }
      this.#socket?.destroy();
      this.#closed = true;
    });
  }

  #onData(chunk) {
    this.#tail += chunk.toString('latin1');
    let boundary;
    while ((boundary = this.#tail.indexOf('\r\n')) >= 0) {
      const line = this.#tail.slice(0, boundary);
      this.#tail = this.#tail.slice(boundary + 2);
      const code = Number(line.slice(0, 3));
      if (Number.isInteger(code) && line[3] === '-') {
        // 多行回复："ddd-" 开头，直到 "ddd " 同码结束。
        const block = [line];
        while (true) {
          const endIndex = this.#tail.indexOf('\r\n');
          if (endIndex < 0) {
            // 结束行尚未到，等下一个 data 事件。
            this.#tail = `${block.join('\r\n')}\r\n${this.#tail}`;
            return;
          }
          const next = this.#tail.slice(0, endIndex);
          this.#tail = this.#tail.slice(endIndex + 2);
          block.push(next);
          if (next.startsWith(`${code} `)) break;
        }
        this.#emit(code, block.join('\n'));
      } else {
        this.#emit(code, line);
      }
    }
  }

  #emit(code, text) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ code, text });
    else this.#lines.push({ code, text });
  }

  #failAll(error) {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter({ error });
  }

  #nextReply(expected) {
    return new Promise((resolve, reject) => {
      const take = (reply) => {
        if (reply.error) return reject(reply.error);
        if (expected !== undefined && reply.code !== expected) {
          return reject(new FtpError(`期望回复 ${expected}，实际 ${reply.code}`, reply.code, reply.text));
        }
        resolve(reply);
      };
      const queued = this.#lines.shift();
      if (queued) take(queued);
      else this.#waiters.push(take);
    });
  }

  /** 发送一条命令并等待最终回复；1xx 初步回复会被继续跳过。调用方需持锁。 */
  async #sendOnly(line, expected) {
    this.#exchange.push({ direction: 'C', line });
    this.#socket.write(`${line}\r\n`);
    let reply;
    do {
      reply = await this.#nextReply();
      this.#exchange.push({ direction: 'S', code: reply.code, line: reply.text });
    } while (reply.code >= 100 && reply.code < 200);
    if (expected !== undefined && reply.code !== expected) {
      throw new FtpError(`命令 ${line} 失败：${reply.text}`, reply.code, reply.text);
    }
    if (reply.code >= 400) {
      throw new FtpError(`命令 ${line} 被拒绝：${reply.text}`, reply.code, reply.text);
    }
    return reply;
  }

  /** 对外命令接口，自动进入串行队列。 */
  async command(line, expected) {
    return this.#serial(() => this.#sendOnly(line, expected));
  }

  #parsePasv(reply) {
    const match = reply.text.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
    if (!match) throw new FtpError(`无法解析 PASV 回复：${reply.text}`, reply.code, reply.text);
    const [, a, b, c, d, hi, lo] = match.map(Number);
    return { host: `${a}.${b}.${c}.${d}`, port: hi * 256 + lo };
  }

  /**
   * 元数据探测。SIZE 是服务器存储字节数；文本表示经过转换后本地字节不同，
   * 因此该尺寸只能用于二进制表示的核对，不能无条件套到本地转换产物。
   */
  async inspect(remotePath) {
    return this.#serial(async () => {
      const sizeReply = await this.#sendOnly(`SIZE ${remotePath}`);
      const mdtmReply = await this.#sendOnly(`MDTM ${remotePath}`);
      const size = Number(sizeReply.text.replace(/^213\s+/, ''));
      const mtime = mdtmReply.text.replace(/^213\s+/, '').trim();
      if (!Number.isInteger(size)) {
        throw new FtpError(`无法解析 SIZE 回复：${sizeReply.text}`, sizeReply.code, sizeReply.text);
      }
      return { remotePath, size, mtime };
    });
  }

  async setType(representation) {
    if (!['A', 'I'].includes(representation)) {
      throw new FtpError(`不支持的传输表示：${representation}`);
    }
    return this.#serial(() => this.#sendOnly(`TYPE ${representation}`, 200));
  }

  /**
   * 领取一份文件，返回原始接收事实。
   *
   * @returns {Promise<{representation, offset, bytes, opening, closing, dataBytes}>}
   * 只有控制连接上的最终 2xx 到达才 resolve；数据提前关闭/最终 4xx 都抛 FtpError。
   */
  async retrieve(remotePath, { representation = 'I', offset = 0 } = {}) {
    return this.#serial(() => this.#retrieve(remotePath, representation, offset));
  }

  async #retrieve(remotePath, representation, offset) {
    await this.#sendOnly(`TYPE ${representation}`, 200);
    if (offset > 0) {
      if (representation !== 'I') {
        throw new FtpError('文本表示不能提供续传偏移：转换后的位置不等于服务器存储位置');
      }
      const rest = await this.#sendOnly(`REST ${offset}`);
      if (rest.code !== 350) throw new FtpError(`续传被拒绝：${rest.text}`, rest.code, rest.text);
    }

    const pasv = await this.#sendOnly('PASV');
    const endpoint = this.#parsePasv(pasv);
    if (!this.pinHosts.has(endpoint.host)) {
      // 未批准端点：绝不发起连接；若平台已预建套接字则立即销毁，避免泄漏。
      throw new FtpError(
        `PASV 数据端点 ${endpoint.host}:${endpoint.port} 不在允许清单 [${[...this.pinHosts].join(', ')}] 内，拒绝连接`,
        0,
        pasv.text,
      );
    }

    // 先建立数据连接，再发 RETR，避免服务器先 150 后无人接收。
    const data = await new Promise((resolve, reject) => {
      const socket = net.connect({ port: endpoint.port, host: endpoint.host });
      socket.setTimeout(this.timeoutMs, () => socket.destroy(new FtpError('FTP 数据连接超时')));
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        socket.on('error', () => {});
        resolve(socket);
      });
    });

    const chunks = [];
    let dataBytes = 0;
    let dataError;
    data.on('data', (chunk) => {
      chunks.push(chunk);
      dataBytes += chunk.length;
    });
    data.on('error', (error) => {
      dataError = error;
    });
    const dataEnded = new Promise((resolve) => data.once('end', resolve));
    const dataClosed = new Promise((resolve) => data.once('close', resolve));

    const partialTransfer = (cause) => {
      const error = cause instanceof FtpError ? cause : new FtpError(String(cause?.message ?? cause));
      // 已收字节随错误带出，失败不等于"什么都没收到"，采集器要留存这些事实。
      error.partial = {
        representation,
        offset,
        bytes: Buffer.concat(chunks),
        dataBytes,
        opening,
      };
      return error;
    };

    this.#exchange.push({ direction: 'C', line: `RETR ${remotePath}` });
    this.#socket.write(`RETR ${remotePath}\r\n`);
    let opening;
    try {
      opening = await this.#nextReply(150);
    } catch (error) {
      data.destroy();
      throw partialTransfer(error);
    }
    this.#exchange.push({ direction: 'S', code: opening.code, line: opening.text });

    await dataEnded;
    await dataClosed;
    // 关键：数据连接关闭不是成功，继续等待控制连接上的最终状态回复。
    let closing;
    try {
      closing = await this.#nextReply();
    } catch (error) {
      throw partialTransfer(error);
    }
    this.#exchange.push({ direction: 'S', code: closing.code, line: closing.text });

    if (dataError) throw partialTransfer(new FtpError(`数据连接故障：${dataError.message}`));
    if (closing.code !== 226) {
      // 数据已收完但最终回复失败：字节是事实，但不是成功的领取。
      throw partialTransfer(
        new FtpError(`数据已传输但服务器最终回复失败：${closing.text}`, closing.code, closing.text),
      );
    }

    return {
      representation,
      offset,
      bytes: Buffer.concat(chunks),
      dataBytes,
      opening: { code: opening.code, text: opening.text },
      closing: { code: closing.code, text: closing.text },
    };
  }
}
