// Artist studio (accounts, profiles, uploads, assistant) and the community catalog
// screen that plays those uploads. Everything here degrades to a readable message when
// the OpenMic server is not running, so the static app still works without a backend.
import { communityApi, normalizeCommunityTrack } from './community-api.mjs';
import { askConfirm } from './dialogs.mjs';
import { safeFile, escapeHtml } from './core.mjs';

const $ = selector => document.querySelector(selector);
const esc = value => escapeHtml(value ?? '');

let meta = null;
let user = null;
let mine = [];
let usedBytes = 0;
let reporting = null;
let view = { handle: '', query: '' };

const notify = message => window.dispatchEvent(new CustomEvent('openmic:toast', { detail: message }));
const register = tracks => window.dispatchEvent(new CustomEvent('openmic:register-online', { detail: tracks }));
const set = (selector, message) => { const node = $(selector); if (node) node.textContent = message; };

function bytes(size) {
  const value = Number(size) || 0;
  return value > 1048576 ? (value / 1048576).toFixed(1) + ' MB' : Math.round(value / 1024) + ' KB';
}

// Rounding a 25-second loop to minutes printed "0 min" in the studio, which reads
// like a broken upload.
function length(seconds) {
  const value = Math.round(Number(seconds) || 0);
  if (!value) return '';
  return value < 90 ? value + ' sec · ' : Math.round(value / 60) + ' min · ';
}

// Only the player needs the real duration, and it costs a metadata load to get it.
function measureDuration(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const probe = new Audio();
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => {
      const seconds = Number.isFinite(probe.duration) ? Math.round(probe.duration) : 0;
      URL.revokeObjectURL(url);
      resolve(seconds);
    };
    probe.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
    probe.src = url;
  });
}

function communityRow(track) {
  const id = esc(track.id);
  const title = esc(track.title);
  const handle = esc(track.handle || '');
  const credit = handle
    ? `<button type="button" class="free-source-credit artist-link" data-action="artist" data-handle="${handle}">@${handle} · rights warranty on file ↗</button>`
    : '<span class="free-source-credit">OpenMic upload · rights warranty on file</span>';
  return '<div class="track-item" data-id="' + id + '">' +
    '<button class="row-play" data-action="play" data-id="' + id + '" aria-label="Play ' + title + '"><svg><use href="#i-play"/></svg></button>' +
    '<div class="track-cover free-cover"><span>♫</span></div>' +
    '<div class="free-track-details"><div class="track-title">' + title + '</div>' +
      '<div class="track-artist">' + esc(track.artist) + (track.genre ? ' · ' + esc(track.genre) : '') + '</div>' + credit + '</div>' +
    '<div class="track-kind">ARTIST UPLOAD</div>' +
    '<button class="icon-button row-like" data-action="like" data-id="' + id + '" title="Like" aria-label="Like ' + title + '"><svg><use href="#i-heart"/></svg></button>' +
    '<button class="icon-button row-add" data-action="add" data-id="' + id + '" title="Add to playlist" aria-label="Add ' + title + ' to playlist"><svg><use href="#i-plus"/></svg></button>' +
    '<button class="icon-button row-report" data-action="report" data-id="' + id + '" title="Report a rights issue" aria-label="Report ' + title + '"><svg><use href="#i-flag"/></svg></button></div>';
}

function studioRow(track) {
  const title = esc(track.title);
  const published = track.status === 'published';
  const id = esc(track.id);
  return '<div class="track-item" data-id="' + (published ? 'community:' + id : '') + '">' +
    (published
      ? '<button class="row-play" data-action="play" data-id="community:' + id + '" aria-label="Play ' + title + '"><svg><use href="#i-play"/></svg></button>'
      : '<span class="row-play row-waiting" title="Upload not finished">…</span>') +
    '<div class="track-cover free-cover"><span>♫</span></div>' +
    '<div class="free-track-details"><div class="track-title">' + title + '</div>' +
      '<div class="track-artist">' + (published ? 'Published · plays from this server' : 'Upload interrupted — delete and add it again') + '</div></div>' +
    '<div class="track-kind">' + length(track.duration) + bytes(track.size) + '</div>' +
    '<span class="row-slot" aria-hidden="true"></span>' +
    '<span class="row-slot" aria-hidden="true"></span>' +
    '<button class="icon-button row-remove" data-action="studio-remove" data-id="' + id + '" title="Delete this upload" aria-label="Delete ' + title + '"><svg><use href="#i-trash"/></svg></button></div>';
}

function renderStudio() {
  const signedOut = $('#studio-signedout');
  const account = $('#studio-account');
  if (!signedOut || !account) return;
  signedOut.classList.toggle('hidden', Boolean(user));
  account.classList.toggle('hidden', !user);
  if (!user) return;
  set('#profile-handle', '@' + user.handle);
  $('#profile-name').value = user.name || '';
  $('#profile-bio').value = user.bio || '';
  set('#quota-line', mine.length + ' upload' + (mine.length === 1 ? '' : 's') + ' · ' +
    bytes(usedBytes) + ' of ' + bytes((meta?.limits?.userBytes) || 209715200));
  const list = $('#my-tracks');
  list.replaceChildren();
  list.innerHTML = mine.length ? mine.map(studioRow).join('')
    : '<div class="empty-state"><b>Nothing published yet</b>Add your first recording above.</div>';
  register(mine.filter(track => track.status === 'published').map(normalizeCommunityTrack).filter(Boolean));
}

function renderAssistant(answer) {
  const box = $('#ai-output');
  const items = (answer.suggestions || []).map(item => '<li>' + esc(item) + '</li>').join('');
  const notes = (answer.notes || []).map(note => '<p class="ai-note">' + esc(note) + '</p>').join('');
  box.innerHTML = (items ? '<ul class="ai-list">' + items + '</ul>' : '') + notes +
    '<p class="ai-source">' + (answer.source === 'model' ? 'Suggested by the configured model'
      : 'Suggested by OpenMic rules' + (answer.degraded ? ' (model unreachable)' : '')) +
    ' · always check before you publish.</p>';
}

async function loadCommunity() {
  const box = $('#community-results');
  const status = $('#community-status');
  // The server answers with bare upload ids; normalize gives each row the player's
  // community:<id> record, which is what carries the stream URL and lets a row be
  // played, liked and restored after a reload.
  const ready = tracks => tracks.map(normalizeCommunityTrack).filter(Boolean);
  $('#community-back').classList.toggle('hidden', !view.handle);
  status.textContent = 'Loading OpenMic uploads…';
  box.innerHTML = '';
  $('#community-artist').classList.add('hidden');
  try {
    if (view.handle) {
      const page = await communityApi.artist(view.handle);
      $('#community-artist').classList.remove('hidden');
      set('#artist-name', page.artist.name);
      set('#artist-handle', '@' + page.artist.handle);
      set('#artist-bio', page.artist.bio || 'This artist has not written a bio yet.');
      set('#artist-count', page.tracks.length + ' published recording' + (page.tracks.length === 1 ? '' : 's'));
      const owned = ready(page.tracks);
      box.innerHTML = owned.length ? owned.map(communityRow).join('')
        : '<div class="empty-state"><b>No uploads yet</b>This artist has not published anything on OpenMic.</div>';
      register(owned);
      status.textContent = '@' + page.artist.handle + ' · ' + owned.length + ' track(s) on this OpenMic server';
      return;
    }
    const found = await communityApi.list({ query: view.query, limit: 30 });
    const listed = ready(found.tracks);
    box.innerHTML = listed.length ? listed.map(communityRow).join('')
      : '<div class="empty-state"><b>Nothing here yet</b>Artists publish on the For artists screen; new uploads show up in this list.</div>';
    register(listed);
    status.textContent = found.total + ' artist upload' + (found.total === 1 ? '' : 's') +
      (view.query ? ' for “' + view.query + '”' : '') + ' · hosted by this OpenMic server';
  } catch (error) {
    const message = String(error?.message || error);
    // Only a server that isn't there at all gets the "start npm start" explanation; a
    // running server that answers "no artist with that handle" must say exactly that.
    const offline = /Failed to fetch|Load failed|not JSON|No answer from the OpenMic server|NetworkError/.test(message);
    status.textContent = offline
      ? 'No OpenMic server is answering. Start it with npm start — browsing free sources still works without it.'
      : 'Community catalog unavailable: ' + esc(message.slice(0, 160));
  }
}

async function refreshSession() {
  try {
    const session = await communityApi.session();
    user = session.user;
    mine = session.tracks || [];
    usedBytes = session.usedBytes || 0;
  } catch {
    user = null;
    mine = [];
    usedBytes = 0;
  }
  renderStudio();
}

async function withBusy(selector, label, done) {
  const button = $(selector);
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    await done();
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

function events() {
  $('#signup-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('#signup-error').textContent = '';
    const body = {
      name: $('#signup-name').value, handle: $('#signup-handle').value,
      email: $('#signup-email').value, password: $('#signup-password').value,
    };
    await withBusy('#signup-submit', 'Creating…', async () => {
      try {
        const created = await communityApi.signup(body);
        user = created.user;
        $('#signup-password').value = '';
        await refreshSession();
        notify('Artist page is live at @' + created.user.handle);
      } catch (error) {
        $('#signup-error').textContent = error.message;
      }
    });
  });

  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('#login-error').textContent = '';
    await withBusy('#login-submit', 'Signing in…', async () => {
      try {
        await communityApi.login({ email: $('#login-email').value, password: $('#login-password').value });
        $('#login-password').value = '';
        await refreshSession();
        notify('Welcome back');
      } catch (error) {
        $('#login-error').textContent = error.message;
      }
    });
  });

  $('#sign-out').addEventListener('click', async () => {
    try { await communityApi.logout(); } catch { /* the cookie is gone either way */ }
    await refreshSession();
    notify('Signed out of the artist studio');
  });

  $('#profile-form').addEventListener('submit', async event => {
    event.preventDefault();
    set('#profile-status', 'Saving…');
    try {
      const saved = await communityApi.saveProfile({ name: $('#profile-name').value, bio: $('#profile-bio').value });
      user = saved.user;
      renderStudio();
      set('#profile-status', 'Profile saved.');
    } catch (error) {
      set('#profile-status', error.message);
    }
  });

  $('#upload-form').addEventListener('submit', async event => {
    event.preventDefault();
    const file = $('#upload-file').files[0];
    const title = $('#upload-title').value.trim();
    const box = $('#upload-status');
    if (!file || !safeFile(file)) { box.textContent = 'Choose an MP3, WAV, OGG, FLAC, M4A, AAC, OPUS or WebM file.'; return; }
    if (!title) { box.textContent = 'Give the recording a title.'; return; }
    if (file.size > (meta?.limits?.audioBytes || 26214400)) {
      box.textContent = 'That file is ' + bytes(file.size) + '. The per-upload limit is ' + bytes(meta?.limits?.audioBytes || 26214400) + '.';
      return;
    }
    if (!$('#upload-rights').checked) { box.textContent = 'Tick the rights warranty before publishing.'; return; }
    box.textContent = 'Reading duration…';
    const duration = await measureDuration(file);
    await withBusy('#upload-submit', 'Publishing…', async () => {
      try {
        const created = await communityApi.publish(
          { title, genre: $('#upload-genre').value.trim(), tags: $('#upload-tags').value.split(',').map(t => t.trim()).filter(Boolean).slice(0, 8), duration },
          file,
          { rightsConfirmed: true, version: meta?.warranty?.version || 'openmic-rights-1' });
        box.textContent = 'Uploading ' + bytes(file.size) + '…';
        const published = await communityApi.putAudio(created.track.id, file);
        box.textContent = '“' + published.track.title + '” is live in the Community list.';
        notify('Published “' + published.track.title + '”');
        $('#upload-form').reset();
        await refreshSession();
        if ($('#community-panel') && !$('#community-panel').classList.contains('hidden')) await loadCommunity();
      } catch (error) {
        box.textContent = error.message;
        await refreshSession();
      }
    });
  });

  $('#ai-ask').addEventListener('click', async () => {
    const output = $('#ai-output');
    output.textContent = 'Thinking…';
    const input = $('#upload-file').files[0] && $('#ai-task').value === 'title'
      ? $('#upload-file').files[0].name
      : $('#ai-input').value;
    try {
      renderAssistant(await communityApi.assist($('#ai-task').value, input));
    } catch (error) {
      output.textContent = error.message;
    }
  });

  $('#community-form').addEventListener('submit', event => {
    event.preventDefault();
    view.query = $('#community-query').value.trim().slice(0, 100);
    view.handle = '';
    loadCommunity();
  });
  $('#community-clear').addEventListener('click', () => {
    view.query = '';
    view.handle = '';
    $('#community-query').value = '';
    loadCommunity();
  });
  $('#community-back').addEventListener('click', () => {
    view.handle = '';
    loadCommunity();
  });
  $('#ai-search').addEventListener('click', async () => {
    const words = $('#community-mood').value.trim();
    if (!words) { $('#community-mood').focus(); return; }
    const button = $('#ai-search');
    button.disabled = true;
    try {
      const answered = await communityApi.assist('search', words);
      $('#community-mood').value = '';
      $('#community-query').value = answered.query || words;
      view.query = answered.query || words;
      view.handle = '';
      set('#community-status', 'Searching for: ' + view.query);
      loadCommunity();
    } catch (error) {
      set('#community-status', 'The listener helper is not available: ' + (error?.message || error));
    } finally {
      button.disabled = false;
    }
  });

  $('#takedown-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('#takedown-error').textContent = '';
    try {
      const result = await communityApi.takedown({
        target: $('#takedown-target').value, email: $('#takedown-email').value,
        notice: $('#takedown-notice').value, goodFaith: $('#takedown-good').checked,
      });
      $('#takedown-done').textContent = result.notice + (result.terminated
        ? ' This was the uploader’s second notice, so their account has been terminated.' : '');
      $('#takedown-form').classList.add('hidden');
      if (reporting && reporting.startsWith('community:')) {
        window.dispatchEvent(new CustomEvent('openmic:forget', { detail: reporting }));
        reporting = null;
      }
      if (!$('#community-panel').classList.contains('hidden')) await loadCommunity();
      if (!$('#artist-panel').classList.contains('hidden')) await refreshSession();
    } catch (error) {
      $('#takedown-error').textContent = error.message;
    }
  });
  $('#takedown-open').addEventListener('click', () => openTakedown(''));
  $('#takedown-cancel').addEventListener('click', () => $('#takedown-dialog').close());
  $('#takedown-close').addEventListener('click', () => $('#takedown-dialog').close());

  document.addEventListener('click', async event => {
    const artist = event.target.closest('[data-action="artist"]');
    if (artist) {
      view.handle = artist.dataset.handle;
      view.query = '';
      $('#community-query').value = '';
      window.dispatchEvent(new CustomEvent('openmic:goto', { detail: 'community' }));
      return;
    }
    const report = event.target.closest('[data-action="report"]');
    if (report) {
      openTakedown('/api/stream/' + report.dataset.id.split(':').pop(), report.dataset.id);
      return;
    }
    const drop = event.target.closest('[data-action="studio-remove"]');
    if (drop) {
      const id = drop.dataset.id;
      const track = mine.find(item => item.id === id);
      if (!track) return;
      const yes = await askConfirm('Delete this upload?',
        '“' + track.title + '” is removed from OpenMic for every listener. Your own copy on this computer stays.',
        'Delete upload');
      if (!yes) return;
      try {
        await communityApi.remove(id);
        await refreshSession();
        notify('Upload deleted');
      } catch (error) {
        notify(error.message);
      }
    }
  });

  window.addEventListener('openmic:navigate', event => {
    const page = event.detail?.page;
    if (page === 'artist') refreshSession();
    // Reload on every visit: another artist may have published since the last look, and
    // a cached list is how a brand-new upload appears to be missing.
    if (page === 'community') loadCommunity();
  });
}

function openTakedown(target, rowId) {
  // A notice filed from a row tells us which upload to drop from the listener's own
  // library once the server confirms it is gone; the generic link has no row.
  reporting = rowId || null;
  $('#takedown-target').value = target || '';
  $('#takedown-error').textContent = '';
  $('#takedown-done').textContent = '';
  $('#takedown-form').classList.remove('hidden');
  $('#takedown-dialog').showModal();
  (target ? $('#takedown-notice') : $('#takedown-target')).focus();
}

async function init() {
  events();
  try {
    meta = await communityApi.meta();
    $('#warranty-text').textContent = meta.warranty.text;
    set('#dmca-agent', meta.agent);
    set('#community-count-note', meta.tracks + ' upload(s) on this server');
  } catch {
    set('#warranty-text', 'The OpenMic server is not answering, so uploads are unavailable. Run npm start to enable them.');
  }
  // The studio stays in its signed-out state until the artist screen is opened, so a
  // first-time listener never sees a 401 in the console for a session they never asked for.
}

init();
