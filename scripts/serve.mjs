#!/usr/bin/env node
import { createServer } from 'node:http';
import { realpath, stat } from 'node:fs/promises';
import { createReadStream, realpathSync } from 'node:fs';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
});

function reject(response, status, message) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(message);
}

function safeRequestPath(target) {
  if (!target || /^https?:\/\//i.test(target) || target.startsWith('//')) return null;
  const rawPath = target.split(/[?#]/, 1)[0];
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.startsWith('//') || /^[a-z]:/i.test(decoded)) return null;
  const pieces = decoded.split('/');
  if (pieces.some((piece) => piece === '..' || piece === '.')) return null;
  const relative = pieces.filter(Boolean).join('/');
  if (isAbsolute(relative)) return null;
  return relative;
}

export function createStaticServer(directory) {
  // Resolve symlinks in the root itself once: on macOS the system temp dir
  // (and this Mac's WebApps checkout, if ever symlinked) makes resolve()
  // alone disagree with realpath() on served files, rejecting every request.
  const root = realpathSync(resolve(directory));
  return createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method ?? '')) return reject(response, 405, 'Method not allowed');
    const relative = safeRequestPath(request.url);
    if (relative == null) return reject(response, 403, 'Forbidden');
    let candidate = join(root, relative || 'index.html');
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) candidate = join(candidate, 'index.html');
      const resolved = await realpath(candidate);
      if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) return reject(response, 403, 'Forbidden');
      const fileInfo = await stat(resolved);
      if (!fileInfo.isFile()) return reject(response, 404, 'Not found');
      const type = TYPES[extname(resolved).toLowerCase()] ?? 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': fileInfo.size, 'Cache-Control': 'no-store' });
      if (request.method === 'HEAD') return response.end();
      createReadStream(resolved).on('error', () => {
        if (!response.headersSent) reject(response, 500, 'Server error');
        else response.destroy();
      }).pipe(response);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return reject(response, 404, 'Not found');
      return reject(response, 500, 'Server error');
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [portText, directory] = process.argv.slice(2);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !directory) {
    console.error('usage: node scripts/serve.mjs <port> <dir>');
    process.exitCode = 1;
  } else {
    const server = createStaticServer(directory);
    server.listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`));
  }
}
