// Browser client for the OpenMic artist API. Pure functions and fetch only, so the
// whole thing is testable in Node without a DOM.
const TRACK_ID = /^[\w-]{4,48}$/;
const HANDLE = /^[a-z0-9][a-z0-9_.-]{1,29}$/;

function clean(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

// A plain file server answers /api/* with its own HTML error page. Dumping that markup
// into an error line tells nobody anything, so a non-JSON body becomes one sentence.
function errorText(text, status) {
  const flat = clean(text, 200);
  if (!flat || /^<[/!a-z]/i.test(flat)) {
    return status === 404
      ? 'No answer from the OpenMic server (start it with npm start).'
      : 'The server replied with something that is not JSON (' + status + ').';
  }
  return flat;
}

// The audio URL is built here from the id, never taken from the response, so a hostile
// or compromised server cannot point the player at another machine. An over-long id is
// rejected rather than truncated, because truncation can alias two different uploads.
export function communitySource(id) {
  const safe = String(id ?? '');
  return TRACK_ID.test(safe) ? '/api/stream/' + safe : null;
}

export function normalizeCommunityTrack(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.status && raw.status !== 'published') return null;
  const source = communitySource(raw.id);
  const title = clean(raw.title, 120);
  if (!source || !title) return null;
  const publicId = source.slice('/api/stream/'.length);
  const handle = clean(raw.handle, 40).toLowerCase();
  return {
    id: 'community:' + publicId,
    publicId,
    title,
    artist: clean(raw.artist, 100) || 'OpenMic artist',
    handle: HANDLE.test(handle) ? handle : '',
    genre: clean(raw.genre, 40),
    duration: Math.min(21600, Math.max(0, Number(raw.duration) || 0)),
    size: Math.max(0, Number(raw.size) || 0),
    kind: 'community',
    provider: 'community',
    source,
    page: 'https://openmic.local/#/community/' + publicId,
    license: 'Artist upload · rights warranty on file',
    createdAt: Number(raw.createdAt) || 0,
    art: 6,
  };
}

export function reviveCommunity(saved) {
  if (!saved || typeof saved !== 'object' || saved.kind !== 'community') return null;
  const id = clean(saved.id, 64);
  if (!id.startsWith('community:')) return null;
  return normalizeCommunityTrack({ ...saved, id: id.slice('community:'.length), status: 'published' });
}

export function createCommunityApi({ fetchImpl = globalThis.fetch, path = '' } = {}) {
  async function request(route, { method = 'GET', body, headers = {}, raw } = {}) {
    const all = { accept: 'application/json', ...headers };
    if (body !== undefined) all['content-type'] = 'application/json';
    if (!['GET', 'HEAD'].includes(method)) all['x-openmic-request'] = '1';
    const response = await fetchImpl(path + route, {
      method,
      credentials: 'same-origin',
      headers: all,
      body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await response.text();
    let value = null;
    try { value = text ? JSON.parse(text) : {}; } catch { value = { error: errorText(text, response.status) }; }
    if (!response.ok) throw Object.assign(new Error(clean(value.error || ('Request failed (' + response.status + ')'), 200)), { status: response.status });
    return value;
  }
  return {
    meta: () => request('/api/meta'),
    signup: input => request('/api/signup', { method: 'POST', body: {
      email: clean(input.email, 254), password: String(input.password || ''),
      handle: clean(input.handle, 40).toLowerCase(), name: clean(input.name, 60) } }),
    login: input => request('/api/login', { method: 'POST',
      body: { email: clean(input.email, 254), password: String(input.password || '') } }),
    logout: () => request('/api/logout', { method: 'POST' }),
    session: () => request('/api/session'),
    saveProfile: patch => request('/api/profile', { method: 'PATCH', body: patch }),
    list: ({ query = '', handle = '', limit = 24 } = {}) => {
      const params = new URLSearchParams();
      if (clean(query, 100)) params.set('q', clean(query, 100));
      if (HANDLE.test(clean(handle, 40).toLowerCase())) params.set('handle', clean(handle, 40).toLowerCase());
      params.set('limit', String(Math.min(50, Math.max(1, Number(limit) || 24))));
      return request('/api/tracks?' + params.toString());
    },
    // async so a bad handle rejects like a failed request instead of throwing at call time
    artist: async handle => {
      const safe = clean(handle, 40).toLowerCase();
      if (!HANDLE.test(safe)) throw new Error('That handle is not valid.');
      return request('/api/artists/' + safe);
    },
    publish: (track, file, warranty) => request('/api/tracks', { method: 'POST', body: {
      title: clean(track.title, 120), genre: clean(track.genre, 40),
      tags: (track.tags || []).slice(0, 8), duration: Math.round(Number(track.duration) || 0),
      rightsConfirmed: warranty?.rightsConfirmed === true,
      warrantyVersion: warranty?.version || '',
    }, }),
    putAudio: (id, file) => request('/api/tracks/' + encodeURIComponent(clean(id, 48)) + '/audio', {
      method: 'PUT',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      raw: file,
    }),
    remove: id => request('/api/tracks/' + encodeURIComponent(clean(id, 48)), { method: 'DELETE' }),
    takedown: notice => request('/api/takedown', { method: 'POST', body: {
      target: clean(notice.target, 300), email: clean(notice.email, 254),
      notice: clean(notice.notice, 4000), goodFaith: notice.goodFaith === true } }),
    assist: (task, input) => request('/api/assistant', { method: 'POST', body: { task: clean(task, 20), input } }),
  };
}

export const communityApi = createCommunityApi();
