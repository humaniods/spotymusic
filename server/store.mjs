// File-backed store: accounts, sessions, uploaded tracks, takedown notices.
// Deliberately dependency-free so `node server/server.mjs` runs anywhere Node 18+
// does, and so the whole data model is one readable JSON file during a review.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

const EMPTY = () => ({ users: {}, sessions: {}, tracks: {}, denied: {}, notices: [], attempts: {} });

export function createStore(file) {
  let data = EMPTY();
  let loaded = false;
  // Writes are serialised and renamed into place. Two saves landing at once would
  // otherwise be able to interleave and leave a half-written db.json behind.
  let queue = Promise.resolve();

  async function load() {
    if (loaded) return data;
    loaded = true;
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      data = { ...EMPTY(), ...parsed };
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Corrupt data store at ' + file + ': ' + error.message);
    }
    return data;
  }

  function persist() {
    const snapshot = JSON.stringify(data, null, 2);
    const tmp = file + '.' + process.pid + '.tmp';
    queue = queue.then(async () => {
      await mkdir(dirnameOf(file), { recursive: true });
      await writeFile(tmp, snapshot);
      await rename(tmp, file);
    }, () => {});
    return queue;
  }

  return {
    get data() { return data; },
    load,
    persist,
    // Read-modify-write in one call so a route cannot save a stale snapshot.
    async mutate(fn) {
      await load();
      const result = await fn(data);
      await persist();
      return result;
    },
    flush: () => queue,
  };
}

function dirnameOf(path) {
  const index = path.lastIndexOf('/');
  return index > 0 ? path.slice(0, index) : '.';
}
