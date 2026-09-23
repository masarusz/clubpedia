import { get, request } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticServer } from '../scripts/serve.mjs';

function fetchLocal(port, path, method = 'GET') {
  return new Promise((resolvePromise, rejectPromise) => {
    const run = method === 'GET' ? get : request;
    const req = run({ hostname: '127.0.0.1', port, path, method }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolvePromise({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', rejectPromise);
    if (method !== 'GET') req.end();
  });
}

export function register(test, equal) {
  test('static preview server serves safe files and refuses traversal', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'clubpedia-server-test-'));
    const root = join(temporary, 'public');
    await mkdir(join(root, 'empty'), { recursive: true });
    await writeFile(join(root, 'index.html'), '<h1>ok</h1>');
    await writeFile(join(root, 'app.js'), 'export {};');
    await writeFile(join(temporary, 'secret.txt'), 'secret');
    await symlink(join(temporary, 'secret.txt'), join(root, 'escape.txt'));
    const server = createStaticServer(root);
    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const port = server.address().port;
    try {
      const home = await fetchLocal(port, '/');
      equal(home.status, 200); equal(home.headers['content-type'], 'text/html; charset=utf-8'); equal(home.headers['cache-control'], 'no-store'); equal(home.body, '<h1>ok</h1>');
      const script = await fetchLocal(port, '/app.js');
      equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
      equal((await fetchLocal(port, '/missing')).status, 404);
      equal((await fetchLocal(port, '/empty/')).status, 404, 'no directory listing');
      equal((await fetchLocal(port, '/%2e%2e/secret.txt')).status, 403, 'encoded traversal');
      equal((await fetchLocal(port, '/escape.txt')).status, 403, 'symlink escape');
      equal((await fetchLocal(port, '/', 'POST')).status, 405);
    } finally {
      await new Promise((resolvePromise) => server.close(resolvePromise));
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
