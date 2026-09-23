import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createStaticHandler } from '../scripts/serve.mjs';

function fetchLocal(handler, path, method = 'GET') {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    const response = new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    response.headersSent = false;
    response.writeHead = (status, headers) => {
      response.statusCode = status;
      response.headers = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
      response.headersSent = true;
    };
    response.on('finish', () => resolvePromise({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    response.on('error', rejectPromise);
    Promise.resolve(handler({ method, url: path }, response)).catch(rejectPromise);
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
    const handler = createStaticHandler(root);
    try {
      const home = await fetchLocal(handler, '/');
      equal(home.status, 200); equal(home.headers['content-type'], 'text/html; charset=utf-8'); equal(home.headers['cache-control'], 'no-store'); equal(home.body, '<h1>ok</h1>');
      const script = await fetchLocal(handler, '/app.js');
      equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
      equal((await fetchLocal(handler, '/missing')).status, 404);
      equal((await fetchLocal(handler, '/empty/')).status, 404, 'no directory listing');
      equal((await fetchLocal(handler, '/%2e%2e/secret.txt')).status, 403, 'encoded traversal');
      equal((await fetchLocal(handler, '/escape.txt')).status, 403, 'symlink escape');
      equal((await fetchLocal(handler, '/', 'POST')).status, 405);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
