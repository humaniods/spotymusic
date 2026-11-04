import {searchAcross, SOURCES, BROWSE_SOURCES, SOURCE_LIMIT} from './providers.mjs';
import {fullListenUrl} from './itunes.mjs';
import {communityApi} from './community-api.mjs';
import {canCache, offlineCell} from './library.mjs';
import {escapeHtml} from './core.mjs';

const results = document.querySelector('#free-results');
const status = document.querySelector('#free-status');
const more = document.querySelector('#free-more');
const form = document.querySelector('#free-search-form');
const input = document.querySelector('#free-query');
const providerSelect = document.querySelector('#free-provider');
const filters = [...document.querySelectorAll('[data-free-mode]')];
let mode='latest', query='', provider='all', offset=0, started=false;
let controller, serial=0, busy=false;
const displayed = new Set();

// Apple hands OpenMic a 30-second clip, not the recording. The row says so and offers the
// one legal way to the rest of it: YouTube. Without a Data API key on the server that is a
// link to YouTube's own search results; with one, /api/full-track resolves the official
// video and it plays in the side panel. Both tiers cost the listener nothing.
let fullTrack='link-out';
const fullTrackMode=communityApi.meta()
  .then(meta=>{if(meta?.fullTrack==='youtube-data-api')fullTrack='embed';})
  .catch(()=>{});

// YouTube is a metered source: every search bills the day's quota, so it only appears
// once the server reports a Data API key. Without one, the handoff stays a link out.
const youtubeOption = providerSelect.querySelector('option[value="youtube"]');
const allOption = providerSelect.querySelector('option[value="all"]');
function allowYouTube(allowed) {
  if (youtubeOption) youtubeOption.hidden = !allowed;
  // The "All" label states the real fan-out instead of a number that went stale the
  // moment a Data API key was added to the server.
  if (allOption) allOption.textContent = 'All ' + (BROWSE_SOURCES.length + (allowed?1:0)) + ' sources';
  if (!allowed && provider==='youtube') { provider='all'; providerSelect.value='all'; }
}

function fullTrackCell(track) {
  // The control lives under the source credit rather than in a row cell: the row is a
  // six-column grid sized for icons, and a text pill in one of those slots is crushed.
  if (track.provider !== 'itunes') return '';
  // The search term is built from the raw title, not the HTML-escaped one, or every
  // “&amp;” in a song name would be typed into YouTube as those five characters.
  const name=escapeHtml((track.title+' '+track.artist).slice(0,120));
  if (fullTrack==='embed')
    return '<button class="row-full" type="button" data-action="full-track" data-query="'+name+
      '" title="Find the full recording on YouTube">Full track</button>';
  return '<a class="row-full" href="'+escapeHtml(fullListenUrl(track.title,track.artist))+
    '" target="_blank" rel="noopener noreferrer" title="The full recording lives on YouTube">Full track ↗</a>';
}

function renderRow(track) {
  const id=escapeHtml(track.id);
  const title=escapeHtml(track.title);
  const artist=escapeHtml(track.artist);
  const source=escapeHtml(SOURCES[track.provider] || 'Music');
  const license=escapeHtml(track.license || 'See source terms');
  const page=escapeHtml(track.page || 'https://audius.co');
  const label=track.live?'LIVE RADIO':source.toUpperCase();
  // Only rows whose audio this browser actually receives get a save control; an embed row
  // has no bytes here to keep, so offering one would be a broken promise.
  const keep=canCache(track)?offlineCell(id,title):'<span class="row-slot" aria-hidden="true"></span>';
  return '<div class="track-item" data-id="'+id+'">' +
    '<button class="row-play" data-action="play" data-id="'+id+'" aria-label="Play '+title+'">' +
      '<svg><use href="#i-play"/></svg></button>' +
    '<div class="track-cover free-cover"><span>'+(track.live?'📻':'♫')+'</span></div>' +
    '<div class="free-track-details"><div class="track-title">'+title+'</div><div class="track-artist">'+artist+'</div>' +
      '<a class="free-source-credit" href="'+page+'" target="_blank" rel="noopener noreferrer" title="Original source and attribution">'+source+' · '+license+' ↗</a>' +
      fullTrackCell(track) + '</div>' +
    '<div class="track-kind">'+label+'</div>' +
    '<button class="icon-button row-like" data-action="like" data-id="'+id+'" title="Like" aria-label="Like '+title+'"><svg><use href="#i-heart"/></svg></button>' +
    '<button class="icon-button row-add" data-action="add" data-id="'+id+'" title="Add to playlist" aria-label="Add '+title+' to playlist"><svg><use href="#i-plus"/></svg></button>' +
    keep+'</div>';
}
function updateFilter() {
  for(const button of filters) {
    const active=button.dataset.freeMode===mode;
    button.classList.toggle('active',active);
    button.setAttribute('aria-pressed',String(active));
  }
}
function heading() {
  if(mode==='search') return 'search results for “'+query+'”';
  return mode==='latest'?'new and discoverable music':'popular music and live radio';
}
async function load(reset=false) {
  if(busy&&!reset) return;
  controller?.abort();
  controller=new AbortController();
  const request=++serial;
  busy=true;
  // Wait for /api/meta before the first row is built, so a row never renders the wrong
  // tier of the full-listen control.
  await fullTrackMode;
  allowYouTube(fullTrack==='embed');
  if(request!==serial) return;
  // YouTube has no chart to browse; it only answers a named search, and every search
  // bills quota. Selecting it outside search mode asks for a name instead of firing one.
  if(provider==='youtube' && mode!=='search') {
    if(reset) {offset=0;displayed.clear();results.replaceChildren();}
    status.textContent='YouTube plays full-length videos. Type a song or artist above to search it.';
    busy=false;
    return;
  }
  // A named search is the one case where YouTube is worth billing for; browse modes
  // fan out over the free, unmetered sources alone.
  const sources = provider==='all'
    ? (mode==='search' && fullTrack==='embed' ? [...BROWSE_SOURCES,'youtube'] : [...BROWSE_SOURCES])
    : [provider];
  let pending = sources;
  const failed=[];
  if(reset) {offset=0;displayed.clear();results.replaceChildren();}
  more.disabled=true;
  more.hidden=true;
  const summary=()=>{
    const who=provider==='all'?'All free sources':SOURCES[provider];
    const parts=[displayed.size?displayed.size+' listings found':'No streamable results found',who];
    if(pending.length) parts.push('waiting on '+pending.map(p=>SOURCES[p]).join(', '));
    if(failed.length) parts.push(failed.map(p=>SOURCES[p]+' unavailable').join(', '));
    return parts.join(' · ');
  };
  const paint=tracks=>{
    const fresh=tracks.filter(t=>!displayed.has(t.id));
    if(!fresh.length) return;
    fresh.forEach(t=>displayed.add(t.id));
    window.dispatchEvent(new CustomEvent('openmic:register-online',{detail:fresh}));
    results.insertAdjacentHTML('beforeend',fresh.map(renderRow).join(''));
    status.textContent=summary();
  };
  status.textContent='Searching '+(provider==='all'?sources.length+' free sources':SOURCES[provider])+' for '+heading()+'…';
  try {
    const data=await searchAcross({provider:sources,mode,query,offset,limit:SOURCE_LIMIT,signal:controller.signal,
      onSource:outcome=>{
        if(request!==serial) return;
        pending=pending.filter(p=>p!==outcome.provider);
        if(outcome.error) failed.push(outcome.provider);
        paint(outcome.tracks);
      }});
    if(request!==serial) return;
    paint(data.tracks);
    offset+=SOURCE_LIMIT;
    status.textContent=summary();
    more.hidden= !data.tracks.length;
    more.textContent='Load more';
  } catch(error) {
    if(request!==serial||error?.name==='AbortError')return;
    status.textContent='Catalog request failed: '+String(error?.message || error)+'. Try again.';
    more.textContent='Retry';
    more.hidden=false;
  } finally {
    if(request===serial){busy=false;more.disabled=false;}
  }
}
function start() {
  started=true;
  query='';
  mode='latest';
  input.value='';
  updateFilter();
  load(true);
}
filters.forEach(button=>button.addEventListener('click',()=>{
  mode=button.dataset.freeMode;query='';input.value='';
  updateFilter();started=true;load(true);
}));
providerSelect.addEventListener('change',()=>{
  provider=providerSelect.value;
  if(mode==='search'&&!query){mode='latest';updateFilter();}
  started=true;load(true);
});
form.addEventListener('submit',event=>{
  event.preventDefault();
  query=input.value.trim().slice(0,100);
  if(!query){input.focus();status.textContent='Enter a song, artist, recording or station name.';return;}
  mode='search';updateFilter();started=true;load(true);
});
more.addEventListener('click',()=>load(false));
document.addEventListener('click',event=>{
  if(event.target.closest('[data-page="free"]')&&!started)start();
});
// When page is opened using keyboard or navigation, load the first page as well.
document.addEventListener('keydown',event=>{
  if(['Enter',' '].includes(event.key) &&
      event.target.closest('[data-page="free"]')&&!started) start();
});
