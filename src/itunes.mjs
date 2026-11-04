// Apple's public iTunes Search and RSS chart endpoints: no key, no account, no private
// API. Every row streams Apple's own 30-second clip from Apple's own CDN and credits
// Apple's own track page, so the full listen always belongs to Apple.
export const ITUNES_STORE = 'in';
export const ITUNES_LIMIT = 25;
export const ITUNES_LICENSE = '30-sec preview · Apple';

const TRACK_ID = /^\d{4,16}$/;
const PREVIEW_HOST = 'audio-ssl.itunes.apple.com';

function clip(value, n = 140) { return String(value ?? '').trim().slice(0, n); }
function limit(value) { return Math.min(ITUNES_LIMIT, Math.max(1, Math.floor(Number(value) || ITUNES_LIMIT))); }
// The store code reaches Apple as a path segment, so anything that is not a two-letter
// country falls back instead of restructuring the URL.
function storeCode(value) { return /^[a-z]{2}$/.test(String(value || '').toLowerCase()) ? String(value).toLowerCase() : ITUNES_STORE; }

export function itunesSearchUrl({ query = '', limit: size = ITUNES_LIMIT, store = ITUNES_STORE } = {}) {
  const term = clip(query, 100);
  if (!term) throw new Error('Search query required');
  const url = new URL('https://itunes.apple.com/search');
  url.searchParams.set('media', 'music');
  url.searchParams.set('entity', 'song');
  url.searchParams.set('limit', String(limit(size)));
  url.searchParams.set('country', storeCode(store));
  url.searchParams.set('term', term);
  return url.toString();
}

// The chart feed is the only Apple endpoint that labels a release date per track,
// which is what "New releases" needs. Popularity order is kept as Apple sends it.
export function itunesChartUrl({ limit: size = ITUNES_LIMIT, store = ITUNES_STORE } = {}) {
  return 'https://itunes.apple.com/' + storeCode(store) + '/rss/topsongs/limit=' + limit(size) + '/json';
}

function firstLabel(value) { return typeof value === 'object' && value ? clip(value.label) : clip(value); }

// Apple's feed switches from a list to a bare object when it holds one entry.
export function chartEntries(feed) {
  const entries = feed?.feed?.entry;
  if (!entries) return [];
  return (Array.isArray(entries) ? entries : [entries]).filter(e => e && typeof e === 'object');
}

function previewLink(entry) {
  const links = Array.isArray(entry?.link) ? entry.link : [entry?.link];
  return links.filter(Boolean).map(l => l?.attributes || {}).find(a =>
    a.rel === 'enclosure' && a.type === 'audio/x-m4a' && (a['im:assetType'] || '').includes('preview')) || null;
}

function pageLink(entry) {
  const links = Array.isArray(entry?.link) ? entry.link : [entry?.link];
  const alt = links.filter(Boolean).map(l => l?.attributes || {}).find(a => a.rel === 'alternate' && a.type === 'text/html');
  return alt?.href || firstLabel(entry?.id);
}

export function mapItunesChart(entry) {
  if (!entry) return null;
  const rawId = entry.id?.attributes?.['im:id'] || /i=(\d+)/.exec(firstLabel(entry.id))?.[1] || '';
  const id = clip(rawId, 16);
  if (!TRACK_ID.test(id)) return null;
  const preview = previewLink(entry);
  // No clip means Apple is not offering this recording for free preview — drop the row
  // rather than hand the player a source we do not have.
  if (!preview?.href) return null;
  const title = firstLabel(entry['im:name']);
  if (!title) return null;
  return {
    provider: 'itunes', id, title, artist: firstLabel(entry['im:artist']) || 'Apple Music',
    source: preview.href, page: pageLink(entry), license: ITUNES_LICENSE,
    released: Date.parse(firstLabel(entry['im:releaseDate'])) || 0
  };
}

export function mapItunesSearch(raw) {
  if (!raw || typeof raw !== 'object' || raw.kind !== 'song') return null;
  const id = clip(raw.trackId, 16);
  if (!TRACK_ID.test(id)) return null;
  const title = clip(raw.trackName);
  if (!title || !raw.previewUrl) return null;
  return {
    provider: 'itunes', id, title, artist: clip(raw.artistName, 100) || 'Apple Music',
    source: raw.previewUrl, page: raw.trackViewUrl || raw.collectionViewUrl || '',
    license: ITUNES_LICENSE, released: Date.parse(raw.releaseDate || '') || 0
  };
}

// Search matches the term, so the only useful order is newest release first; the chart
// already arrives in Apple's popularity ranking.
export function newestFirst(items) {
  return items.filter(i => i && typeof i === 'object')
    .map((item, index) => [item, index])
    .sort((a, b) => (b[0].released - a[0].released) || (a[1] - b[1]))
    .map(([item]) => item);
}

// A saved favorite can be edited in local storage, so re-check the host we last
// received instead of trusting it, the same way the Audius revival path does.
export function savedPreview(raw) {
  try {
    const url = new URL(String(raw?.source || ''));
    if (url.protocol === 'https:' && url.hostname === PREVIEW_HOST) return url.href;
  } catch { /* fall through */ }
  return null;
}

// Thirty seconds is all Apple publishes, so the honest answer to "play the whole song"
// is to hand the listener to YouTube's own public results page for that title and
// artist. It costs no key and no account, and because it is a search rather than a
// catalog we claim to hold, it covers every language the same way.
export function fullListenUrl(title, artist) {
  const term = [clip(title), clip(artist, 60)].filter(Boolean).join(' ').trim();
  if (term.length < 2) return '';
  return 'https://www.youtube.com/results?search_query=' + encodeURIComponent(term.slice(0, 120) + ' song');
}
