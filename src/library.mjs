// The offline library: recordings kept on this device so a song heard once can be heard
// again with no network at all. Only rows whose bytes actually reach this browser can be
// kept - openly licensed catalogs and the artist uploads this server hosts. Spotify and
// YouTube play inside the provider's own frame, Apple hands over a short clip from Apple's
// server, and radio is a live broadcast, so there is nothing here to store for them.
import { safeHttp } from './providers.mjs';

export const OFFLINE_KINDS = Object.freeze(['audius', 'openverse', 'commons', 'community']);
export const DEFAULT_CAP_BYTES = 512 * 1024 * 1024;
// One track gets at most this much of the cap, so a single lossless album rip cannot
// quietly evict everything the listener saved before it.
export const MAX_TRACK_BYTES = 100 * 1024 * 1024;

const DB_NAME = 'openmic-offline';
const DB_VERSION = 1;
const META = 'meta';   // small rows, read on every start
const FILES = 'files'; // the audio blobs, only read when a track plays

// A saved row is later replayed from disk, so its address is re-checked here instead of
// trusting what was written once. Same-origin stream paths are fine; anything else has to
// pass the provider URL rules.
export function cacheableSource(source) {
  const raw = String(source || '');
  if (raw.startsWith('/api/stream/')) return raw;
  return safeHttp(raw);
}

export function canCache(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.live === true) return false;
  if (!OFFLINE_KINDS.includes(item.kind)) return false;
  return Boolean(cacheableSource(item.source));
}

export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return (unit === 0 ? Math.round(size) : size.toFixed(size >= 100 ? 0 : 1)) + ' ' + units[unit];
}

function score(entry) {
  return Math.max(Number(entry?.savedAt) || 0, Number(entry?.lastPlayed) || 0);
}

// Least-recently-used eviction: the listener keeps what they still listen to, and the
// oldest silent copy goes first. Protected keys (the track being saved, the one playing)
// are never chosen, and if the room cannot be made without them the save is refused
// rather than silently deleting something the user asked to keep.
export function planEviction(entries, incoming, cap = DEFAULT_CAP_BYTES, protect = []) {
  const list = Array.isArray(entries) ? entries.filter(e => e && typeof e.key === 'string') : [];
  const wanted = Math.max(0, Math.round(Number(incoming) || 0));
  const limit = Math.max(0, Math.round(Number(cap) || 0));
  if (!wanted) return { ok: false, reason: 'empty', drop: [], used: 0, needed: wanted };
  if (wanted > limit) return { ok: false, reason: 'too-big', drop: [], used: 0, needed: wanted };
  const keeper = new Set(protect);
  const used = list.reduce((sum, e) => sum + (Number(e.bytes) || 0), 0);
  if (used + wanted <= limit) return { ok: true, reason: '', drop: [], used, needed: wanted };
  const candidates = list.filter(e => !keeper.has(e.key)).sort((a, b) => score(a) - score(b));
  const drop = [];
  let free = used;
  for (const entry of candidates) {
    if (free + wanted <= limit) break;
    drop.push(entry.key);
    free -= Number(entry.bytes) || 0;
  }
  if (free + wanted > limit) return { ok: false, reason: 'full', drop: [], used, needed: wanted };
  return { ok: true, reason: '', drop, used, needed: wanted };
}

// A record is written only after the fetch has been checked, so nothing but a real audio
// blob reaches disk. `track` is the row the app already rebuilt through its own reviver.
export function buildRecord(track, blob) {
  const bytes = Number(blob?.size);
  if (!canCache(track) || !Number.isFinite(bytes) || bytes <= 0) return null;
  return {
    key: String(track.id),
    bytes,
    mime: String(blob.type || '').slice(0, 60),
    savedAt: Date.now(),
    lastPlayed: 0,
    item: {
      id: track.id, title: track.title, artist: track.artist, source: track.source,
      page: track.page, license: track.license, kind: track.kind, duration: track.duration || 0,
    },
  };
}

export async function fetchAudio(track, fetchImpl = fetch) {
  // Checked as a whole row, not just a URL: an embed or live row must never reach the
  // network for bytes it is not allowed to keep.
  if (!canCache(track)) throw new Error('This recording cannot be saved offline.');
  const url = cacheableSource(track.source);
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error('The source sent back ' + response.status + '.');
  const type = String(response.headers?.get?.('content-type') || '');
  // A captive portal or a dead stream answers 200 with an HTML page; storing that would
  // fill the library with a file that can never play.
  if (/text\/html/i.test(type)) throw new Error('That source did not return audio.');
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > MAX_TRACK_BYTES) throw new Error('This recording is too large to keep offline.');
  const blob = await response.blob();
  if (!blob?.size) throw new Error('That recording came back empty.');
  if (blob.size > MAX_TRACK_BYTES) throw new Error('This recording is too large to keep offline.');
  return blob;
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transaction(db, stores, mode, run) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    run(tx);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Two stores, not one: the app lists the library on every start, and a single store that
// kept the blob beside the row dragged every recording back into memory for that list.
export async function openLibrary(indexedDBImpl = globalThis.indexedDB) {
  if (!indexedDBImpl) throw new Error('This browser has no storage for offline copies.');
  const request = indexedDBImpl.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
    if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: 'key' });
  };
  return wrap(request);
}

export async function listSaved(db) {
  if (!db) return [];
  return (await wrap(db.transaction(META).objectStore(META).getAll()))
    .filter(row => row && typeof row.key === 'string')
    .sort((a, b) => score(b) - score(a));
}

export async function saveSaved(db, record) {
  const { blob, ...meta } = record;
  await transaction(db, [META, FILES], 'readwrite', tx => {
    tx.objectStore(META).put(meta);
    tx.objectStore(FILES).put({ key: record.key, blob });
  });
  return record.key;
}

export async function readSavedAudio(db, key) {
  if (!db) return null;
  const row = await wrap(db.transaction(FILES).objectStore(FILES).get(String(key)));
  return row?.blob || null;
}

export async function touchSaved(db, key, when = Date.now()) {
  if (!db) return;
  const row = await wrap(db.transaction(META).objectStore(META).get(String(key)));
  if (!row) return;
  row.lastPlayed = when;
  await transaction(db, [META], 'readwrite', tx => tx.objectStore(META).put(row));
}

export async function dropSaved(db, keys) {
  const list = (Array.isArray(keys) ? keys : [keys]).map(String);
  if (!db || !list.length) return [];
  await transaction(db, [META, FILES], 'readwrite', tx => {
    for (const key of list) {
      tx.objectStore(META).delete(key);
      tx.objectStore(FILES).delete(key);
    }
  });
  return list;
}

// Browsers evict ordinary storage under pressure, which would quietly undo the whole
// point, so the app asks for persisted storage before it writes the first copy.
export async function requestPersistence(storage = globalThis.navigator?.storage) {
  if (!storage?.persist) return false;
  try {
    if (await storage.persisted()) return true;
    return (await storage.persist()) === true;
  } catch {
    return false;
  }
}

// Three screens draw rows and only this module knows what is on disk, so every control is
// rendered once with both states inside it and CSS shows whichever the row has. The id and
// title arrive already escaped from each screen.
export function offlineCell(id, title) {
  return '<button class="icon-button row-offline" type="button" data-action="offline" data-id="' + id +
    '" title="Save offline - plays with no internet" aria-label="Save ' + title + ' for offline listening">' +
    '<svg class="ic-save" aria-hidden="true"><use href="#i-download"/></svg>' +
    '<svg class="ic-done" aria-hidden="true"><use href="#i-check"/></svg></button>';
}

// Community rows already spend their last slot on the rights report, so the save control
// sits under the credit the way an Apple row's full-listen control does.
export function offlinePill(id) {
  return '<button class="row-full row-offline" type="button" data-action="offline" data-id="' + id +
    '" title="Keep this recording on this device"><span class="off-save">Save offline</span>' +
    '<span class="off-saved">Offline copy saved · tap to remove</span></button>';
}
