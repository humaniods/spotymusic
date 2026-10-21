import {searchAcross, SOURCES, SOURCE_LIMIT} from './providers.mjs';
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

function renderRow(track) {
  const id=escapeHtml(track.id);
  const title=escapeHtml(track.title);
  const artist=escapeHtml(track.artist);
  const source=escapeHtml(SOURCES[track.provider] || 'Music');
  const license=escapeHtml(track.license || 'See source terms');
  const page=escapeHtml(track.page || 'https://audius.co');
  const label=track.live?'LIVE RADIO':source.toUpperCase();
  return '<div class="track-item" data-id="'+id+'">' +
    '<button class="row-play" data-action="play" data-id="'+id+'" aria-label="Play '+title+'">' +
      '<svg><use href="#i-play"/></svg></button>' +
    '<div class="track-cover free-cover"><span>'+(track.live?'📻':'♫')+'</span></div>' +
    '<div class="free-track-details"><div class="track-title">'+title+'</div><div class="track-artist">'+artist+'</div>' +
      '<a class="free-source-credit" href="'+page+'" target="_blank" rel="noopener noreferrer" title="Original source and attribution">'+source+' · '+license+' ↗</a></div>' +
    '<div class="track-kind">'+label+'</div>' +
    '<button class="icon-button row-like" data-action="like" data-id="'+id+'" title="Like" aria-label="Like '+title+'"><svg><use href="#i-heart"/></svg></button>' +
    '<button class="icon-button row-add" data-action="add" data-id="'+id+'" title="Add to playlist" aria-label="Add '+title+' to playlist"><svg><use href="#i-plus"/></svg></button></div>';
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
  if(reset) {offset=0;displayed.clear();results.replaceChildren();}
  more.disabled=true;
  more.hidden=true;
  status.textContent='Searching '+(provider==='all'?'all four free sources':SOURCES[provider])+' for '+heading()+'…';
  try {
    const data=await searchAcross({provider,mode,query,offset,limit:SOURCE_LIMIT,signal:controller.signal});
    if(request!==serial) return;
    window.dispatchEvent(new CustomEvent('spotymusic:register-online',{detail:data.tracks}));
    const fresh=data.tracks.filter(t=>!displayed.has(t.id));
    fresh.forEach(t=>displayed.add(t.id));
    results.insertAdjacentHTML('beforeend',fresh.map(renderRow).join(''));
    offset+=SOURCE_LIMIT;
    const failed=data.errors.length ? ' · '+data.errors.map(e=>SOURCES[e.provider]+' unavailable').join(', ') : '';
    status.textContent=(displayed.size ? displayed.size+' listings found' : 'No streamable results found')+
      ' · '+(provider==='all'?'All free sources':SOURCES[provider])+failed;
    more.hidden= !fresh.length;
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
