// Audius public catalog support. No paid entitlement, private API or DRM bypass.
export const AUDIUS_API = 'https://api.audius.co/v1';
const ID = /^[A-Za-z0-9_-]{2,80}$/;
const MODES = new Set(['latest', 'trending', 'search']);
export const PAGE_SIZE = 18;

export function streamUrl(providerId) {
  if (!ID.test(String(providerId))) throw new Error('Invalid Audius track ID');
  return AUDIUS_API + '/tracks/' + encodeURIComponent(providerId) + '/stream?app_name=OpenMic';
}

export function catalogUrl(options = {}) {
  const mode = MODES.has(options.mode) ? options.mode : 'latest';
  const limit = Math.min(50, Math.max(1, Number(options.limit) || PAGE_SIZE));
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
  const path = mode === 'search' ? '/tracks/search' : mode === 'trending' ? '/tracks/trending' : '/tracks/latest';
  const url = new URL(AUDIUS_API + path);
  url.searchParams.set('app_name', 'OpenMic');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  if (mode === 'trending') url.searchParams.set('time', 'week');
  if (mode === 'search') {
    const query = String(options.query || '').trim().slice(0, 100);
    if (!query) throw new Error('Search query is required');
    url.searchParams.set('query', query);
  }
  return url.toString();
}

export function toFreeTrack(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const providerId = String(raw.id || '');
  if (!ID.test(providerId)) return null;
  // Do not include tracks flagged unstreamable or paywalled by the upstream service.
  if (raw.is_streamable === false || raw.is_premium === true ||
      raw.access?.stream === false || raw.stream?.is_streamable === false ||
      raw.access?.stream === 'purchase') return null;
  const title = String(raw.title || '').trim().slice(0, 140);
  if (!title) return null;
  const artist = String(raw.user?.name || raw.user?.handle || raw.artist || 'Audius artist').slice(0, 100);
  const art = Array.from(providerId).reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 6;
  return { id: 'audius:' + providerId, providerId, title, artist,
    source: streamUrl(providerId), kind: 'audius', art };
}

export function reviveFreeTrack(saved) {
  if (!saved || typeof saved !== 'object' || typeof saved.id !== 'string' ||
      !saved.id.startsWith('audius:')) return null;
  const providerId = saved.id.slice(7);
  if (!ID.test(providerId)) return null;
  const title = String(saved.title || '').trim().slice(0, 140);
  if (!title) return null;
  return { id: 'audius:' + providerId, providerId, title,
    artist: String(saved.artist || 'Audius artist').slice(0, 100),
    source: streamUrl(providerId), kind: 'audius', art: Number.isInteger(saved.art) ? Math.abs(saved.art) % 6 : 0 };
}

export async function fetchFreeTracks(options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(catalogUrl(options), { signal: options.signal });
  if (!response.ok) throw new Error('Audius catalog returned HTTP ' + response.status);
  const payload = await response.json();
  if (!Array.isArray(payload?.data)) throw new Error('Unexpected Audius response');
  const seen = new Set();
  return payload.data.map(toFreeTrack).filter(track => {
    if (!track || seen.has(track.id)) return false;
    seen.add(track.id);
    return true;
  });
}
