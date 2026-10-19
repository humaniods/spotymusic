export const SPOTIFY_KINDS = new Set(['track', 'album', 'playlist', 'artist', 'episode', 'show']);

export function parseSpotifyUrl(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  let kind, id;
  const uri = /^spotify:(track|album|playlist|artist|episode|show):([A-Za-z0-9]{22})$/i.exec(raw);
  if (uri) {
    kind = uri[1].toLowerCase(); id = uri[2];
  } else {
    let url;
    try { url = new URL(raw); } catch { return null; }
    if (url.protocol !== 'https:' || !['open.spotify.com', 'play.spotify.com'].includes(url.hostname)) return null;
    const segments = url.pathname.split('/').filter(Boolean);
    // Spotify sometimes prefixes links with international /intl-en/.
    if (segments[0]?.startsWith('intl-')) segments.shift();
    if (segments.length !== 2) return null;
    [kind, id] = segments;
    kind = kind.toLowerCase();
  }
  if (!SPOTIFY_KINDS.has(kind) || !/^[A-Za-z0-9]{22}$/.test(id)) return null;
  return {
    id: `${kind}:${id}`,
    kind,
    spotifyId: id,
    url: `https://open.spotify.com/${kind}/${id}`,
    embedUrl: `https://open.spotify.com/embed/${kind}/${id}?utm_source=generator`
  };
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2,'0')}`;
}

export function nextIndex(current, size, { repeat = 'off', shuffle = false, random = Math.random } = {}) {
  if (size <= 0) return -1;
  if (repeat === 'one') return current;
  if (shuffle && size > 1) {
    const choice = Math.min(size - 2, Math.floor(random() * (size - 1)));
    return choice >= current ? choice + 1 : choice;
  }
  if (current + 1 < size) return current + 1;
  return repeat === 'all' ? 0 : -1;
}

export function searchItems(items, query) {
  const needle = String(query || '').toLocaleLowerCase().trim();
  if (!needle) return items;
  return items.filter(item => [item.title, item.artist, item.kind].some(value => String(value || '').toLocaleLowerCase().includes(needle)));
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}

export function safeFile(file) {
  const extensions = /\.(mp3|m4a|aac|wav|ogg|flac|opus|webm)$/i;
  return Boolean(file && typeof file.name === 'string' && (
    (typeof file.type === 'string' && file.type.startsWith('audio/')) || extensions.test(file.name)
  ) && (!Number.isFinite(file.size) || file.size <= 200 * 1024 * 1024));
}
