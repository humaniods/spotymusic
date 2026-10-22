import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenMic } from '../server/server.mjs';
import { parseRange, pickFormat, sniffFormat, searchTracks, WARRANTY_VERSION } from '../server/api.mjs';

// A payload the sniffer accepts as MP3: an ID3 header is enough for the server, and no
// codec is involved because these tests assert on transport and rights, not playback.
const MP3 = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00'), Buffer.alloc(2048, 0x20)]);

async function start(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'openmic-test-'));
  const app = await createOpenMic({ dataDir: dir, env: {}, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  return {
    ...app,
    dir,
    base,
    async close() {
      await new Promise(resolve => app.server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function call(base, path, { method = 'GET', body, cookie, headers = {}, fetchImpl = fetch } = {}) {
  const sent = body !== undefined && !(body instanceof Buffer) ? JSON.stringify(body) : body;
  const all = { 'x-openmic-request': '1', ...headers };
  if (cookie) all.cookie = cookie;
  if (body !== undefined && !all['content-type'] && !(body instanceof Buffer)) all['content-type'] = 'application/json';
  if (body instanceof Buffer && !all['content-type']) all['content-type'] = 'audio/mpeg';
  const response = await fetchImpl(base + path, { method, headers: all, body: sent });
  const text = await response.text();
  let value = null;
  try { value = JSON.parse(text); } catch { value = text; }
  return { status: response.status, value, headers: response.headers, setCookie: response.headers.getSetCookie?.() ?? [] };
}

async function signedUp(base, { email = 'ari@example.com', handle = 'ari-sound', password = 'longenough-1' } = {}) {
  const created = await call(base, '/api/signup', { method: 'POST', body: { email, password, handle, name: 'Ari' } });
  assert.equal(created.status, 201, JSON.stringify(created.value));
  return created.setCookie[0].split(';')[0];
}

test('an artist can create an account and get a session back', async () => {
  const app = await start();
  try {
    const cookie = await signedUp(app.base);
    assert.ok(cookie.startsWith('openmic_session='));
    const session = await call(app.base, '/api/session', { cookie });
    assert.equal(session.status, 200);
    assert.equal(session.value.user.handle, 'ari-sound');
    const raw = JSON.stringify(session.value);
    assert.ok(!raw.includes('salt') && !raw.includes('$s'), 'password material never leaves the server');
    const stored = JSON.stringify((await app.store.load()).users);
    assert.ok(!stored.includes('longenough-1'), 'the password is not stored in plaintext');
  } finally { await app.close(); }
});

test('signup rejects weak credentials and handle clashes', async () => {
  const app = await start();
  try {
    const weak = await call(app.base, '/api/signup', { method: 'POST', body: { email: 'a@b.co', password: 'short', handle: 'ok-handle', name: 'A' } });
    assert.equal(weak.status, 400);
    const badHandle = await call(app.base, '/api/signup', { method: 'POST', body: { email: 'a@b.co', password: 'longenough-1', handle: 'API', name: 'A' } });
    assert.equal(badHandle.status, 400, 'reserved handles are refused');
    const badEmail = await call(app.base, '/api/signup', { method: 'POST', body: { email: 'not-an-email', password: 'longenough-1', handle: 'fine-one', name: 'A' } });
    assert.equal(badEmail.status, 400);
    await signedUp(app.base);
    const clash = await call(app.base, '/api/signup', { method: 'POST', body: { email: 'ari@example.com', password: 'longenough-1', handle: 'other-handle', name: 'A' } });
    assert.equal(clash.status, 409);
    const taken = await call(app.base, '/api/signup', { method: 'POST', body: { email: 'new@example.com', password: 'longenough-1', handle: 'ari-sound', name: 'A' } });
    assert.equal(taken.status, 409);
  } finally { await app.close(); }
});

test('repeated wrong passwords are throttled', async () => {
  const app = await start();
  try {
    await signedUp(app.base);
    let last;
    for (let attempt = 0; attempt < 9; attempt++) {
      last = await call(app.base, '/api/login', { method: 'POST', body: { email: 'ari@example.com', password: 'wrong-' + attempt } });
    }
    assert.equal(last.status, 429, 'the ninth attempt is refused rather than tried');
    const good = await call(app.base, '/api/login', { method: 'POST', body: { email: 'ari@example.com', password: 'longenough-1' } });
    assert.equal(good.status, 429, 'the lockout covers the correct password too');
  } finally { await app.close(); }
});

test('a rights warranty is required before audio can be stored', async () => {
  const app = await start();
  try {
    const cookie = await signedUp(app.base);
    const noWarranty = await call(app.base, '/api/tracks', { method: 'POST', cookie, body: { title: 'Night Bus' } });
    assert.equal(noWarranty.status, 400);
    const anonymous = await call(app.base, '/api/tracks', { method: 'POST', body: { title: 'Night Bus', rightsConfirmed: true, warrantyVersion: WARRANTY_VERSION } });
    assert.equal(anonymous.status, 401, 'uploads need an account');
    const created = await call(app.base, '/api/tracks', {
      method: 'POST', cookie,
      body: { title: 'Night Bus', genre: 'lofi', rightsConfirmed: true, warrantyVersion: WARRANTY_VERSION },
    });
    assert.equal(created.status, 201);
    assert.equal(created.value.track.status, 'uploading');
    const id = created.value.track.id;
    const pendingStream = await call(app.base, '/api/stream/' + id);
    assert.equal(pendingStream.status, 404, 'an unfinished upload is not published');
    const uploaded = await call(app.base, '/api/tracks/' + id + '/audio', { method: 'PUT', cookie, body: MP3 });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.value));
    assert.equal(uploaded.value.track.status, 'published');
    assert.equal(uploaded.value.track.size, MP3.length);
    const catalog = await call(app.base, '/api/tracks');
    assert.equal(catalog.value.tracks.length, 1);
    assert.equal(catalog.value.tracks[0].title, 'Night Bus');
  } finally { await app.close(); }
});

test('audio is streamed with range support so seeking works', async () => {
  const app = await start();
  try {
    const cookie = await signedUp(app.base);
    const created = await call(app.base, '/api/tracks', {
      method: 'POST', cookie, body: { title: 'Night Bus', rightsConfirmed: true, warrantyVersion: WARRANTY_VERSION },
    });
    await call(app.base, '/api/tracks/' + created.value.track.id + '/audio', { method: 'PUT', cookie, body: MP3 });
    const path = '/api/stream/' + created.value.track.id;
    const whole = await call(app.base, path);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('content-type'), 'audio/mpeg');
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    const partial = await fetch(app.base + path, { headers: { range: 'bytes=100-199' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), 'bytes 100-199/' + MP3.length);
    assert.equal((await partial.arrayBuffer()).byteLength, 100);
    const nonsense = await fetch(app.base + path, { headers: { range: 'bytes=999999999-' } });
    assert.equal(nonsense.status, 416);
  } finally { await app.close(); }
});

test('fake audio bytes are refused before they touch the disk', async () => {
  const app = await start();
  try {
    const cookie = await signedUp(app.base);
    const created = await call(app.base, '/api/tracks', {
      method: 'POST', cookie, body: { title: 'Not Music', rightsConfirmed: true, warrantyVersion: WARRANTY_VERSION },
    });
    const id = created.value.track.id;
    const webpage = Buffer.concat([Buffer.from('<html><body>hi</body></html>'), Buffer.alloc(2048, 0x20)]);
    const wrong = await call(app.base, '/api/tracks/' + id + '/audio', { method: 'PUT', cookie, body: webpage });
    assert.equal(wrong.status, 400);
    assert.ok((await stat(app, id + '.mp3')).missing, 'nothing was written for the rejected upload');
    const wrongType = await call(app.base, '/api/tracks/' + id + '/audio', { method: 'PUT', cookie, body: MP3, headers: { 'content-type': 'text/html' } });
    assert.equal(wrongType.status, 415);
    const tooBig = await call(app.base, '/api/tracks/' + id + '/audio', {
      method: 'PUT', cookie, body: Buffer.alloc(26 * 1024 * 1024, 0x41),
    });
    assert.equal(tooBig.status, 413);
    const ok = await call(app.base, '/api/tracks/' + id + '/audio', { method: 'PUT', cookie, body: MP3 });
    assert.equal(ok.status, 201, 'a real file still lands after the failures');
    const replay = await call(app.base, '/api/tracks/' + id + '/audio', { method: 'PUT', cookie, body: MP3 });
    assert.equal(replay.status, 409, 'a published upload cannot be silently replaced');
  } finally { await app.close(); }
});

async function stat(app, name) {
  try {
    const { stat: info } = await import('node:fs/promises');
    await info(join(app.audioDir, name));
    return { missing: false };
  } catch { return { missing: true }; }
}

test('a cross-site request cannot ride an artist session', async () => {
  const app = await start();
  try {
    const cookie = await signedUp(app.base);
    const forged = await fetch(app.base + '/api/tracks', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ title: 'CSRF', rightsConfirmed: true, warrantyVersion: WARRANTY_VERSION }),
    });
    assert.equal(forged.status, 403);
    const noMarker = await fetch(app.base + '/api/profile', {
      method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ bio: 'hijacked' }),
    });
    assert.equal(noMarker.status, 403, 'mutations need the app marker header');
    const real = await call(app.base, '/api/profile', { method: 'PATCH', cookie, body: { bio: 'I record at night.' } });
    assert.equal(real.status, 200);
    assert.equal(real.value.user.bio, 'I record at night.');
  } finally { await app.close(); }
});

test('takedown disables the recording, blocks the fingerprint and escalates', async () => {
  const app = await start();
  try {
    const first = await signedUp(app.base, { email: 'one@example.com', handle: 'one-beat' });
    const second = await signedUp(app.base, { email: 'two@example.com', handle: 'two-melody' });
    const created = await call(app.base, '/api/tracks', {
      method: 'POST', cookie: first, body: { title: 'Borrowed Hook', rightsConfirmed: true, warrantyVersion: WARRANTY_VERSION },
    });
    const id = created.value.track.id;
    await call(app.base, '/api/tracks/' + id + '/audio', { method: 'PUT', cookie: first, body: MP3 });

    const sloppy = await call(app.base, '/api/takedown', { method: 'POST', body: { target: '/api/stream/' + id, email: 'lawyer@example.com', notice: 'short', goodFaith: true } });
    assert.equal(sloppy.status, 400, 'a notice needs a real description');
    const removed = await call(app.base, '/api/takedown', {
      method: 'POST',
      body: { target: 'http://localhost/#/community/' + id, email: 'lawyer@example.com',
        notice: 'This is my commercial recording, re-uploaded without any licence from me.', goodFaith: true },
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.value));
    assert.equal((await call(app.base, '/api/stream/' + id)).status, 404);
    assert.equal((await call(app.base, '/api/tracks')).value.tracks.length, 0);
    assert.ok((await stat(app, id + '.mp3')).missing, 'the audio file is deleted, not just hidden');

    // Another account cannot re-publish the identical bytes.
    const reUp = await call(app.base, '/api/tracks', {
      method: 'POST', cookie: second, body: { title: 'Same Hook', rightsConfirmed: true, warrantyVersion: WARRANTY_VERSION },
    });
    const again = await call(app.base, '/api/tracks/' + reUp.value.track.id + '/audio', { method: 'PUT', cookie: second, body: MP3 });
    assert.equal(again.status, 409);

    // Second notice against the same uploader terminates the account.
    const other = await call(app.base, '/api/tracks', {
      method: 'POST', cookie: first, body: { title: 'Another Borrowed', rightsConfirmed: true, warrantyVersion: WARRANTY_VERSION },
    });
    await call(app.base, '/api/tracks/' + other.value.track.id + '/audio', { method: 'PUT', cookie: first, body: Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00'), Buffer.alloc(2048, 0x21)]) });
    const second2 = await call(app.base, '/api/takedown', {
      method: 'POST',
      body: { target: other.value.track.id, email: 'other@example.com',
        notice: 'Another of my recordings appeared here without permission, please remove it.', goodFaith: true },
    });
    assert.equal(second2.status, 200);
    assert.equal(second2.value.terminated, true);
    assert.equal((await call(app.base, '/api/tracks')).value.tracks.length, 0, 'all uploads from a terminated account go offline');
    const login = await call(app.base, '/api/login', { method: 'POST', body: { email: 'one@example.com', password: 'longenough-1' } });
    assert.equal(login.status, 401);
    assert.equal((await call(app.base, '/api/artists/one-beat')).status, 404, 'a terminated handle stops resolving');
  } finally { await app.close(); }
});

test('public artist pages never expose the account email', async () => {
  const app = await start();
  try {
    const cookie = await signedUp(app.base);
    const created = await call(app.base, '/api/tracks', {
      method: 'POST', cookie, body: { title: 'Late Set', rightsConfirmed: true, warrantyVersion: WARRANTY_VERSION },
    });
    await call(app.base, '/api/tracks/' + created.value.track.id + '/audio', { method: 'PUT', cookie, body: MP3 });
    const page = await call(app.base, '/api/artists/ari-sound');
    assert.equal(page.status, 200);
    assert.equal(page.value.artist.handle, 'ari-sound');
    assert.equal(page.value.tracks.length, 1);
    assert.ok(!JSON.stringify(page.value).includes('example.com'));
    assert.equal((await call(app.base, '/api/artists/nobody-here')).status, 404);
  } finally { await app.close(); }
});

test('deleting your own upload leaves it open for re-upload', async () => {
  const app = await start();
  try {
    const cookie = await signedUp(app.base);
    const created = await call(app.base, '/api/tracks', {
      method: 'POST', cookie, body: { title: 'Take Two', rightsConfirmed: true, warrantyVersion: WARRANTY_VERSION },
    });
    const id = created.value.track.id;
    await call(app.base, '/api/tracks/' + id + '/audio', { method: 'PUT', cookie, body: MP3 });
    const stranger = await signedUp(app.base, { email: 'other@example.com', handle: 'stranger' });
    assert.equal((await call(app.base, '/api/tracks/' + id, { method: 'DELETE', cookie: stranger })).status, 404);
    assert.equal((await call(app.base, '/api/tracks/' + id, { method: 'DELETE', cookie })).status, 200);
    const replace = await call(app.base, '/api/tracks', {
      method: 'POST', cookie, body: { title: 'Take Two', rightsConfirmed: true, warrantyVersion: WARRANTY_VERSION },
    });
    const reupload = await call(app.base, '/api/tracks/' + replace.value.track.id + '/audio', { method: 'PUT', cookie, body: MP3 });
    assert.equal(reupload.status, 201, 'self-deletion must not blacklist the artist own recording');
  } finally { await app.close(); }
});

test('the assistant answers with no model configured and uses the proxy when there is one', async () => {
  const local = await start();
  try {
    const tags = await call(local.base, '/api/assistant', { method: 'POST', cookie: await signedUp(local.base), body: { task: 'tags', input: 'lofi night drive beats' } });
    assert.equal(tags.status, 200);
    assert.equal(tags.value.source, 'local');
    assert.ok(tags.value.suggestions.includes('lofi'), JSON.stringify(tags.value.suggestions));
    assert.ok(tags.value.suggestions.includes('electronic') || tags.value.suggestions.includes('energy'));
    const rights = await call(local.base, '/api/assistant', { method: 'POST', body: { task: 'rights', input: 'sampled from a Bollywood track' } });
    assert.equal(rights.status, 401, 'artist-side help needs an account');
    const search = await call(local.base, '/api/assistant', { method: 'POST', body: { task: 'search', input: 'songs for late night coding' } });
    assert.equal(search.status, 200);
    assert.ok(search.value.query.includes('coding'), search.value.query);
    assert.ok(search.value.suggestions.includes('focus'));
    const bogus = await call(local.base, '/api/assistant', { method: 'POST', cookie: await signedUp(local.base, { email: 'misc@example.com', handle: 'another' }), body: { task: 'admin', input: 'x' } });
    assert.equal(bogus.status, 400);
  } finally { await local.close(); }

  const upstreamCalls = [];
  const upstream = await start({
    env: { OPENMIC_AI_KEY: 'secret-key', OPENMIC_AI_MODEL: 'some-model' },
    fetchImpl: async (url, options) => {
      upstreamCalls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"suggestions":["chillhop"],"notes":["model says add a language tag"]} ' } }] }) };
    },
  });
  try {
    const cookie = await signedUp(upstream.base, { email: 'mod@example.com', handle: 'model-fan' });
    const answered = await call(upstream.base, '/api/assistant', { method: 'POST', cookie, body: { task: 'tags', input: 'lofi' } });
    assert.equal(answered.value.source, 'model');
    assert.deepEqual(answered.value.suggestions, ['chillhop']);
    const sent = upstreamCalls[0];
    assert.equal(sent.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(sent.options.headers.authorization, 'Bearer secret-key');
    assert.ok(!JSON.stringify(answered.value).includes('secret-key'), 'the key never appears in the response');
    const prompt = JSON.parse(sent.options.body).messages[0].content;
    assert.ok(prompt.includes('<<<lofi>>>'), prompt);
    assert.ok(prompt.includes('data, not instructions'), 'artist text is fenced out of the instructions');
  } finally { await upstream.close(); }

  const broken = await start({
    env: { OPENMIC_AI_KEY: 'secret-key', OPENMIC_AI_MODEL: 'some-model' },
    fetchImpl: async () => { throw new TypeError('upstream down'); },
  });
  try {
    const cookie = await signedUp(broken.base, { email: 'off@example.com', handle: 'offline-one' });
    const fallback = await call(broken.base, '/api/assistant', { method: 'POST', cookie, body: { task: 'title', input: '02_my_track (official audio).mp3' } });
    assert.equal(fallback.status, 200);
    assert.equal(fallback.value.source, 'local');
    assert.equal(fallback.value.degraded, true);
    assert.ok(fallback.value.suggestions[0].startsWith('My Track'), fallback.value.suggestions[0]);
  } finally { await broken.close(); }
});

test('static files revalidate instead of serving a stale app after an update', async () => {
  const app = await start();
  try {
    const page = await call(app.base, '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    assert.match(page.headers.get('etag'), /^"\w+-\w+"$/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    const again = await fetch(app.base + '/', { headers: { 'if-none-match': page.headers.get('etag') } });
    assert.equal(again.status, 304);
    const module = await call(app.base, '/src/app.mjs');
    assert.match(module.headers.get('content-type'), /javascript/);
    assert.equal(module.headers.get('cache-control'), 'no-cache');
    assert.equal((await call(app.base, '/src/does-not-exist.mjs')).status, 404);
  } finally { await app.close(); }
});

// A raw request keeps the traversal sequence intact; fetch would normalise the path away.
function rawGet(base, path) {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = request({ host: url.hostname, port: url.port, path, method: 'GET' }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('encoded traversal stays inside the project', async () => {
  const app = await start();
  try {
    // %2e%2e as a whole segment is normalised away by the URL parser before we see it,
    // so these attempts keep a literal %2f and only become separators in our decoder.
    for (const path of [
      '/src%2f%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/server%2f..%2f..%2f..%2fetc%2fshadow',
      '/%252e%252e/%252e%252e/etc/passwd',
      '/%00/index.html',
    ]) {
      const response = await rawGet(app.base, path);
      assert.equal(response.status, 404, path);
      assert.ok(!response.body.includes('root:'), 'no file contents leak');
    }
    const unknownStream = await call(app.base, '/api/stream/../../../../etc/passwd');
    assert.ok([400, 404].includes(unknownStream.status));
  } finally { await app.close(); }
});

test('format and range helpers decide before anything is stored', () => {
  assert.equal(pickFormat('audio/mpeg; codecs=mp4a.40.2').ext, 'mp3');
  assert.equal(pickFormat('application/octet-stream'), null);
  assert.equal(pickFormat('text/html'), null);
  assert.equal(sniffFormat('mp3', Buffer.from('ID3\x03\x00\x00')), true);
  assert.equal(sniffFormat('mp3', Buffer.from('<html>')), false);
  assert.equal(sniffFormat('wav', Buffer.from('RIFF\x00\x00\x00\x00WAVE')), true);
  assert.equal(sniffFormat('ogg', Buffer.from('RIFF\x00\x00\x00\x00WAVE')), false);
  assert.equal(sniffFormat('m4a', Buffer.from('\x00\x00\x00\x18ftypmp42')), true);
  assert.deepEqual(parseRange('bytes=0-1', 10), { start: 0, end: 1 });
  assert.equal(parseRange('bytes=-5', 10).start, 5);
  assert.deepEqual(parseRange('bytes=9-20', 10), { start: 9, end: 9 });
  assert.equal(parseRange('bytes=12-', 10), null);
  assert.equal(parseRange('bytes=abc-def', 10), null);
});

test('catalog search matches title, artist, handle and tag together', () => {
  const tracks = [
    { id: '1', status: 'published', createdAt: 3, title: 'Monsoon Lofi', artist: 'Ari', handle: 'ari-sound', genre: 'lofi', tags: ['rain'], size: 10 },
    { id: '2', status: 'published', createdAt: 2, title: 'Studio Banter', artist: 'Ari', handle: 'ari-sound', genre: 'talk', tags: [] },
    { id: '3', status: 'uploading', createdAt: 1, title: 'Not Public', artist: 'Ari', handle: 'ari-sound', genre: 'lofi', tags: [] },
  ];
  assert.deepEqual(searchTracks(tracks, { query: 'lofi monsoon' }).tracks.map(t => t.id), ['1']);
  assert.deepEqual(searchTracks(tracks, { handle: 'ari-sound' }).tracks.map(t => t.id), ['1', '2']);
  assert.deepEqual(searchTracks(tracks, { genre: 'rain' }).tracks.map(t => t.id), ['1']);
  assert.equal(searchTracks(tracks, {}).total, 2, 'unpublished audio is never counted');
  assert.deepEqual(searchTracks(tracks, { query: 'ari-sound' }).tracks.map(t => t.id), ['1', '2']);
});
