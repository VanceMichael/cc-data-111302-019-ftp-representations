import { FtpClient } from './ftp-client.mjs';

/**
 * 目录/元数据读取入口。
 *
 * 旧实现走 HTTP /inventory；现在直接通过 FTP 控制通道核对来源身份。
 * files 为要领取的文件名清单（来源目录由服务端持有，客户端不做通配列举）。
 */
export async function inspect(endpoint, files, options = {}) {
  const client = new FtpClient({ ...options, host: endpoint.host, port: endpoint.port });
  try {
    await client.connect();
    const inventory = {};
    for (const name of files) {
      try {
        inventory[name] = await client.inspect(name);
      } catch (error) {
        inventory[name] = { error: error.message, code: error.code ?? null };
      }
    }
    return inventory;
  } finally {
    await client.close().catch(() => {});
  }
}

/** 读取一次原始字节；调用方必须声明传输表示，不能把关闭当成功。 */
export async function readRaw(endpoint, path, { representation = 'I', ...options } = {}) {
  const client = new FtpClient({ ...options, host: endpoint.host, port: endpoint.port });
  try {
    await client.connect();
    const result = await client.retrieve(path, { representation });
    return result.bytes;
  } finally {
    await client.close().catch(() => {});
  }
}
