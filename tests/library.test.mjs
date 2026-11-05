import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OFFLINE_KINDS, canCache, cacheableSource, planEviction, buildRecord, fetchAudio,
  formatBytes, offlineCell, offlinePill, autoProtectKeys,
  MAX_TRACK_BYTES, DEFAULT_CAP_BYTES, AUTO_KEEP_MAX_BYTES
} from '../src/library.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MB = 1024 * 1024;

const row = (kind, extra = {}) => ({
  id: kind + ':track-1', kind, provider: kind, title: 'Monsoon', artist: 'Ari',
  source: 'https://cdn.example/monsoon.mp3', page: 'https://example/monsoon', license: 'CC BY 4.0',
  ...extra
});

test('only rows whose audio reaches this browser can be kept offline', () => {
  assert.deepEqual([...OFFLINE_KINDS], ['audius', 'openverse', 'commons', 'community']);
  // The four kinds whose bytes this app actually receives.
  for (const kind of OFFLINE_KINDS) assert.equal(canCache(row(kind)), true, kind);
  assert.equal(canCache(row('community', { source: '/api/stream/t-abc123' })), true);
  // Embeds play in the provider's frame, Apple hands over a clip from Apple, radio is a
  // live broadcast: keeping any of them would be a promise the app cannot keep.
  for (const kind of ['spotify', 'youtube', 'itunes', 'radio', 'demo', 'local']) {
    assert.equal(canCache(row(kind)), false, kind);
  }
  assert.equal(canCache(row('audius', { live: true })), false);
  assert.equal(canCache(null), false);
  assert.equal(canCache({}), false);
});

test('a stored row cannot aim the download at an internal or unsafe address', () => {
  assert.equal(cacheableSource('https://cdn.example/a.mp3'), 'https://cdn.example/a.mp3');
  assert.equal(cacheableSource('/api/stream/t-abc123'), '/api/stream/t-abc123');
  for (const bad of [
    'http://cdn.example/a.mp3',
    'https://127.0.0.1:5173/a.mp3',
    'https://localhost/a.mp3',
    'https://192.168.1.9/a.mp3',
    'https://printer.local/a.mp3',
    'javascript:alert(1)',
    'data:audio/mp3,AAAA',
    'file:///etc/passwd',
    '',
    undefined,
  ]) {
    assert.equal(cacheableSource(bad), null, String(bad));
  }
});

test('saving keeps the newest copies and drops what the listener stopped playing', () => {
  const old = { key: 'openverse:old', bytes: 10 * MB, savedAt: 100, lastPlayed: 200 };
  const mid = { key: 'commons:mid', bytes: 10 * MB, savedAt: 300, lastPlayed: 400 };
  const fresh = { key: 'audius:fresh', bytes: 10 * MB, savedAt: 500, lastPlayed: 900 };
  const cap = 30 * MB;

  const fits = planEviction([fresh], 5 * MB, cap);
  assert.equal(fits.ok, true);
  assert.deepEqual(fits.drop, []);

  // 5 MB into a full 30 MB library costs the one copy that has been silent longest.
  const one = planEviction([old, mid, fresh], 5 * MB, cap);
  assert.equal(one.ok, true);
  assert.deepEqual(one.drop, ['openverse:old']);

  // 20 MB needs two of them gone, and the row playing right now is never a candidate.
  const tight = planEviction([old, mid, fresh], 20 * MB, cap, ['audius:fresh']);
  assert.equal(tight.ok, true);
  assert.deepEqual(tight.drop, ['openverse:old', 'commons:mid']);

  const refused = planEviction([], 40 * MB, cap);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'too-big');
  assert.deepEqual(refused.drop, []);

  // Nothing may be dropped without touching what the listener is using, so the save is
  // refused instead of quietly deleting a recording they asked to keep.
  const stuck = planEviction([old, mid, fresh], 20 * MB, cap, ['openverse:old', 'commons:mid', 'audius:fresh']);
  assert.equal(stuck.ok, false);
  assert.equal(stuck.reason, 'full');
  assert.deepEqual(stuck.drop, []);

  assert.equal(planEviction([], 0, cap).ok, false);
  assert.equal(planEviction([{ key: 'junk' }], 5 * MB, cap).ok, true);
});

test('a silent auto-keep only ever trades away another auto-keep', () => {
  const hand = { key: 'audius:picked', bytes: 10 * MB, savedAt: 100, auto: false };
  const quiet = { key: 'openverse:heard', bytes: 10 * MB, savedAt: 200, auto: true };
  const rows = [hand, quiet];

  assert.deepEqual(autoProtectKeys(rows, 'commons:new', 'audius:picked').sort(), ['audius:picked', 'commons:new']);

  // Room for the copy nobody asked for comes from the other copy nobody asked for.
  const plan = planEviction(rows, 10 * MB, 25 * MB, autoProtectKeys(rows, 'commons:new'));
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.drop, ['openverse:heard']);

  // Only a hand-saved copy is left and there is no room: the auto-keep is refused rather
  // than paid for with something the listener pressed the arrow on.
  const full = planEviction([hand], 10 * MB, 15 * MB, autoProtectKeys([hand], 'commons:new'));
  assert.equal(full.ok, false);
  assert.equal(full.reason, 'full');
  assert.deepEqual(full.drop, []);

  assert.deepEqual(autoProtectKeys(null, undefined, undefined), []);
});

test('a record only exists once there is a real audio blob behind a keepable row', () => {
  const record = buildRecord(row('commons'), { size: 4 * MB, type: 'audio/mpeg' });
  assert.equal(record.key, 'commons:track-1');
  assert.equal(record.bytes, 4 * MB);
  assert.equal(record.mime, 'audio/mpeg');
  assert.equal(record.item.source, 'https://cdn.example/monsoon.mp3');
  assert.equal(record.lastPlayed, 0);
  assert.equal(record.auto, false);
  assert.ok(record.savedAt > 0);
  assert.equal(buildRecord(row('audius'), { size: 4 * MB }, { auto: true }).auto, true);
  assert.equal(buildRecord(row('youtube'), { size: 4 * MB }), null);
  assert.equal(buildRecord(row('audius'), { size: 0 }), null);
  assert.equal(buildRecord(row('audius'), null), null);
  assert.equal(buildRecord(null, { size: 4 * MB }), null);
});

function response({ ok = true, status = 200, type = 'audio/mpeg', length = 0, body = 'x'.repeat(2048) } = {}) {
  return {
    ok,
    status,
    headers: { get: name => (name.toLowerCase() === 'content-type' ? type : length) },
    blob: async () => ({ size: body.length, type }),
  };
}

test('the download refuses an error page, an empty body and an oversized file', async () => {
  const saved = await fetchAudio(row('openverse'), async () => response());
  assert.equal(saved.size, 2048);

  await assert.rejects(() => fetchAudio(row('openverse'), async () => response({ ok: false, status: 404 })), /404/);
  await assert.rejects(() => fetchAudio(row('openverse'), async () => response({ type: 'text/html; charset=utf-8' })), /did not return audio/);
  await assert.rejects(() => fetchAudio(row('openverse'), async () => response({ body: '' })), /came back empty/);
  await assert.rejects(
    () => fetchAudio(row('openverse'), async () => response({ length: String(MAX_TRACK_BYTES + 1) })),
    /too large/
  );
  // A row that is not keepable never reaches the network at all.
  let asked = 0;
  await assert.rejects(() => fetchAudio(row('youtube'), async () => { asked++; return response(); }), /cannot be saved/);
  assert.equal(asked, 0);

  // The background keep gets the smaller ceiling, so a recording nobody asked for cannot
  // pull a whole album across the network; the same size is fine when it is pressed on.
  const oversized = async () => response({ length: String(AUTO_KEEP_MAX_BYTES + 1) });
  await assert.rejects(() => fetchAudio(row('openverse'), oversized, AUTO_KEEP_MAX_BYTES), /too large/);
  const explicit = await fetchAudio(row('openverse'), oversized, MAX_TRACK_BYTES);
  assert.equal(explicit.size, 2048);
});

test('sizes are readable in the units a listener compares', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * MB), '5.0 MB');
  assert.equal(formatBytes(150 * MB), '150 MB');
  assert.equal(formatBytes(2 * 1024 * MB), '2.0 GB');
  assert.equal(formatBytes('nonsense'), '0 B');
});

test('the save control renders both states so no screen has to know the disk', () => {
  const cell = offlineCell('audius:a1', 'Monsoon');
  assert.match(cell, /data-action="offline"/);
  assert.match(cell, /data-id="audius:a1"/);
  assert.match(cell, /i-download/);
  assert.match(cell, /i-check/);
  assert.match(cell, /Save Monsoon for offline listening/);
  const pill = offlinePill('community:t-1');
  assert.match(pill, /Save offline/);
  assert.match(pill, /Offline copy saved/);
  assert.match(pill, /data-id="community:t-1"/);
});

test('the shell cache lists every file the app loads, and nothing that is not there', async () => {
  const worker = await readFile(resolve(ROOT, 'sw.js'), 'utf8');
  const listed = [...worker.matchAll(/'\.\/([^']+)'/g)].map(match => match[1]);
  assert.ok(listed.length > 8, 'the manifest should cover the whole shell');
  assert.ok(listed.includes('index.html'));
  for (const asset of listed) {
    try {
      await access(resolve(ROOT, asset));
    } catch {
      assert.fail(asset + ' is listed in the shell cache but missing from the repo');
    }
  }

  // Every module index.html loads, and everything those modules import, has to be cached
  // or the offline shell breaks the moment it opens.
  const html = await readFile(resolve(ROOT, 'index.html'), 'utf8');
  const entry = [...html.matchAll(/src="\.\/([^"]+)"/g)].map(match => match[1]).filter(p => p.endsWith('.mjs'));
  assert.ok(entry.length >= 3);
  const needed = new Set(entry);
  for (const file of entry) {
    const source = await readFile(resolve(ROOT, file), 'utf8');
    for (const match of source.matchAll(/from '\.\/([^']+)'/g)) needed.add(dirname(file) + '/' + match[1]);
  }
  for (const module of needed) {
    assert.ok(listed.includes(module), module + ' is imported but never cached');
  }
  assert.ok(!listed.includes('server/api.mjs'), 'the server is never shipped to a browser');
});

test('the default cap leaves a browser room to breathe', () => {
  assert.equal(DEFAULT_CAP_BYTES, 512 * MB);
  assert.equal(MAX_TRACK_BYTES, 100 * MB);
  assert.ok(MAX_TRACK_BYTES < DEFAULT_CAP_BYTES / 2);
  // Level with the server's own 25 MB upload limit, so any artist upload on this box can
  // be kept by the background save without a special case.
  assert.equal(AUTO_KEEP_MAX_BYTES, 25 * MB);
  assert.ok(AUTO_KEEP_MAX_BYTES < MAX_TRACK_BYTES);
});
