// YouTube rows are played by YouTube's own iframe player, so a row carries an 11-character
// video id and two public page URLs — never a stream, and never a byte we hold. The search
// itself runs on the OpenMic server because a Data API key must not ship to a browser.
const VIDEO = /^[A-Za-z0-9_-]{11}$/;
export const YOUTUBE_LICENSE = 'Full-length video';

function clip(value, n = 140) { return String(value ?? '').trim().slice(0, n); }
function isVideo(value) { return VIDEO.test(String(value || '')); }

export function youtubeWatch(id) { return isVideo(id) ? 'https://www.youtube.com/watch?v=' + id : ''; }
// youtube-nocookie is YouTube's privacy-enhanced embed host. Whether the video plays, and
// with what ads or restrictions, is decided by YouTube when the frame loads.
export function youtubeEmbed(id) { return isVideo(id) ? 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&rel=0' : ''; }

export function videoId(raw) {
  const value = String(raw || '');
  return isVideo(value) ? value : '';
}

// A search row comes from our own server, which has already checked the id, so the URLs
// here are rebuilt from the id rather than believed from the response.
export function youtubeRow(raw) {
  if (!raw || typeof raw !== 'object' || !isVideo(raw.id)) return null;
  const title = clip(raw.title);
  if (!title) return null;
  return {
    provider: 'youtube', id: String(raw.id), title, artist: clip(raw.artist, 100) || 'YouTube',
    source: youtubeEmbed(raw.id), page: youtubeWatch(raw.id), license: YOUTUBE_LICENSE,
    released: Number(raw.released) || 0,
  };
}

// A saved favorite can be edited in local storage, so both URLs are rebuilt from the id
// inside it. A row that was written by hand can then only ever name a YouTube video.
export function savedEmbed(saved) {
  const id = String(saved?.id || '');
  if (!id.startsWith('youtube:')) return null;
  const row = youtubeRow({ id: id.slice('youtube:'.length), title: saved.title, artist: saved.artist });
  if (!row) return null;
  return { ...row, license: clip(saved.license, 70) || YOUTUBE_LICENSE };
}
