import test from 'node:test';
import assert from 'node:assert/strict';
import { communitySource, createCommunityApi, normalizeCommunityTrack, reviveCommunity } from '../src/community-api.mjs';

const published = {
  id: 't-abc123', title: 'Monsoon Lofi', artist: 'Ari', handle: 'ari-sound',
  genre: 'lofi', duration: 184, size: 4000000, status: 'published', createdAt: 1730000000000,
};

test('the stream URL is built from the id, never taken from the server', () => {
  assert.equal(communitySource('t-abc123'), '/api/stream/t-abc123');
  for (const bad of ['', 'a', 'x'.repeat(60), '../etc/passwd', 'javascript:alert(1)', 't abc', undefined, null, {}]) {
    assert.equal(communitySource(bad), null, String(bad));
  }
});

test('a published upload becomes a playable track and survives a reload', () => {
  const track = normalizeCommunityTrack(published);
  assert.equal(track.id, 'community:t-abc123');
  assert.equal(track.source, '/api/stream/t-abc123');
  assert.equal(track.kind, 'community');
  assert.equal(track.artist, 'Ari');
  assert.equal(track.handle, 'ari-sound');
  const revived = reviveCommunity(JSON.parse(JSON.stringify({
    id: track.id, title: track.title, artist: track.artist, source: track.source,
    page: track.page, license: track.license, kind: track.kind, provider: track.provider,
    art: track.art, handle: track.handle,
  })));
  assert.deepEqual(revived.id, track.id);
  assert.equal(revived.source, '/api/stream/t-abc123');
});

test('half-finished uploads and junk records never reach the player', () => {
  assert.equal(normalizeCommunityTrack({ ...published, status: 'uploading' }), null);
  assert.equal(normalizeCommunityTrack({ ...published, title: '   ' }), null);
  assert.equal(normalizeCommunityTrack({ ...published, id: '../../etc/passwd' }), null);
  assert.equal(normalizeCommunityTrack(null), null);
  assert.equal(reviveCommunity({ ...published, kind: 'audius' }), null);
  assert.equal(reviveCommunity({ ...published, kind: 'community', id: 'openverse:1' }), null);
});

test('a hostile handle or oversized title is clamped, not trusted', () => {
  const track = normalizeCommunityTrack({
    ...published, title: 'x'.repeat(400), artist: '<img src=x onerror=alert(1)>', handle: 'H@CKED',
  });
  assert.equal(track.title.length, 120);
  assert.equal(track.handle, '', 'a handle that is not a handle is dropped');
  // Values stay raw here on purpose - every renderer escapes at the point of output.
  assert.equal(track.artist, '<img src=x onerror=alert(1)>');
});

async function respond(status, value, kind = 'json') {
  return { ok: status >= 200 && status < 300, status, text: async () => (kind === 'json' ? JSON.stringify(value) : value) };
}

test('the client sends the CSRF marker and turns API errors into readable messages', async () => {
  const seen = [];
  const api = createCommunityApi({ fetchImpl: async (url, options) => {
    seen.push({ url, options });
    return respond(409, { error: 'That handle is taken.' });
  } });
  await assert.rejects(() => api.signup({ email: 'a@b.co', password: 'x', handle: 'ari', name: 'A' }), /That handle is taken/);
  const call = seen[0];
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers['x-openmic-request'], '1');
  assert.equal(call.options.credentials, 'same-origin');
  assert.equal(JSON.parse(call.options.body).handle, 'ari', 'handles are lowercased before they leave');
});

test('a non-JSON reply is one sentence, not a dump of the server\'s HTML', async () => {
  const html = '<!doctype html><html><head><title>Error response</title></head><body>404 Not Found</body></html>';
  const api = createCommunityApi({ fetchImpl: async () => respond(404, html, 'text/html') });
  const error = await api.list().then(() => null, err => err);
  assert.ok(error, 'a 404 must reject');
  assert.match(error.message, /No answer from the OpenMic server/);
  assert.ok(!error.message.includes('<'), 'markup never reaches the UI: ' + error.message);
  assert.equal(error.status, 404);
  const proxy = await createCommunityApi({
    fetchImpl: async () => respond(502, '<html><body>Bad Gateway</body></html>', 'text/html')
  }).list().then(() => null, err => err);
  assert.equal(proxy.message, 'The server replied with something that is not JSON (502).');
  // A short plain-text body is already a readable sentence, so it is kept.
  const plain = await createCommunityApi({
    fetchImpl: async () => respond(500, 'oops', 'text')
  }).list().then(() => null, err => err);
  assert.equal(plain.message, 'oops');
});

test('listing builds a bounded, validated query string', async () => {
  const seen = [];
  const api = createCommunityApi({ fetchImpl: async (url) => { seen.push(url); return respond(200, { tracks: [], total: 0 }); } });
  await api.list({ query: '  late night  ', handle: 'ARI-SOUND', limit: 900 });
  assert.equal(seen[0], '/api/tracks?q=late+night&handle=ari-sound&limit=50');
  await api.list({ handle: 'not a handle!' });
  assert.ok(!seen[1].includes('handle='), seen[1]);
  await assert.rejects(() => api.artist('..'), /not valid/);
  assert.equal(seen.length, 2, 'an invalid handle never hits the network');
});
