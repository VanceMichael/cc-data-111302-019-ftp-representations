import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createFtpServer } from './ftp-server.mjs';

export function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

/**
 * 本地来源生命周期：HTTP 仅作为测试/运维外壳，真正的观测表交付走 FTP
 * 控制通道 + PASV 数据通道。/control 只能修改合成来源的故障与回显字段。
 */
export async function createSource({ port = 0, host = '127.0.0.1' } = {}) {
  const state = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
  const backend = await createFtpServer(state);
  state.endpoint = backend.endpoint;

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://local.test');
      let text = '';
      for await (const chunk of request) {
        text += chunk;
        if (text.length > 8 * 1024 * 1024) return json(response, { error: '控制请求过大' }, 413);
      }
      let body = {};
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          return json(response, { error: 'JSON无效' }, 400);
        }
      }
      if (url.pathname === '/health') return json(response, { status: 'ok' });
      if (url.pathname === '/state' || url.pathname === '/inventory') return json(response, state);
      if (url.pathname === '/control' && request.method === 'POST') {
        // 仅允许白名单字段，避免 HTTP 外壳变成任意写入通道。
        for (const key of ['finalFail', 'replaceDuring', 'pasvHost', 'finalDelay', 'faults']) {
          if (Object.hasOwn(body, key)) state[key] = body[key];
        }
        if (Object.hasOwn(body, 'mutate')) {
          const { name, content, mtime } = body.mutate;
          backend.mutateFile(name, content, mtime ? { mtime } : undefined);
        }
        return json(response, state);
      }
      return json(response, { error: '资源不存在' }, 404);
    } catch (error) {
      if (!response.headersSent) json(response, { error: error.message }, 500);
      else response.destroy();
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    backend,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await backend.close();
    },
  };
}
