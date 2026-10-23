import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * A tiny fake API so the demo can prove what the cache is doing.
 *
 * Every request costs 400 ms of artificial latency and bumps a counter, so a cached read is
 * visibly instant while a cache miss pays the full price. `/api/__stats` exposes the counter
 * to the UI.
 */
function fakeApi() {
  const todos = ['ship the wasm core', 'wire up the axios adapter', 'survive a reload'];
  let hits = 0;

  return (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const url = request.url ?? '';
    if (!url.startsWith('/api')) return next();

    const send = (status: number, body: unknown) => {
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
    };

    if (request.method === 'POST' && url === '/api/todos') {
      let raw = '';
      request.on('data', (chunk: Buffer) => {
        raw += chunk;
      });
      request.on('end', () => {
        try {
          const { text } = JSON.parse(raw || '{}') as { text?: string };
          if (text) todos.push(text);
          send(201, { ok: true });
        } catch {
          send(400, { error: 'invalid json' });
        }
      });
      return;
    }

    if (request.method === 'GET' && url === '/api/__stats') {
      send(200, { serverHits: hits });
      return;
    }

    if (request.method === 'GET' && url.startsWith('/api/todos')) {
      hits += 1;
      const serverHits = hits;
      setTimeout(() => {
        send(200, { items: [...todos], serverHits, fetchedAt: Date.now() });
      }, 400);
      return;
    }

    send(404, { error: 'not found' });
  };
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'blaze-example-mock-api',
      configureServer(server) {
        server.middlewares.use(fakeApi());
      },
    },
  ],
  optimizeDeps: {
    // The packages ship plain ESM with an explicit `?url` import for the wasm binary; leaving
    // them out of the pre-bundle keeps `import.meta.url` meaningful if you rely on the
    // zero-config default instead.
    exclude: ['@blaze-cache/core', '@blaze-cache/axios', '@blaze-cache/react-query'],
  },
  server: {
    port: 5173,
  },
});
