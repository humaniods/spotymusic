// Static file serving. `python3 -m http.server` sends no Cache-Control at all, which
// let browsers keep running an old app.mjs after an update - the fix is no-cache with
// an ETag, so every load revalidates but an unchanged file still costs only a 304.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
};

const REVALIDATE = new Set(['.html', '.mjs', '.js', '.css', '.json', '.webmanifest']);

export function cacheFor(extension) {
  return REVALIDATE.has(extension) ? 'no-cache' : 'public, max-age=300';
}

function etagFor(info) {
  return '"' + info.size.toString(16) + '-' + Math.trunc(info.mtimeMs).toString(16) + '"';
}

// Everything above the project root is out of bounds, so a request for /../../etc/passwd
// (whatever shape the client URL-encodes it in) can only ever resolve inside root.
export function resolveFile(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const absolute = resolve(root, '.' + (decoded === '/' ? '/index.html' : decoded));
  return absolute.startsWith(resolve(root) + '/') ? absolute : null;
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
  res.end('Not found');
}

export async function serveStatic({ root, pathname, req, res }) {
  let target = resolveFile(root, pathname);
  if (!target) return notFound(res);
  try {
    if ((await stat(target)).isDirectory()) target = resolve(target, 'index.html');
  } catch {
    return notFound(res);
  }
  let info;
  try {
    info = await stat(target);
  } catch {
    return notFound(res);
  }
  if (!info.isFile()) return notFound(res);
  const extension = extname(target).toLowerCase();
  const headers = {
    'content-type': TYPES[extension] || 'application/octet-stream',
    'cache-control': cacheFor(extension),
    etag: etagFor(info),
    'x-content-type-options': 'nosniff',
  };
  if (req.headers['if-none-match'] === headers.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  headers['content-length'] = String(info.size);
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(target).pipe(res);
}
