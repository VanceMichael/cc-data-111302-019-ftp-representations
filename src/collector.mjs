import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { FtpClient, FtpError } from './ftp-client.mjs';
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** 文本规范内容：网络上的 CRLF 统一回 LF，作为落盘与比对基准。 */
export function canonicalizeText(buffer) {
  return Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

function safeName(name) {
  return basename(name).replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * 采集器。
 *
 * 目录约定（workspace 根）：
 * - inbox/           只有完整成功的版本（规范内容）才会原子进入这里
 * - staging/raw/     每次尝试收到的原始字节（按网络表示原样留存）
 * - staging/canon/   转换后的规范内容
 * - staging/quarantine/ 失败尝试的原始字节与收件确认（不进 inbox）
 * - receipts/        每份收件确认（成功与失败都留）
 * - state/           续传标记，身份绑定（文件名+表示+前置元数据）
 */
export class Collector {
  constructor({ workspace, endpoint, pinHosts, user, password, timeoutMs } = {}) {
    if (!workspace || !endpoint) throw new Error('采集器需要 workspace 与 endpoint');
    this.workspace = workspace;
    this.endpoint = endpoint;
    this.pinHosts = pinHosts;
    this.user = user;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.dirs = {
      inbox: join(workspace, 'inbox'),
      raw: join(workspace, 'staging', 'raw'),
      canon: join(workspace, 'staging', 'canon'),
      quarantine: join(workspace, 'staging', 'quarantine'),
      receipts: join(workspace, 'receipts'),
      state: join(workspace, 'state'),
    };
  }

  async ensureLayout() {
    for (const dir of Object.values(this.dirs)) await mkdir(dir, { recursive: true });
  }

  #markerPath(remotePath) {
    return join(this.dirs.state, `${safeName(remotePath)}.marker.json`);
  }

  async #readMarker(remotePath) {
    const path = this.#markerPath(remotePath);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return null;
    }
  }

  async #writeMarker(remotePath, marker) {
    await writeFile(this.#markerPath(remotePath), `${JSON.stringify(marker, null, 2)}\n`);
  }

  async #clearMarker(remotePath) {
    await rm(this.#markerPath(remotePath), { force: true });
  }

  /**
   * 决定续传策略。表示属于领取身份：
   * - 仅二进制（TYPE I）允许把已收字节数当服务器偏移；
   * - 文本（TYPE A）经过 CRLF 转换，本地位置与服务器存储位置不可换算，
   *   旧标记一律作废，从头重取并明确说明。
   */
  #planResume({ representation, preMeta, marker }) {
    if (!marker) return { offset: 0, resume: false, note: '无历史标记，整份领取' };
    const identityMatches =
      marker.remotePath === preMeta.remotePath &&
      marker.representation === representation &&
      marker.mtime === preMeta.mtime &&
      marker.serverSize === preMeta.size;
    if (!identityMatches) {
      return { offset: 0, resume: false, note: '历史标记身份（表示/修改时间/尺寸）与当前来源不一致，废弃后整份重取' };
    }
    if (representation !== 'I') {
      return { offset: 0, resume: false, note: '文本表示的本地字节位置不能作为服务器续传偏移，整份重取' };
    }
    if (!Number.isInteger(marker.bytesReceived) || marker.bytesReceived <= 0 || marker.bytesReceived >= preMeta.size) {
      return { offset: 0, resume: false, note: '历史标记中的已收字节数无效，整份重取' };
    }
    return { offset: marker.bytesReceived, resume: true, note: `二进制身份匹配，从偏移 ${marker.bytesReceived} 续传` };
  }

  #openClient() {
    return new FtpClient({
      host: this.endpoint.host,
      port: this.endpoint.port,
      user: this.user,
      password: this.password,
      pinHosts: this.pinHosts,
      timeoutMs: this.timeoutMs,
    });
  }

  /**
   * 领取一份远程文件。
   * @param {string} remotePath 远程文件名
   * @param {{representation?: 'A'|'I', expectedSha256?: string}} options
   * @returns {Promise<object>} 收件确认
   */
  async claim(remotePath, { representation = 'I', expectedSha256 } = {}) {
    if (!['A', 'I'].includes(representation)) {
      throw new Error(`不支持的传输表示 ${representation}`);
    }
    await this.ensureLayout();
    const startedAt = new Date().toISOString();
    const attemptId = `${safeName(remotePath)}-${Date.now()}-${process.pid}`;
    const receipt = {
      remotePath,
      attemptId,
      startedAt,
      representation,
      status: 'failed',
      resume: null,
      preMeta: null,
      postMeta: null,
      received: null,
      canonical: null,
      verification: [],
      failure: null,
      exchange: [],
      inboxEntry: null,
    };

    const client = this.#openClient();
    try {
      await client.connect();

      // 领取前核对来源身份与可用元数据。
      const preMeta = await client.inspect(remotePath);
      receipt.preMeta = preMeta;

      const marker = await this.#readMarker(remotePath);
      const plan = this.#planResume({ representation, preMeta, marker });
      receipt.resume = plan;
      // 续传时保留对历史片段的引用，成功重组后才能删除隔离文件。
      const priorPartialPath = plan.resume ? marker?.partialPath : null;

      let result;
      try {
        result = await client.retrieve(remotePath, { representation, offset: plan.offset });
      } catch (error) {
        // 服务器拒绝续传（如 502/504）：不支持可靠续传时允许整份重取，并说明原因。
        if (plan.resume && error instanceof FtpError && [502, 504, 501].includes(error.code)) {
          receipt.verification.push(`续传被服务器拒绝（${error.code}），放弃偏移整份重取：${error.message}`);
          await this.#clearMarker(remotePath);
          result = await client.retrieve(remotePath, { representation, offset: 0 });
          receipt.resume = { offset: 0, resume: false, note: `${plan.note}；服务器拒绝续传后改为整份重取` };
          plan.resume = false;
        } else {
          throw error;
        }
      }
      receipt.exchange = client.exchangeLog;

      // 原始接收事实先落盘：续传时本次只拿到后半段，先按片段留存。
      const rawBuffer = result.bytes;
      const rawPath = join(this.dirs.raw, `${attemptId}.raw`);
      await writeFile(rawPath, rawBuffer);
      receipt.received = {
        dataBytes: result.dataBytes,
        offset: result.offset,
        rawSha256: sha256(rawBuffer),
        rawPath,
        opening: result.opening,
        closing: result.closing,
      };

      // 领取后再次核对身份：文件可能在领取过程中被替换。
      const postMeta = await client.inspect(remotePath);
      receipt.postMeta = postMeta;
      if (postMeta.mtime !== preMeta.mtime || postMeta.size !== preMeta.size) {
        receipt.failure = {
          reason: 'source-identity-changed',
          message: `领取前后来源身份不一致：前置 ${JSON.stringify(preMeta)} / 后置 ${JSON.stringify(postMeta)}`,
        };
      }

      // 续传重组：仅二进制。历史片段来自隔离区，偏移必须与标记一致；
      // 重组得到的完整接收字节才是核对与入目录的对象。
      let assembled = rawBuffer;
      if (plan.resume) {
        if (!priorPartialPath || !existsSync(priorPartialPath)) {
          receipt.failure ??= {
            reason: 'resume-history-missing',
            message: `续传标记指向的历史片段不存在：${priorPartialPath ?? '(空)'}，无法保证完整内容`,
          };
        } else {
          const prior = await readFile(priorPartialPath);
          if (prior.length !== plan.offset) {
            receipt.failure ??= {
              reason: 'resume-offset-mismatch',
              message: `历史片段 ${prior.length} 字节与续传偏移 ${plan.offset} 不一致，放弃重组`,
            };
          } else {
            assembled = Buffer.concat([prior, rawBuffer]);
            receipt.verification.push(
              `续传重组：历史片段 ${prior.length} B + 本次片段 ${rawBuffer.length} B = ${assembled.length} B`,
            );
          }
        }
      }

      // 表示感知的内容核对。
      let canonical;
      if (representation === 'I') {
        // 二进制：无转换，期望长度 = 服务器 SIZE（续传时核对重组后的完整字节）。
        canonical = Buffer.from(assembled);
        if (assembled.length !== postMeta.size) {
          receipt.failure ??= {
            reason: 'size-mismatch',
            message: `二进制接收字节 ${assembled.length} 与服务器尺寸 ${postMeta.size} 不一致`,
          };
        }
        receipt.verification.push(`二进制表示不做转换，完整接收 ${assembled.length} 字节，与服务器 SIZE 直接核对`);
      } else {
        // 文本不允许续传，assembled 即本次整份接收。
        // CRLF 是网络表示事实，规范内容折回 LF；列表 SIZE 不能套到转换产物。
        canonical = canonicalizeText(assembled);
        const crlfCount = (assembled.toString('latin1').match(/\r\n/g) ?? []).length;
        receipt.verification.push(
          `文本表示收到 ${assembled.length} 网络字节（含 ${crlfCount} 处 CRLF），规范为 ${canonical.length} 字节；服务器 SIZE=${postMeta.size} 是存储尺寸，不套用于转换产物`,
        );
      }

      if (expectedSha256) {
        const actual = sha256(canonical);
        if (actual !== expectedSha256) {
          receipt.failure ??= {
            reason: 'digest-mismatch',
            message: `规范内容摘要 ${actual} 与期望 ${expectedSha256} 不一致`,
          };
        } else {
          receipt.verification.push(`规范内容 SHA-256 与期望一致：${actual}`);
        }
      }

      const canonPath = join(this.dirs.canon, `${attemptId}.canonical`);
      await writeFile(canonPath, canonical);
      receipt.canonical = { bytes: canonical.length, sha256: sha256(canonical), path: canonPath };

      if (receipt.failure) {
        // 失败：隔离原始事实与确认，清除续传标记，不进入 inbox。
        const quarantineRaw = join(this.dirs.quarantine, `${attemptId}.raw`);
        await rename(rawPath, quarantineRaw);
        receipt.received.rawPath = quarantineRaw;
        // 重组失败意味着历史片段也不可再信，随标记一起清理，避免孤儿片段。
        if (plan.resume && priorPartialPath) await rm(priorPartialPath, { force: true });
        await this.#clearMarker(remotePath);
        receipt.status = 'failed';
      } else {
        // 成功：原子进入目录（同文件系统 rename），清理标记与历史片段。
        const inboxEntry = join(this.dirs.inbox, safeName(remotePath));
        const tmpEntry = `${inboxEntry}.tmp-${attemptId}`;
        await writeFile(tmpEntry, canonical);
        await rename(tmpEntry, inboxEntry);
        receipt.inboxEntry = inboxEntry;
        receipt.status = 'succeeded';
        // 无论本次是续传、续传被拒后重取还是普通重取，成功后该文件名下
        // 不再允许存在旧标记或悬空的隔离片段。
        if (marker?.partialPath) await rm(marker.partialPath, { force: true });
        if (priorPartialPath && priorPartialPath !== marker?.partialPath) {
          await rm(priorPartialPath, { force: true });
        }
        await this.#clearMarker(remotePath);
      }

      await this.#writeReceipt(attemptId, receipt, startedAt);
      return receipt;
    } catch (error) {
      // 连接级/最终回复/数据截断失败：保留已收事实，写失败确认；只有完整
      // 成功的版本才可能进入 inbox，这条路径绝不写 inbox。
      receipt.exchange = client.exchangeLog.length ? client.exchangeLog : receipt.exchange;
      receipt.failure = {
        reason: error instanceof FtpError && error.code ? `ftp-${error.code}` : 'transfer-error',
        message: error.message,
      };
      if (error.partial) {
        const { bytes, dataBytes, offset, opening } = error.partial;
        const quarantineRaw = join(this.dirs.quarantine, `${attemptId}.raw`);
        await writeFile(quarantineRaw, bytes);
        receipt.received = {
          dataBytes,
          offset,
          rawSha256: sha256(bytes),
          rawPath: quarantineRaw,
          opening,
          note: '未取得成功最终回复，原始字节隔离留存，未进入目录',
        };
        // 只有二进制且来源身份明确时，已收字节数才是可靠的服务器续传偏移。
        if (representation === 'I' && receipt.preMeta && dataBytes > 0 && offset + dataBytes < receipt.preMeta.size) {
          await this.#writeMarker(remotePath, {
            remotePath,
            representation,
            mtime: receipt.preMeta.mtime,
            serverSize: receipt.preMeta.size,
            bytesReceived: offset + dataBytes,
            partialPath: quarantineRaw,
            savedAt: new Date().toISOString(),
            note: '失败尝试后自动登记；身份绑定前置元数据，片段保留在隔离区',
          });
          receipt.verification.push(
            `已收 ${offset + dataBytes}/${receipt.preMeta.size} 字节，续传标记已登记（二进制，身份绑定前置元数据）`,
          );
        } else if (representation === 'A') {
          receipt.verification.push('文本表示不登记续传偏移：转换后的本地位置不能换算为服务器存储位置');
        }
      }
      await this.#writeReceipt(attemptId, receipt, startedAt);
      return receipt;
    } finally {
      await client.close().catch(() => {});
    }
  }

  async #writeReceipt(attemptId, receipt, startedAt) {
    receipt.endedAt = new Date().toISOString();
    receipt.durationMs = new Date(receipt.endedAt) - new Date(startedAt);
    const path = join(this.dirs.receipts, `${attemptId}.receipt.json`);
    await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`);
    receipt.receiptPath = path;
  }

  async listInbox() {
    await this.ensureLayout();
    return readdir(this.dirs.inbox);
  }
}
