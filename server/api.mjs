// OpenMic artist API: accounts, profiles, uploads, catalog, takedowns, assistant.
// Plain node:http on purpose - one process, no install step, and every route is
// readable in this file for a security review.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { aiConfigured, assist } from './ai.mjs';
import {
  HANDLE_PATTERN, SESSION_COOKIE, SESSION_TTL_MS, clipText, digestToken, emailProblem,
  handleProblem, hashPassword, newId, newToken, normalizeHandle, passwordProblem, verifyPassword,
} from './users.mjs';

export const LIMITS = {
  audioBytes: 25 * 1024 * 1024,
  userBytes: 200 * 1024 * 1024,
  userTracks: 60,
  jsonBytes: 64 * 1024,
};
export const WARRANTY_VERSION = 'openmic-rights-1';
export const WARRANTY_TEXT =
  'I own this recording or hold a licence to publish it, it contains no sampled, ripped or ' +
  're-uploaded material I am not cleared to distribute, and I accept that OpenMic removes ' +
  'infringing uploads and terminates repeat uploaders.';

const FORMATS = {
  'audio/mpeg': { ext: 'mp3', mime: 'audio/mpeg' },
  'audio/mp4': { ext: 'm4a', mime: 'audio/mp4' },
  'audio/aac': { ext: 'aac', mime: 'audio/aac' },
  'audio/x-wav': { ext: 'wav', mime: 'audio/wav' },
  'audio/wav': { ext: 'wav', mime: 'audio/wav' },
  'audio/vnd.wave': { ext: 'wav', mime: 'audio/wav' },
  'audio/ogg': { ext: 'ogg', mime: 'audio/ogg' },
  'audio/opus': { ext: 'opus', mime: 'audio/ogg' },
  'audio/flac': { ext: 'flac', mime: 'audio/flac' },
  'audio/x-flac': { ext: 'flac', mime: 'audio/flac' },
  'audio/webm': { ext: 'webm', mime: 'audio/webm' },
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TRACK_ID = /^[\w-]{4,48}$/;

export function pickFormat(mime) {
  const base = String(mime || '').split(';')[0].trim().toLowerCase();
  return FORMATS[base] || null;
}

// The declared type only has to match the bytes. Without this, an HTML or SVG payload
// named .mp3 could be served back to a victim's browser from our own origin.
export function sniffFormat(ext, buffer) {
  const head = buffer.subarray(0, 12);
  const text = (offset, length) => buffer.subarray(offset, offset + length).toString('latin1');
  const isAdts = head[0] === 0xff && (head[1] & 0xf6) === 0xf0;
  switch (ext) {
    case 'mp3': return text(0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
    case 'wav': return text(0, 4) === 'RIFF' && text(8, 4) === 'WAVE';
    case 'ogg': case 'opus': return text(0, 4) === 'OggS';
    case 'flac': return text(0, 4) === 'fLaC';
    case 'm4a': return text(4, 4) === 'ftyp';
    case 'webm': return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
    case 'aac': return text(4, 4) === 'ftyp' || isAdts;
    default: return false;
  }
}

export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') {
    const length = Number(match[2]);
    if (!Number.isFinite(length) || length < 1) return null;
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || end < start) return null;
  return { start, end };
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(value));
}
const fail = (res, status, message, extra = {}) => json(res, status, { error: message, ...extra });

async function readRaw(req, limit) {
  const chunks = [];
  let size = 0;
  let over = false;
  // Past the limit the body is drained but discarded, so the client still receives a
  // clean 413 instead of a reset connection it reports as a network failure.
  for await (const chunk of req) {
    size += chunk.length;
    if (over || size > limit) { over = true; continue; }
    chunks.push(chunk);
  }
  if (over) throw badRequest(413, 'That is larger than the upload limit.');
  return Buffer.concat(chunks, size);
}
function badRequest(status, message) {
  return Object.assign(new Error(message), { status });
}
async function readJson(req) {
  const raw = await readRaw(req, LIMITS.jsonBytes);
  if (!raw.length) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw badRequest(400, 'Send valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw badRequest(400, 'Send a JSON object.');
  return parsed;
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    try {
      out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      /* ignore a malformed cookie */
    }
  }
  return out;
}

function cookieHeader(token, { secure, maxAge }) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

// Browsers send Sec-Fetch-Site on every modern request, and a cross-site form can never
// set our marker header - together these close the session-riding CSRF hole.
function blockedByOrigin(req) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site && !['same-origin', 'same-site', 'none'].includes(site)) return true;
  return !SAFE_METHODS.has(req.method) && req.headers['x-openmic-request'] !== '1';
}

// Sliding-enough counter: reset when the window has passed, otherwise reject.
function allow(data, key, max, windowMs) {
  const now = Date.now();
  const entry = data.attempts[key];
  if (!entry || entry.until <= now) {
    data.attempts[key] = { count: 1, until: now + windowMs };
    return { ok: true, retryAfter: 0 };
  }
  entry.count++;
  if (entry.count > max) return { ok: false, retryAfter: Math.ceil((entry.until - now) / 1000) };
  return { ok: true, retryAfter: 0 };
}

export function publicTrack(track) {
  return {
    id: track.id, title: track.title, artist: track.artist, handle: track.handle,
    genre: track.genre || '', tags: track.tags || [], duration: track.duration || 0,
    size: track.size || 0, mime: track.mime || 'audio/mpeg', createdAt: track.createdAt,
    status: track.status, kind: 'community',
  };
}

export function searchTracks(tracks, { query = '', handle = '', genre = '', limit = 24, offset = 0 } = {}) {
  const terms = clipText(query, 100).toLowerCase().split(/\s+/).filter(Boolean);
  const wanted = normalizeHandle(handle);
  const style = clipText(genre, 40).toLowerCase();
  const matched = tracks.filter(track => {
    if (track.status !== 'published') return false;
    if (wanted && track.handle !== wanted) return false;
    if (style && !`${track.genre} ${(track.tags || []).join(' ')}`.toLowerCase().includes(style)) return false;
    if (!terms.length) return true;
    const haystack = `${track.title} ${track.artist} ${track.handle} ${track.genre} ${(track.tags || []).join(' ')}`.toLowerCase();
    return terms.every(term => haystack.includes(term));
  }).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1));
  const total = matched.length;
  return { tracks: matched.slice(offset, offset + Math.min(50, Math.max(1, limit))).map(publicTrack), total };
}

function profile(user) {
  return { handle: user.handle, name: user.name, bio: user.bio || '', since: user.createdAt, email: user.email };
}

export function createApi({ store, audioDir, agentEmail = 'dmca@openmic.invalid', env = process.env, fetchImpl = fetch }) {
  async function requireUser(req) {
    await store.load();
    const token = cookies(req)[SESSION_COOKIE];
    if (!token || token.length > 200) return null;
    const session = store.data.sessions[digestToken(token)];
    if (!session) return null;
    if (session.expires <= Date.now()) {
      delete store.data.sessions[digestToken(token)];
      return null;
    }
    const user = store.data.users[session.userId];
    return user && user.status !== 'terminated' ? user : null;
  }

  async function serveAudio(req, res, id) {
    await store.load();
    const track = store.data.tracks[id];
    if (!track || track.status !== 'published') return fail(res, 404, 'This recording is not available.');
    const file = join(audioDir, track.id + '.' + track.ext);
    let info;
    try {
      info = await stat(file);
    } catch {
      return fail(res, 404, 'The audio file is missing on this server.');
    }
    const headers = {
      'content-type': track.mime,
      'accept-ranges': 'bytes',
      // One id is written once and never edited in place, so a browser may keep it forever.
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-length': String(info.size),
    };
    const range = req.headers.range ? parseRange(req.headers.range, info.size) : null;
    if (req.headers.range && !range) {
      res.writeHead(416, { ...headers, 'content-range': 'bytes */' + info.size });
      return res.end();
    }
    if (range) {
      headers['content-range'] = `bytes ${range.start}-${range.end}/${info.size}`;
      headers['content-length'] = String(range.end - range.start + 1);
    }
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD') return res.end();
    createReadStream(file, range ? { start: range.start, end: range.end } : {}).pipe(res);
  }

  async function removeTrack(data, id, reason) {
    const track = data.tracks[id];
    if (!track) return null;
    const snapshot = { ...track };
    delete data.tracks[id];
    // A takedown hash is blocked from re-upload; an owner deleting their own song is not.
    if (track.sha256 && reason !== 'owner-deleted')
      data.denied[track.sha256] = { reason, at: Date.now(), trackId: id };
    await unlink(join(audioDir, track.id + '.' + track.ext)).catch(() => {});
    return snapshot;
  }

  async function applyTakedown(req, res, body) {
    const notice = clipText(body.notice, 4000);
    const target = clipText(body.target, 300);
    const email = String(body.email || '').trim().toLowerCase();
    if (body.goodFaith !== true) return fail(res, 400, 'Confirm the good-faith statement to file a notice.');
    if (notice.length < 20) return fail(res, 400, 'Describe which work you own and why this upload infringes it.');
    if (emailProblem(email)) return fail(res, 400, 'Leave an email address the uploader can contact you on.');
    // A notice can quote the page link, the stream URL, or the bare upload id.
    const id = /(?:stream|tracks?|community)\/([\w-]{4,48})/.exec(target)?.[1] ||
      (/^[\w-]{4,48}$/.test(target) ? target : '');
    const result = await store.mutate(async data => {
      const track = data.tracks[id];
      if (!track) return { missing: true };
      const user = data.users[track.userId];
      const removed = await removeTrack(data, id, 'takedown');
      const strikes = ((user?.strikes || 0) + 1);
      if (user) {
        user.strikes = strikes;
        if (strikes >= 2) {
          user.status = 'terminated';
          for (const [otherId, other] of Object.entries(data.tracks))
            if (other.userId === user.id) await removeTrack(data, otherId, 'repeat-infringer');
          for (const [token, session] of Object.entries(data.sessions))
            if (session.userId === user.id) delete data.sessions[token];
        }
      }
      data.notices.push({ at: Date.now(), target, email, notice, trackId: id, handle: track.handle,
        title: removed?.title || track.title, agent: agentEmail });
      return { track, user, strikes };
    });
    if (result.missing) return fail(res, 404, 'No upload matches that link, so there is nothing to remove.');
    return json(res, 200, {
      removed: true,
      disabled: true,
      notice: 'The recording is offline now, and its audio fingerprint is blocked from re-upload. ' +
        'The uploader can send a counter-notice to ' + agentEmail + '.',
      terminated: (result.strikes || 0) >= 2,
    });
  }

  async function route(req, res, url) {
    const path = url.pathname;
    const method = req.method;
    const user = await requireUser(req);

    if (method === 'OPTIONS') {
      res.writeHead(204, { 'allow': 'GET,HEAD,POST,PUT,PATCH,DELETE' });
      return res.end();
    }

    if (path === '/api/meta' && method === 'GET') {
      await store.load();
      return json(res, 200, {
        warranty: { version: WARRANTY_VERSION, text: WARRANTY_TEXT },
        limits: LIMITS,
        agent: agentEmail,
        tracks: Object.keys(store.data.tracks).length,
        assistant: { model: aiConfigured(env) ? env.OPENMIC_AI_MODEL : 'local rules' },
      });
    }

    if (path === '/api/signup' && method === 'POST') {
      const body = await readJson(req);
      const email = String(body.email || '').trim().toLowerCase();
      const handle = normalizeHandle(body.handle);
      const name = clipText(body.name, 60);
      const problem = emailProblem(email) || passwordProblem(body.password) || handleProblem(handle);
      if (problem) return fail(res, 400, problem);
      if (!name) return fail(res, 400, 'Tell listeners the name to display.');
      const gate = await store.mutate(data => allow(data, 'signup:' + clientIp(req), 10, 60 * 60 * 1000));
      if (!gate.ok) return fail(res, 429, 'Too many accounts created from here. Try again later.');
      const { salt, hash } = await hashPassword(body.password);
      const created = await store.mutate(data => {
        if (Object.values(data.users).some(existing => existing.email === email))
          return { error: 'An account already uses that email.' };
        if (Object.values(data.users).some(existing => existing.handle === handle))
          return { error: 'That handle is taken.' };
        const record = { id: newId('u'), email, handle, name, bio: '', salt, hash,
          createdAt: Date.now(), strikes: 0, status: 'active' };
        data.users[record.id] = record;
        return { record };
      });
      if (created.error) return fail(res, 409, created.error);
      const session = await openSession(created.record.id, isSecure(req));
      return json(res, 201, { user: profile(created.record) }, { 'set-cookie': session });
    }

    if (path === '/api/login' && method === 'POST') {
      const body = await readJson(req);
      const email = String(body.email || '').trim().toLowerCase();
      const key = 'login:' + clientIp(req) + ':' + email;
      const gate = await store.mutate(data => allow(data, key, 8, 15 * 60 * 1000));
      if (!gate.ok) return fail(res, 429, 'Too many failed attempts. Try again in ' + gate.retryAfter + 's.', { retryAfter: gate.retryAfter });
      await store.load();
      const record = Object.values(store.data.users).find(u => u.email === email);
      const ok = record && record.status !== 'terminated' &&
        await verifyPassword(String(body.password || ''), record.salt, record.hash);
      if (!ok) return fail(res, 401, 'Email or password is not right.');
      const cleared = await store.mutate(data => { delete data.attempts[key]; return data.users[record.id]; });
      const session = await openSession(cleared.id, isSecure(req));
      return json(res, 200, { user: profile(cleared) }, { 'set-cookie': session });
    }

    if (path === '/api/logout' && method === 'POST') {
      const token = cookies(req)[SESSION_COOKIE];
      if (token) await store.mutate(data => { delete data.sessions[digestToken(token)]; });
      return json(res, 200, { signedOut: true }, { 'set-cookie': cookieHeader('', { secure: isSecure(req), maxAge: 0 }) });
    }

    if (path === '/api/session' && method === 'GET') {
      if (!user) return fail(res, 401, 'Not signed in.');
      await store.load();
      const mine = Object.values(store.data.tracks).filter(track => track.userId === user.id)
        .sort((a, b) => b.createdAt - a.createdAt).map(publicTrack);
      return json(res, 200, { user: profile(user), tracks: mine, usedBytes: mine.reduce((sum, t) => sum + (t.size || 0), 0) });
    }

    if (path === '/api/profile' && method === 'PATCH') {
      if (!user) return fail(res, 401, 'Sign in to edit your profile.');
      const body = await readJson(req);
      const updated = await store.mutate(data => {
        const record = data.users[user.id];
        if (body.name !== undefined) record.name = clipText(body.name, 60) || record.name;
        if (body.bio !== undefined) record.bio = clipText(body.bio, 500);
        // Each upload remembers the display name it was published under, so without this a
        // rename would leave the Community list crediting an artist by a name they dropped.
        for (const track of Object.values(data.tracks)) {
          if (track.userId === user.id) track.artist = record.name;
        }
        return record;
      });
      return json(res, 200, { user: profile(updated) });
    }

    if (path === '/api/tracks' && method === 'GET') {
      await store.load();
      return json(res, 200, searchTracks(Object.values(store.data.tracks), {
        query: url.searchParams.get('q') || '',
        handle: url.searchParams.get('handle') || '',
        genre: url.searchParams.get('genre') || '',
        limit: Number(url.searchParams.get('limit')) || 24,
        offset: Number(url.searchParams.get('offset')) || 0,
      }));
    }

    if (path === '/api/tracks' && method === 'POST') {
      if (!user) return fail(res, 401, 'Sign in to upload your music.');
      const body = await readJson(req);
      const title = clipText(body.title, 120);
      const genre = clipText(body.genre, 40);
      const tags = (Array.isArray(body.tags) ? body.tags : []).map(tag => clipText(tag, 24)).filter(Boolean).slice(0, 8);
      const duration = Math.min(6 * 3600, Math.max(0, Number(body.duration) || 0));
      if (title.length < 1) return fail(res, 400, 'Give the recording a title.');
      if (body.rightsConfirmed !== true || body.warrantyVersion !== WARRANTY_VERSION)
        return fail(res, 400, 'Accept the rights warranty before publishing.');
      const created = await store.mutate(data => {
        const mine = Object.values(data.tracks).filter(track => track.userId === user.id);
        if (mine.length >= LIMITS.userTracks) return { error: 'This profile holds the maximum number of uploads.' };
        const used = mine.reduce((sum, track) => sum + (track.size || 0), 0);
        if (used >= LIMITS.userBytes) return { error: 'This profile has used its storage quota.' };
        const track = { id: newId('t'), userId: user.id, handle: user.handle, artist: user.name,
          title, genre, tags, duration, size: 0, status: 'uploading', createdAt: Date.now() };
        data.tracks[track.id] = track;
        return { track };
      });
      if (created.error) return fail(res, 409, created.error);
      return json(res, 201, { track: publicTrack(created.track), put: '/api/tracks/' + created.track.id + '/audio' });
    }

    const audioMatch = /^\/api\/tracks\/([\w-]{4,48})\/audio$/.exec(path);
    if (audioMatch && method === 'PUT') {
      if (!user) return fail(res, 401, 'Sign in to upload your music.');
      const id = audioMatch[1];
      if (!TRACK_ID.test(id)) return fail(res, 400, 'Unknown upload.');
      const format = pickFormat(req.headers['content-type']);
      if (!format) return fail(res, 415, 'Send MP3, WAV, OGG, OPUS, FLAC, M4A, AAC or WebM audio.');
      const raw = await readRaw(req, LIMITS.audioBytes);
      if (raw.length < 1024) return fail(res, 400, 'That file looks empty or truncated.');
      if (!sniffFormat(format.ext, raw)) return fail(res, 400, 'The file contents do not match the audio type you sent.');
      const sha256 = createHash('sha256').update(raw).digest('hex');
      const result = await store.mutate(async data => {
        const track = data.tracks[id];
        if (!track || track.userId !== user.id) return { error: 'not-yours', status: 403 };
        if (track.status !== 'uploading') return { error: 'already', status: 409 };
        if (data.denied[sha256]) return { error: 'denied', status: 409 };
        await mkdir(audioDir, { recursive: true });
        const file = join(audioDir, track.id + '.' + format.ext);
        // Same-directory temp file, then rename: a crash cannot leave a half-written
        // stream that the catalog is already pointing at.
        await writeFile(file + '.part', raw);
        await rename(file + '.part', file);
        Object.assign(track, { size: raw.length, sha256, ext: format.ext, mime: format.mime,
          status: 'published', publishedAt: Date.now() });
        return { track };
      });
      if (result.error) {
        await unlink(join(audioDir, id + '.' + format.ext) + '.part').catch(() => {});
        const message = result.error === 'denied'
          ? 'This exact recording was taken down after a rights notice, so it cannot be re-uploaded.'
          : result.error === 'already' ? 'This upload is already published.' : 'You can only fill your own pending upload.';
        return fail(res, result.status, message);
      }
      return json(res, 201, { track: publicTrack(result.track) });
    }

    const trackMatch = /^\/api\/tracks\/([\w-]{4,48})$/.exec(path);
    if (trackMatch && method === 'DELETE') {
      if (!user) return fail(res, 401, 'Sign in first.');
      const removed = await store.mutate(async data => {
        const track = data.tracks[trackMatch[1]];
        if (!track || track.userId !== user.id) return null;
        return await removeTrack(data, track.id, 'owner-deleted');
      });
      if (!removed) return fail(res, 404, 'That upload is not yours to delete.');
      return json(res, 200, { deleted: true });
    }

    if (/^\/api\/takedown/.test(path) && method === 'POST') {
      const gate = await store.mutate(data => allow(data, 'takedown:' + clientIp(req), 10, 60 * 60 * 1000));
      if (!gate.ok) return fail(res, 429, 'Too many notices from this address. Try again later.');
      return applyTakedown(req, res, await readJson(req));
    }

    if (path === '/api/assistant' && method === 'POST') {
      const body = await readJson(req);
      const task = clipText(body.task, 20);
      const gate = await store.mutate(data => allow(data, 'assistant:' + clientIp(req), user ? 60 : 20, 60 * 1000));
      if (!gate.ok) return fail(res, 429, 'The assistant is busy. Try again in ' + gate.retryAfter + 's.');
      if (task !== 'search' && !user) return fail(res, 401, 'Sign in to use the artist assistant.');
      try {
        const answer = await assist(task, body.input, { env, fetchImpl });
        return json(res, 200, { task, ...answer });
      } catch (error) {
        return fail(res, 400, error.message || 'The assistant could not help with that.');
      }
    }

    const artistMatch = /^\/api\/artists\/([a-z0-9][a-z0-9_.-]{1,29})$/i.exec(path);
    if (artistMatch && method === 'GET') {
      await store.load();
      const handle = normalizeHandle(artistMatch[1]);
      const record = Object.values(store.data.users).find(u => u.handle === handle && u.status !== 'terminated');
      if (!record) return fail(res, 404, 'No artist with that handle.');
      const { tracks, total } = searchTracks(Object.values(store.data.tracks), { handle: record.handle, limit: 50 });
      return json(res, 200, {
        artist: { handle: record.handle, name: record.name, bio: record.bio || '', since: record.createdAt },
        tracks, total,
      });
    }

    const streamMatch = /^\/api\/stream\/([\w-]{4,48})$/.exec(path);
    if (streamMatch && (method === 'GET' || method === 'HEAD')) {
      if (blockedByOrigin(req)) return fail(res, 403, 'Cross-site playback is not allowed.');
      return serveAudio(req, res, streamMatch[1]);
    }

    return fail(res, 404, 'No such OpenMic endpoint.');
  }

  async function openSession(userId, secure) {
    const token = newToken();
    await store.mutate(data => {
      const now = Date.now();
      for (const [digest, session] of Object.entries(data.sessions))
        if (session.expires <= now) delete data.sessions[digest];
      data.sessions[digestToken(token)] = { userId, createdAt: now, expires: now + SESSION_TTL_MS };
    });
    return cookieHeader(token, { secure: Boolean(secure), maxAge: Math.floor(SESSION_TTL_MS / 1000) });
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    try {
      if (!SAFE_METHODS.has(req.method) && blockedByOrigin(req))
        return fail(res, 403, 'Requests must come from the OpenMic page itself.');
      return await route(req, res, url);
    } catch (error) {
      const status = error?.status || (error?.name === 'AbortError' ? 504 : 500);
      if (status >= 500) console.error('[openmic]', error);
      if (res.headersSent) return res.end();
      return fail(res, status, status >= 500 ? 'The server hit a problem. Try again.' : error.message);
    }
  };
}

function isSecure(req) {
  return req.socket?.encrypted === true || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
