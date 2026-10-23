// Entry point: one process serves the app files and the artist API.
// `node server/server.mjs` then open http://localhost:5173
import { mkdir } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.mjs';
import { createStore } from './store.mjs';
import { serveStatic } from './static.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const ROOT = resolve(HERE, '..');

export async function createOpenMic({ root = ROOT, dataDir, env = process.env, fetchImpl = fetch } = {}) {
  const base = dataDir || join(root, 'data');
  const audioDir = join(base, 'audio');
  await mkdir(audioDir, { recursive: true });
  const store = createStore(join(base, 'db.json'));
  const api = createApi({
    store,
    audioDir,
    agentEmail: env.OPENMIC_DMCA_EMAIL || 'dmca@openmic.invalid',
    env,
    fetchImpl,
  });
  const server = createHttpServer(async (req, res) => {
    let path;
    try {
      path = new URL(req.url, 'http://' + (req.headers.host || 'localhost')).pathname;
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Bad request');
    }
    try {
      if (path === '/api' || path.startsWith('/api/')) return await api(req, res);
      return await serveStatic({ root, pathname: path, req, res });
    } catch (error) {
      console.error('[openmic]', req.method, path, error);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('The server hit a problem.');
    }
  });
  return { server, store, api, dataDir: base, audioDir };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const port = Number(process.env.PORT) || 5173;
  // Bind to loopback unless told otherwise: an upload host on 0.0.0.0 is reachable
  // from the whole network, which nobody expects from `npm start`.
  const host = process.env.OPENMIC_HOST || '127.0.0.1';
  // Uploads and the account file can live outside the checkout, which is what a real
  // deployment wants: the git-ignored ./data is only the development default.
  const dataDir = process.env.OPENMIC_DATA_DIR ? resolve(process.env.OPENMIC_DATA_DIR) : undefined;
  const { server, dataDir: base } = await createOpenMic({ dataDir });
  server.listen(port, host, () => {
    console.log('OpenMic http://' + host + ':' + port);
    console.log('  files   ' + ROOT);
    console.log('  data    ' + base);
    if (!(process.env.OPENMIC_AI_KEY && process.env.OPENMIC_AI_MODEL))
      console.log('  assistant: local rules (set OPENMIC_AI_KEY + OPENMIC_AI_MODEL for model answers)');
  });
}
