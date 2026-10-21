import { fetchFreeTracks, PAGE_SIZE } from './audius.mjs';
import { escapeHtml } from './core.mjs';

const results = document.querySelector('#free-results');
const status = document.querySelector('#free-status');
const more = document.querySelector('#free-more');
const searchForm = document.querySelector('#free-search-form');
const searchInput = document.querySelector('#free-query');
const modeButtons = [...document.querySelectorAll('[data-free-mode]')];

let mode = 'latest';
let query = '';
let offset = 0;
let busy = false;
let started = false;
let requestNumber = 0;
let controller;
const visibleIds = new Set();

function row(track) {
  const id = escapeHtml(track.id);
  const title = escapeHtml(track.title);
  const artist = escapeHtml(track.artist);
  return '<div class="track-item" data-id="' + id + '">' +
    '<button class="row-play" data-action="play" data-id="' + id + '" aria-label="Play ' + title + '">' +
    '<svg><use href="#i-play"/></svg></button>' +
    '<div class="track-cover free-cover"><span>♫</span></div>' +
    '<div style="min-width:0"><div class="track-title">' + title + '</div>' +
    '<div class="track-artist">' + artist + '</div></div>' +
    '<div class="track-kind">AUDIUS · FREE STREAM</div>' +
    '<button class="icon-button row-like" data-action="like" data-id="' + id + '" title="Like" aria-label="Like ' + title + '"><svg><use href="#i-heart"/></svg></button>' +
    '<button class="icon-button row-add" data-action="add" data-id="' + id + '" title="Add to playlist" aria-label="Add ' + title + ' to playlist"><svg><use href="#i-plus"/></svg></button></div>';
}

function updateModes() {
  for (const button of modeButtons) {
    const active = button.dataset.freeMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

async function load(reset = false) {
  if (!reset && busy) return;
  if (controller) controller.abort();
  controller = new AbortController();
  const requestId = ++requestNumber;
  busy = true;
  more.disabled = true;
  more.hidden = true;
  if (reset) {
    offset = 0;
    visibleIds.clear();
    results.innerHTML = '';
  }
  status.textContent = 'Loading ' + (mode === 'latest' ? 'new releases' : mode === 'trending' ? 'this week’s trending tracks' : 'search results') + '…';
  try {
    const tracks = await fetchFreeTracks({ mode, query, offset, limit: PAGE_SIZE, signal: controller.signal });
    if (requestId !== requestNumber) return;
    window.dispatchEvent(new CustomEvent('spotymusic:register-online', { detail: tracks }));
    const unseen = tracks.filter(track => !visibleIds.has(track.id));
    for (const item of unseen) visibleIds.add(item.id);
    results.insertAdjacentHTML('beforeend', unseen.map(row).join(''));
    offset += PAGE_SIZE;
    const count = visibleIds.size;
    status.textContent = count
      ? count + ' playable track' + (count === 1 ? '' : 's') + ' · streamed by Audius'
      : 'No freely streamable tracks found. Try another search.';
    more.hidden = tracks.length < PAGE_SIZE || unseen.length === 0;
  } catch (error) {
    if (requestId !== requestNumber || error?.name === 'AbortError') return;
    status.textContent = 'Free catalog could not load (' + String(error.message || 'network error') + '). Check connection or try again.';
    more.hidden = false;
    more.textContent = 'Retry';
  } finally {
    if (requestId === requestNumber) {
      busy = false;
      more.disabled = false;
    }
  }
}

for (const button of modeButtons) button.addEventListener('click', () => {
  mode = button.dataset.freeMode;
  query = '';
  updateModes();
  started = true;
  more.textContent = 'Load more';
  load(true);
});

searchForm.addEventListener('submit', event => {
  event.preventDefault();
  query = searchInput.value.trim().slice(0, 100);
  if (!query) {
    status.textContent = 'Type a song or artist name to search.';
    searchInput.focus();
    return;
  }
  mode = 'search';
  updateModes();
  started = true;
  more.textContent = 'Load more';
  load(true);
});

more.addEventListener('click', () => {
  if (more.textContent === 'Retry') {
    more.textContent = 'Load more';
    load(false);
  } else load(false);
});

document.addEventListener('click', event => {
  if (event.target.closest('[data-page="free"]') && !started) {
    started = true;
    updateModes();
    load(true);
  }
});
