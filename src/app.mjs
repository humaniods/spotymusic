import { parseSpotifyUrl, formatTime, nextIndex, searchItems, escapeHtml, safeFile } from './core.mjs';
import { makeDemo } from './demo-audio.mjs';
import { reviveFreeTrack } from './audius.mjs';
import { reviveMultiTrack, SOURCES } from './providers.mjs';
import { communityApi, reviveCommunity } from './community-api.mjs';
import { askConfirm } from './dialogs.mjs';
import {
  canCache, fetchAudio, planEviction, buildRecord, formatBytes, offlineCell,
  openLibrary, listSaved, saveSaved, readSavedAudio, touchSaved, dropSaved,
  requestPersistence, DEFAULT_CAP_BYTES
} from './library.mjs';

// Demo audio is synthesized on first play, not at import: three 20-second WAVs cost
// about 160ms of main-thread work and 1.3MB of blobs on every page load otherwise.
const DEMOS = [
  {id:'demo:golden-hour',title:'Golden Hour',artist:'OpenMic Sessions',kind:'demo',art:0,seed:0},
  {id:'demo:night-drive',title:'Night Drive',artist:'OpenMic Sessions',kind:'demo',art:1,seed:1},
  {id:'demo:slow-motion',title:'Slow Motion',artist:'OpenMic Sessions',kind:'demo',art:2,seed:2}
];
function demoSource(item){
  if(!state.objectUrls.has(item.id)) state.objectUrls.set(item.id,makeDemo(item.seed));
  return state.objectUrls.get(item.id);
}
const ART = [
  'linear-gradient(135deg,#ca754f,#7b3d83 58%,#303879)',
  'linear-gradient(135deg,#143e69,#287879 65%,#7b8a9b)',
  'linear-gradient(135deg,#d28e78,#a75e85 45%,#563e8c)',
  'linear-gradient(135deg,#527d72,#6e9b64,#d5a85c)',
  'linear-gradient(135deg,#694e8b,#b77471,#d4ae7c)',
  'linear-gradient(135deg,#855a63,#a5945a,#61846a)'
];
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const audio = $('#audio');
const state = {tracks:[...DEMOS],online:[],links:[],liked:new Set(),playlists:[],page:'home',activePlaylist:null,current:null,queue:[],queueIndex:0,repeat:'off',shuffle:false,query:'',objectUrls:new Map(),offline:new Map(),saving:new Set(),playingOffline:false};
let db = null, offlineDb = null, toastTimer;
// Re-importing the same file is the easiest way to double-book a library.
const fingerprints=new Set();

function readJSON(key, fallback) {
  try {const value = JSON.parse(localStorage.getItem(`openmic:v1:${key}`));return value ?? fallback;}catch{return fallback;}
}
// Each source has its own reviver because each one re-checks its own id shape and
// rebuilds the stream URL instead of trusting the stored copy. A saved record whose
// kind no longer matches is dropped rather than played from an unchecked URL.
const reviveSaved = saved => reviveFreeTrack(saved) || reviveMultiTrack(saved) || reviveCommunity(saved);
function persist() {
  try {
    localStorage.setItem('openmic:v1:links',JSON.stringify(state.links));
    localStorage.setItem('openmic:v1:liked',JSON.stringify([...state.liked]));
    localStorage.setItem('openmic:v1:playlists',JSON.stringify(state.playlists));
    const retained = state.online.filter(item => protectedId(item.id)).slice(-300);
    localStorage.setItem('openmic:v1:online',JSON.stringify(retained.map(({id,title,artist,source,page,license,kind,provider,art,handle}) => ({id,title,artist,source,page,license,kind,provider,art,handle}))));
  } catch { toast('Storage unavailable; changes may not persist'); }
}
function openDB() {
  return new Promise((resolve,reject)=>{
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    const request=indexedDB.open('openmic-audio',1);
    request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('audio'))request.result.createObjectStore('audio',{keyPath:'id'});};
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
function dbPut(record){return new Promise((resolve,reject)=>{if(!db)return reject(new Error('No database'));const tx=db.transaction('audio','readwrite');tx.objectStore('audio').put(record);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
function dbAll(){return new Promise((resolve,reject)=>{if(!db)return resolve([]);const req=db.transaction('audio').objectStore('audio').getAll();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
function dbDelete(id){return new Promise((resolve,reject)=>{if(!db)return resolve();const tx=db.transaction('audio','readwrite');tx.objectStore('audio').delete(id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
function sanitizeLinks(links){return Array.isArray(links)?links.filter(entry=>parseSpotifyUrl(entry?.url)).slice(0,1000).map(entry=>({...parseSpotifyUrl(entry.url),title:String(entry.title||'Spotify '+entry.kind).slice(0,100),artist:'Spotify · Official embed',kind:'spotify',spotifyKind:parseSpotifyUrl(entry.url).kind,art:4})):[];}
function isValidPlaylist(value){return value&&typeof value.name==='string'&&Array.isArray(value.ids)&&typeof value.id==='string';}
function allItems(){return [...state.tracks,...state.links];}
// Browsed listings are not "saved", so they stay out of allItems() and the Library
// count, but anything the user liked or put in a playlist must still resolve and
// remain searchable - that is what makes a free-source track "theirs".
function ownedOnline(){return state.online.filter(t=>isLiked(t.id)||state.playlists.some(p=>p.ids.includes(t.id)));}
function searchableItems(){return [...allItems(),...ownedOnline()];}
function getItem(id){return allItems().find(t=>t.id===id)||state.online.find(t=>t.id===id);}
function isLiked(id){return state.liked.has(id);}
// Spotify and YouTube rows carry no bytes: the provider's own frame plays them, so the
// audio element, the transport and the queue all have to stand aside for either of them.
function isEmbed(item){return item?.kind==='spotify'||item?.kind==='youtube';}
function notifyNextStatus(){const controls=$$('.transport-buttons button:not(#toggle-play)');const held=isEmbed(state.current);controls.forEach(btn=>btn.disabled=held);$('#toggle-play').disabled=held;$('#seek').disabled=held || state.current?.live===true;$('#volume').disabled=held;}
function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),2900);}
function artStyle(item){return ART[Number.isInteger(item?.art)?item.art%ART.length:3];}
function glyph(item){return isEmbed(item)?'◉':item?.kind==='demo'?'♫':'♪';}
function kindLabel(item){
  // A kept copy changes what the row means: the same listing now plays off this disk.
  const cached=state.offline.has(item.id)?' · OFFLINE':'';
  if(item.kind==='spotify')return `SPOTIFY ${escapeHtml(item.spotifyKind).toUpperCase()}`;
  if(item.kind==='youtube')return 'YOUTUBE FULL VIDEO';
  if(item.kind==='demo')return 'ORIGINAL DEMO';
  if(item.kind==='audius')return 'AUDIUS FREE STREAM'+cached;
  if(item.kind==='radio')return 'LIVE RADIO';
  if(item.kind==='community')return 'ARTIST UPLOAD'+cached;
  return (SOURCES[item.kind]||'LOCAL AUDIO')+cached;
}
function playbackLabel(item){
  if(isEmbed(item))return (item.kind==='spotify'?'SPOTIFY':'YOUTUBE')+' EMBED';
  if(state.playingOffline&&state.offline.has(item?.id))return 'OFFLINE COPY · THIS DEVICE';
  if(item?.kind==='audius')return 'AUDIUS · FREE STREAM';
  if(item?.kind==='radio')return 'LIVE RADIO';
  if(item?.kind==='community')return 'ARTIST UPLOAD · OPENMIC SERVER';
  return SOURCES[item?.kind]||'LOCAL PLAYER';
}
function icon(name){return `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;}
function likedClass(item){return isLiked(item.id)?' liked':'';}
function removableKind(kind){return kind==='local'||kind==='spotify';}
// Rows keep a fixed slot so the library grid does not shift between removable and
// read-only listings.
function rowRemove(item){return removableKind(item.kind)?`<button class="row-remove" data-action="remove" data-id="${escapeHtml(item.id)}" title="Remove from library" aria-label="Remove ${escapeHtml(item.title)} from library">${icon('trash')}</button>`:offlineMarkup(item);}
function itemRow(item,index){const active=item.id===state.current?.id;return `<div class="track-item${active?' selected':''}" data-id="${escapeHtml(item.id)}"><button class="row-play" data-action="play" data-id="${escapeHtml(item.id)}" aria-label="Play ${escapeHtml(item.title)}">${icon('play')}</button><div class="track-cover" style="background:${artStyle(item)}"><span>${glyph(item)}</span></div><div style="min-width:0"><div class="track-title">${escapeHtml(item.title)}</div><div class="track-artist">${escapeHtml(item.artist)}</div></div><div class="track-kind">${kindLabel(item)}</div><button class="icon-button row-like${likedClass(item)}" data-action="like" data-id="${escapeHtml(item.id)}" title="Like" aria-label="Like ${escapeHtml(item.title)}">${icon('heart')}</button><button class="icon-button row-add" data-action="add" data-id="${escapeHtml(item.id)}" title="Add to playlist" aria-label="Add ${escapeHtml(item.title)} to playlist">${icon('plus')}</button>${rowRemove(item)}</div>`;}
function empty(text,sub='Use the buttons above to add something.'){return `<div class="empty-state"><b>${escapeHtml(text)}</b>${escapeHtml(sub)}</div>`;}
function renderRows(selector,items,emptyMsg='No items yet'){const container=$(selector);container.innerHTML=items.length?items.map(itemRow).join(''):empty(emptyMsg);}
function renderFeatured(){ $('#featured-grid').innerHTML=DEMOS.map(item=>`<article class="album-card" data-action="play" data-id="${item.id}" tabindex="0" role="button" aria-label="Play ${item.title}"><div class="album-art" style="background:${artStyle(item)}"><div class="album-symbol">${glyph(item)}</div></div><div class="album-meta"><div><b>${item.title}</b><span>${item.artist}</span></div><button class="album-play" data-action="play" data-id="${item.id}" aria-label="Play ${item.title}">${icon('play')}</button></div></article>`).join('');}
function renderSidebar(){const nav=$('#playlist-nav');nav.innerHTML=state.playlists.length?state.playlists.map(p=>`<button class="playlist-link${state.page==='playlist'&&state.activePlaylist===p.id?' active':''}" data-action="playlist" data-id="${escapeHtml(p.id)}">${icon('music')}<span>${escapeHtml(p.name)}</span></button>`).join(''):'<div class="muted-side">Create a playlist to organize your music.</div>'; $$('.nav-item').forEach(btn=>btn.classList.toggle('active',btn.dataset.page===state.page));}
function renderPage(){
  renderSidebar();
  ['home-panel','search-panel','library-panel','collection-panel','free-panel','community-panel','artist-panel','offline-panel'].forEach(id=>$('#'+id).classList.add('hidden'));
  const breadcrumb={home:'Your listening space',search:'Find your music',free:'Free music',community:'Community releases',artist:'For artists',library:'Your collection',offline:'Offline library',liked:'Your favourites',playlist:'Your playlist'};
  $('#breadcrumb').textContent=breadcrumb[state.page]||breadcrumb.home;
  if(state.page==='home'){
    $('#home-panel').classList.remove('hidden');
    renderFeatured(); renderRows('#recent-list',allItems().slice().reverse().slice(0,6),'Your library is ready','Import audio or save a Spotify link to get started.');
  } else if(state.page==='search'){
    $('#search-panel').classList.remove('hidden');
    const items=searchItems(searchableItems(),state.query);$('#search-count').textContent=`${items.length} result${items.length===1?'':'s'}`;renderRows('#search-results',items,'Nothing matched your search');
  } else if(state.page==='free'){
    $('#free-panel').classList.remove('hidden');
  } else if(state.page==='community'){
    // artist.mjs owns this screen's content; the panel only needs to be on screen.
    $('#community-panel').classList.remove('hidden');
  } else if(state.page==='artist'){
    $('#artist-panel').classList.remove('hidden');
  } else if(state.page==='library'){
    $('#library-panel').classList.remove('hidden');
    const items=allItems();$('#library-count').textContent=`${items.length} saved items`;renderRows('#library-list',items,'No tracks saved');
  } else if(state.page==='offline'){
    $('#offline-panel').classList.remove('hidden');
    const rows=[...state.offline.values()];
    const items=rows.map(row=>row.item||getItem(row.key)).filter(Boolean);
    $('#offline-count').textContent=rows.length
      ?`${items.length} recording${items.length===1?'':'s'} · ${formatBytes(offlineUsed())} of ${formatBytes(offlineCap())} kept on this device`
      :'Nothing saved yet';
    $('#offline-bar').style.width=offlineCap()?Math.min(100,offlineUsed()/offlineCap()*100)+'%':'0%';
    $('#offline-note').textContent=rows.length
      ?'These play with the network switched off. OpenMic keeps a copy only where the recording itself is free to keep - Audius, Openverse, Wikimedia Commons and artist uploads from this server.'
      :'Tap the download arrow on an Audius, Openverse, Wikimedia Commons or artist-upload row, and it will be here when you have no signal.';
    renderRows('#offline-list',items,'No offline recordings yet');
  } else {
    $('#collection-panel').classList.remove('hidden');
    const playlist=state.playlists.find(p=>p.id===state.activePlaylist);
    const likedPage=state.page==='liked';
    const ids=likedPage?[...state.liked]:(playlist?.ids||[]);
    const items=ids.map(getItem).filter(Boolean);
    $('#collection-title').textContent=likedPage?'Liked Songs':playlist?.name||'Playlist';
    $('#collection-icon').textContent=likedPage?'♥':'♫';
    $('#collection-subtitle').textContent=`${items.length} item${items.length===1?'':'s'} · Your personal collection`;
    renderRows('#collection-list',items,'This collection is empty','Tap ♥ or + on a song to save it here.');
  }
  // Last, because every branch above rewrites its rows from scratch: marking the saved
  // copies before the lists exist left an Offline row showing a download arrow.
  syncOfflineButtons();
}
function navigate(page, playlistId){state.page=page;if(playlistId)state.activePlaylist=playlistId;renderPage();$('#main-scroll').scrollTop=0;if(page==='search')$('#search-input').focus();window.dispatchEvent(new CustomEvent('openmic:navigate',{detail:{page}}));}
function updatePlayIcon(){const playing=!audio.paused&&!isEmbed(state.current);$('#toggle-play').innerHTML=icon(playing?'pause':'play');$('#toggle-play').setAttribute('aria-label',playing?'Pause':'Play');}
function updateFooter(){
 const item=state.current;$('#player-title').textContent=item?.title||'Nothing playing yet';$('#player-artist').textContent=item?.artist||'Choose a track';$('#player-cover').textContent=item?glyph(item):'♫';$('#player-cover').style.background=item?artStyle(item):ART[3];
 $('#player-like').disabled=!item;$('#player-like').classList.toggle('liked',!!item&&isLiked(item.id));
 $('#playback-mode').textContent=playbackLabel(item);
 $('#right-title').textContent=item?.title||'Your soundtrack starts here';$('#right-artist').textContent=item?.artist||'Pick something to play';
 $('#right-cover').style.background=item?artStyle(item):ART[3];
 $('#right-cover').querySelector('.right-cover-glyph').textContent=item?glyph(item):'♫';
 $('#elapsed').textContent=item?.live?'LIVE':formatTime(audio.currentTime);$('#duration').textContent=item?.live?'RADIO':formatTime(audio.duration);$('#seek').value=(!item?.live&&Number.isFinite(audio.duration)&&audio.duration>0)?String(Math.round(audio.currentTime/audio.duration*100)):0;
 $('#shuffle').classList.toggle('enabled',state.shuffle);$('#repeat').classList.toggle('enabled',state.repeat!=='off');$('#repeat').title=`Repeat: ${state.repeat}`;
 updatePlayIcon();notifyNextStatus();
}
const SPOTIFY_EMBED={label:'PLAYED BY SPOTIFY',help:'Spotify controls playback in this frame. Free-account limits and ads still apply.',open:'Open on Spotify',title:'Official Spotify embed player'};
const YOUTUBE_EMBED={label:'PLAYED BY YOUTUBE',help:'YouTube controls playback in this frame. Its own ads and account limits apply.',open:'Open on YouTube',title:'Official YouTube embed player'};
function clearEmbed(){const frame=$('#spotify-frame');frame.removeAttribute('src');frame.removeAttribute('data-big');$('#embed-container').classList.add('hidden');$('.rightbar').classList.remove('embed-active');$('#local-info').classList.remove('hidden');}
// One frame, whoever owns the playback. The provider's name, help line and outbound link
// all move with it, so a YouTube embed never keeps Spotify's label on screen.
function showEmbed({watch,embed,big,copy}){const frame=$('#spotify-frame');frame.src=embed;frame.dataset.big=String(big);frame.setAttribute('title',copy.title);$('#embed-label').textContent=copy.label+' ↗';$('#embed-help').textContent=copy.help;$('#spotify-open').href=watch;$('#spotify-open-label').textContent=copy.open;$('#embed-container').classList.remove('hidden');$('.rightbar').classList.add('embed-active');$('#local-info').classList.add('hidden');}
function enableSpotifyFrame(item){const parsed=parseSpotifyUrl(item.url);if(!parsed)return toast('Invalid Spotify link');showEmbed({watch:parsed.url,embed:parsed.embedUrl,big:parsed.kind!=='track',copy:SPOTIFY_EMBED});}
function enableYouTubeFrame(videoId){if(!/^[A-Za-z0-9_-]{11}$/.test(videoId))return toast('YouTube did not return a playable video');showEmbed({watch:'https://www.youtube.com/watch?v='+videoId,embed:'https://www.youtube-nocookie.com/embed/'+videoId+'?autoplay=1&rel=0',big:true,copy:YOUTUBE_EMBED});}
// A YouTube row plays from its id alone; both the frame URL and the outbound link are
// rebuilt here, so a tampered source field can never point the panel at another host.
function enableYouTubeRow(item){const id=String(item?.id||'');return id.startsWith('youtube:')?enableYouTubeFrame(id.slice('youtube:'.length)):toast('This YouTube listing is not playable');}
function releaseAudio(){audio.pause();audio.removeAttribute('src');audio.load();}
// --- the offline library -------------------------------------------------------
// A recording is kept on this device only when its bytes genuinely arrived here: the
// openly licensed catalogs and the artist uploads this server hosts. Embed rows play
// inside the provider's own frame and radio is a live broadcast, so there is no file to
// keep and the row gets no save control at all.
function offlineCap(){
  const stored=Number(readJSON('offline-cap',0));
  return stored>=20*1024*1024?stored:DEFAULT_CAP_BYTES;
}
function offlineUsed(){let sum=0;for(const row of state.offline.values())sum+=Number(row.bytes)||0;return sum;}
function protectedId(id){return state.liked.has(id)||state.playlists.some(p=>p.ids.includes(id))||state.offline.has(id);}
function offlineMarkup(item){
  if(!canCache(item))return '<span class="row-slot" aria-hidden="true"></span>';
  return offlineCell(escapeHtml(item.id),escapeHtml(item.title));
}
// The rows are drawn by three different screens, so they all render the same static
// control and this is the only place that knows which copies are actually on disk.
function syncOfflineButtons(){
  document.querySelectorAll('[data-action="offline"]').forEach(button=>{
    const saved=state.offline.has(button.dataset.id);
    button.classList.toggle('saved',saved);
    button.title=saved?'Offline copy on this device - tap to remove':'Save offline - plays with no internet';
  });
}
async function loadOfflineLibrary(){
  try{offlineDb=await openLibrary();}catch(error){console.warn('Offline storage unavailable',error);return;}
  const rows=await listSaved(offlineDb);
  for(const row of rows){
    const item=reviveSaved(row.item);
    // A copy whose row no longer revives is audio nobody can reach or play; drop it rather
    // than keep paying for bytes with no listing to open them from.
    if(!item){dropSaved(offlineDb,[row.key]).catch(()=>{});continue;}
    state.offline.set(row.key,{...row,item});
    if(!state.online.some(t=>t.id===item.id))state.online.push({...item,art:item.art??6});
  }
  renderPage();updateFooter();
}
async function saveOffline(item){
  if(state.saving.has(item.id))return;
  state.saving.add(item.id);
  try{
    const blob=await fetchAudio(item);
    const plan=planEviction([...state.offline.values()],blob.size,offlineCap(),[item.id,state.current?.id]);
    if(!plan.ok)throw new Error(plan.reason==='too-big'
      ?'That recording is larger than the whole offline library.'
      :'No room left. Remove an offline copy and try again.');
    if(plan.drop.length){
      await dropSaved(offlineDb,plan.drop);
      for(const key of plan.drop)forgetOfflineCopy(key);
      toast('Made room by dropping '+plan.drop.length+' least-listened '+(plan.drop.length===1?'copy':'copies'));
    }
    // A browser drops ordinary storage when the disk fills up, which would undo exactly
    // what the listener asked for, so the first write asks for persisted storage.
    await requestPersistence();
    const record=buildRecord(item,blob);
    if(!record)throw new Error('This recording cannot be saved offline.');
    record.blob=blob;
    await saveSaved(offlineDb,record);
    const{blob:_drop,...meta}=record;
    state.offline.set(meta.key,meta);
    toast('Saved '+formatBytes(blob.size)+' on this device. It plays without internet.');
  }catch(error){
    toast(String(error?.message||error));
  }finally{
    state.saving.delete(item.id);
    renderPage();syncOfflineButtons();
  }
}
function forgetOfflineCopy(id){
  state.offline.delete(id);
  // Keep the object URL of whatever is playing: revoking mid-playback cuts the audio off
  // for a copy the listener only asked to delete from the list.
  if(state.current?.id!==id){
    const url=state.objectUrls.get(id);
    if(url){URL.revokeObjectURL(url);state.objectUrls.delete(id);}
  }
}
async function removeOffline(id){
  await dropSaved(offlineDb,[id]);
  forgetOfflineCopy(id);
  renderPage();syncOfflineButtons();
  if(state.page==='offline')updateFooter();
  toast('Offline copy removed from this device');
}
async function toggleOffline(id){
  const item=getItem(id);
  if(!item)return toast('Track not found');
  if(state.offline.has(id))return removeOffline(id);
  if(!canCache(item))return toast('This listing plays in the provider\'s own player, so there is no file here to keep.');
  if(!navigator.onLine)return toast('You are offline right now, so there is nothing to download yet.');
  // The button lives in whichever list the listener clicked, so it is marked here rather
  // than rebuilt by a re-render of the whole screen.
  const button=document.querySelector('[data-action="offline"][data-id="'+CSS.escape(id)+'"]');
  if(button){button.classList.add('busy');button.disabled=true;}
  await saveOffline(item);
  if(button){button.classList.remove('busy');button.disabled=false;}
}
// Cached first: a copy on disk is the point of the library, so it wins over the stream
// even when the network is up and healthy.
async function resolveSource(item){
  if(item.kind==='demo')return demoSource(item);
  if(state.offline.has(item.id)){
    if(!state.objectUrls.has(item.id)){
      const blob=await readSavedAudio(offlineDb,item.id).catch(()=>null);
      if(blob)state.objectUrls.set(item.id,URL.createObjectURL(blob));
      else{state.offline.delete(item.id);toast('That offline copy is missing, so it will stream again.');}
    }
    if(state.objectUrls.has(item.id)){
      touchSaved(offlineDb,item.id).catch(()=>{});
      state.playingOffline=true;
      return state.objectUrls.get(item.id);
    }
  }
  state.playingOffline=false;
  return item.source||state.objectUrls.get(item.id);
}
function registerServiceWorker(){
  // The shell has to load offline for a saved recording to be listenable offline.
  if(!('serviceWorker'in navigator)||!location.protocol.startsWith('http'))return;
  navigator.serviceWorker.register('./sw.js').catch(()=>{});
}
let playlistTarget=null;
function renderPlaylistOptions(){
  const box=$('#playlist-options');
  box.innerHTML=state.playlists.length
    ? state.playlists.map((p,i)=>`<label><input type="radio" name="playlist-choice" value="${escapeHtml(p.id)}"${i===0?' checked':''}><span>${escapeHtml(p.name)}</span></label>`).join('')
    : '<p class="playlist-empty">No playlists yet. Name the new one below.</p>';
}
function openPlaylistDialog(trackId){
  playlistTarget=trackId||null;
  $('#playlist-heading').textContent=trackId?'Add to a playlist':'New playlist';
  $('#playlist-save').textContent=trackId?'Add':'Create';
  $('#playlist-hint').textContent=trackId?`Adding “${getItem(trackId)?.title||'this track'}”.`:'Name it, then add songs to it any time.';
  renderPlaylistOptions();
  $('#playlist-new').value='';
  $('#playlist-error').textContent='';
  $('#playlist-dialog').showModal();
  (state.playlists.length?$('#playlist-save'):$('#playlist-new')).focus();
}
function savePlaylistChoice(){
  const name=$('#playlist-new').value.trim().slice(0,60);
  const chosen=$('input[name="playlist-choice"]:checked')?.value;
  if(!name&&!chosen){$('#playlist-error').textContent=state.playlists.length?'Pick a playlist, or name a new one.':'Give the new playlist a name.';return;}
  if(name){
    const playlist={id:`list:${crypto.randomUUID()}`,name,ids:playlistTarget?[playlistTarget]:[]};
    state.playlists.push(playlist);
    persist();$('#playlist-dialog').close();renderPage();
    if(playlistTarget) toast(`Created ${name} and added it`);
    else navigate('playlist',playlist.id);
    return;
  }
  if(!playlistTarget){$('#playlist-dialog').close();navigate('playlist',chosen);return;}
  const playlist=state.playlists.find(p=>p.id===chosen);
  if(!playlist)return;
  if(playlist.ids.includes(playlistTarget)){$('#playlist-dialog').close();toast(`Already in ${playlist.name}`);return;}
  playlist.ids.push(playlistTarget);
  persist();$('#playlist-dialog').close();renderPage();toast(`Added to ${playlist.name}`);
}
async function removeItem(id){
  const item=getItem(id);
  if(!item||!removableKind(item.kind))return;
  const detail=item.kind==='local'
    ? `“${item.title}” will be deleted from this browser, along with its audio data.`
    : `“${item.title}” will no longer be in your library. Nothing is removed from Spotify.`;
  if(!await askConfirm(item.kind==='local'?'Delete uploaded audio?':'Remove Spotify link?',detail,item.kind==='local'?'Delete':'Remove'))return;
  if(item.kind==='local'){
    const url=state.objectUrls.get(id);
    if(url)URL.revokeObjectURL(url);
    state.objectUrls.delete(id);
    fingerprints.delete(item.fp);
    dbDelete(id).catch(()=>{});
  }
  state.tracks=state.tracks.filter(t=>t.id!==id);
  state.links=state.links.filter(t=>t.id!==id);
  state.liked.delete(id);
  for(const playlist of state.playlists)playlist.ids=playlist.ids.filter(x=>x!==id);
  const wasCurrent=state.current?.id===id;
  const position=state.queue.indexOf(id);
  state.queue=state.queue.filter(x=>x!==id);
  if(position>-1&&position<=state.queueIndex)state.queueIndex=Math.max(0,state.queueIndex-1);
  if(wasCurrent){state.current=null;releaseAudio();clearEmbed();}
  persist();renderPage();updateFooter();
  toast(item.kind==='local'?'Audio file deleted':'Spotify link removed');
}
// A liked artist upload can be taken down while the listener is away. The media element
// only says "load failed", so ask our own server whether it is gone for good instead of
// inviting the user to press Play again on a permanent 404.
async function reportPlayFailure(item,error){
  if(error?.name==='NotAllowedError')return toast('The browser blocked autoplay. Press Play to start.');
  if(item.kind==='community'&&item.source){
    try {
      const probe=await fetch(item.source,{method:'HEAD',credentials:'same-origin'});
      if(probe.status===404||probe.status===410){
        forgetTrack(item.id);
        return toast('That upload was removed from OpenMic, so it is off your list too.');
      }
    } catch { /* no answer: fall through to the generic wording */ }
  }
  toast('This stream is offline or unsupported in this browser. Try another track or station.');
}
// Drop an id everywhere the listener could still reach it.
function forgetTrack(id){
  state.liked.delete(id);
  for(const playlist of state.playlists)playlist.ids=playlist.ids.filter(x=>x!==id);
  state.online=state.online.filter(t=>t.id!==id);
  state.queue=state.queue.filter(x=>x!==id);
  // A takedown ends the listener's right to play it, so the copy on this device goes too.
  if(state.offline.has(id)){dropSaved(offlineDb,[id]).catch(()=>{});forgetOfflineCopy(id);}
  if(state.current?.id===id){state.current=null;releaseAudio();clearEmbed();}
  persist();renderPage();updateFooter();
}
async function playItem(id, queueIds){const item=getItem(id);if(!item)return toast('Track not found');if(Array.isArray(queueIds)){state.queue=queueIds.filter(x=>getItem(x));state.queueIndex=Math.max(0,state.queue.indexOf(id));}else if(!state.queue.includes(id)){state.queue=allItems().filter(t=>!isEmbed(t)).map(t=>t.id);if(!state.queue.includes(id))state.queue=[id,...state.queue];state.queueIndex=state.queue.indexOf(id);}else state.queueIndex=state.queue.indexOf(id);
  if(state.current?.id===id&&!isEmbed(item)){if(audio.paused){try{await audio.play();}catch{toast('Could not play this audio file');}}else audio.pause();updateFooter();return;}
  state.current=item;
  if(item.kind==='spotify'){releaseAudio();enableSpotifyFrame(item);toast('Official Spotify player opened');}
  else if(item.kind==='youtube'){releaseAudio();enableYouTubeRow(item);toast('Official YouTube player opened');}
  else{clearEmbed();releaseAudio();const source=await resolveSource(item);if(!source){toast('Audio missing. Please import this file again.');return;}audio.src=source;try{await audio.play();}catch(error){await reportPlayFailure(item,error);}}
  updateFooter();renderPage();syncOfflineButtons();
}
function step(direction){if(!state.queue.length)return;let index;if(direction===-1){index=state.queueIndex>0?state.queueIndex-1:state.repeat==='all'?state.queue.length-1:-1;}else{index=nextIndex(state.queueIndex,state.queue.length,{repeat:state.repeat,shuffle:state.shuffle});}if(index<0){audio.pause();audio.currentTime=0;updateFooter();return;}state.queueIndex=index;playItem(state.queue[index],state.queue);}
function toggleLike(id){if(!getItem(id))return;state.liked.has(id)?state.liked.delete(id):state.liked.add(id);persist();document.querySelectorAll('#free-results [data-action="like"]').forEach(button=>{if(button.dataset.id===id)button.classList.toggle('liked',state.liked.has(id));});renderPage();updateFooter();}
function addToPlaylist(id){if(getItem(id))openPlaylistDialog(id);}
// Apple's rows stream a 30-second clip, so the full listen is handed to YouTube. The key
// stays on the server; a 501 here would mean the row rendered the wrong tier.
function openFullTrack(button){
  const lookup=String(button.dataset.query||'').trim().slice(0,120);
  if(!lookup)return toast('Nothing to look for');
  button.disabled=true;
  // Two players at once would talk over each other, so the 30-second preview stops
  // before the full recording starts.
  audio.pause();
  updateFooter();
  communityApi.fullTrack(lookup)
    .then(found=>{enableYouTubeFrame(found.videoId);toast('Full recording playing from YouTube');})
    .catch(error=>toast(error?.status===404?'YouTube has no official video for that recording.':error.message))
    .finally(()=>{button.disabled=false;});
}
function createPlaylist(){openPlaylistDialog(null);}
function openSpotifyDialog(){$('#spotify-form').reset();$('#modal-error').textContent='';$('#spotify-dialog').showModal();$('#spotify-url').focus();}
function saveSpotifyLink(event){event.preventDefault();const parsed=parseSpotifyUrl($('#spotify-url').value);if(!parsed){$('#modal-error').textContent='Please enter a valid open.spotify.com URL or spotify: URI.';return;}const existing=state.links.find(link=>link.id===parsed.id);if(existing){$('#spotify-dialog').close();playItem(existing.id);navigate('library');return;}const title=$('#spotify-name').value.trim().slice(0,100)||`Spotify ${parsed.kind} · ${parsed.spotifyId.slice(0,8)}`;const item={...parsed,title,artist:'Spotify · Official embed',kind:'spotify',spotifyKind:parsed.kind,art:4};state.links.unshift(item);persist();$('#spotify-dialog').close();navigate('library');playItem(item.id);toast('Spotify link saved');}
function fileFingerprint(file){return [file.name,file.size,file.lastModified||0].join(':');}
async function importFiles(files){const valid=[...files].filter(safeFile);if(!valid.length){toast('No supported audio files (max 200 MB per file)');return;}let added=0,dupes=0;for(const file of valid){const fp=fileFingerprint(file);if(fingerprints.has(fp)){dupes++;continue;}const id=`local:${crypto.randomUUID()}`;const item={id,title:file.name.replace(/\.[^.]+$/,'').replace(/[_-]/g,' ').trim()||file.name,artist:'Your local files',kind:'local',art:3,fp};fingerprints.add(fp);const url=URL.createObjectURL(file);state.objectUrls.set(id,url);state.tracks.push(item);try{await dbPut({id,item,file});}catch{ /* Playback still works for this session. */ }added++;}navigate('library');toast(added?`${added} audio file${added===1?'':'s'} added${dupes?` · ${dupes} already in your library`:''}`:(dupes?`Already in your library (${dupes} duplicate${dupes===1?'':'s'})`:'Nothing added'));$('#file-input').value='';}
function events(){
  // artist.mjs owns the studio and community screens; these two events let it speak to
  // the player without importing this module's internals.
  window.addEventListener('openmic:toast', event => toast(String(event.detail || '')));
  window.addEventListener('openmic:goto', event => { if (typeof event.detail === 'string') navigate(event.detail); });
  // A takedown removes the recording from the server, so the listener's saved copy has
  // to go too - otherwise Liked Songs keeps a row that 404s forever.
  window.addEventListener('openmic:forget', event => {
    const id = String(event.detail || '');
    if (id) forgetTrack(id);
  });
  window.addEventListener('openmic:register-online', event => {
    if (!Array.isArray(event.detail)) return;
    const tracks = new Map(state.online.map(item => [item.id,item]));
    for (const item of event.detail.slice(0, 150)) {
      let safe=null;
      if(item?.kind==='audius' && /^audius:[A-Za-z0-9_-]{2,80}$/.test(item.id)) safe=reviveFreeTrack(item);
      else if(item?.kind==='community') safe=reviveCommunity(item);
      else safe=reviveMultiTrack(item);
      if(safe) tracks.set(safe.id,{...safe,art:item.art});
    }
    const protectedIds=new Set([...state.liked,...state.playlists.flatMap(p=>p.ids),...state.offline.keys()]);
    const keep=[...tracks.values()];
    state.online = keep.filter(t=>protectedIds.has(t.id)).concat(keep.filter(t=>!protectedIds.has(t.id)).slice(-360));
  });
  document.addEventListener('click',event=>{
    const click=event.target.closest('[data-action]');if(click){const {action,id}=click.dataset;if(action==='play'){const collection=click.closest('.track-list');const ids=collection?[...collection.querySelectorAll('.track-item')].map(row=>row.dataset.id):DEMOS.map(t=>t.id);playItem(id,ids);return;}if(action==='like')return toggleLike(id);if(action==='add')return addToPlaylist(id);if(action==='full-track')return openFullTrack(click);if(action==='offline')return toggleOffline(id);if(action==='remove')return removeItem(id);if(action==='playlist')return navigate('playlist',id);}
    const nav=event.target.closest('[data-page]');if(nav)navigate(nav.dataset.page);
  });
  $('#brand-home').addEventListener('click',()=>navigate('home'));
  ['upload-songs','hero-upload','library-upload'].forEach(id=>$('#'+id).addEventListener('click',()=>$('#file-input').click()));
  $('#file-input').addEventListener('change',event=>importFiles(event.target.files));
  ['add-spotify','hero-spotify','library-spotify'].forEach(id=>$('#'+id).addEventListener('click',openSpotifyDialog));
  $('#spotify-form').addEventListener('submit',saveSpotifyLink);
  $('#close-dialog').addEventListener('click',()=>$('#spotify-dialog').close());
  $('#cancel-dialog').addEventListener('click',()=>$('#spotify-dialog').close());
  $('#create-playlist').addEventListener('click',createPlaylist);
  $('#playlist-close').addEventListener('click',()=>$('#playlist-dialog').close());
  $('#playlist-cancel').addEventListener('click',()=>$('#playlist-dialog').close());
  $('#playlist-save').addEventListener('click',savePlaylistChoice);
  $('#playlist-new').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();savePlaylistChoice();}});
  $('#search-input').addEventListener('input',event=>{state.query=event.target.value;renderPage();$('#search-input').focus();$('#search-input').setSelectionRange(state.query.length,state.query.length);});
  $('#toggle-play').addEventListener('click',async()=>{if(!state.current){return playItem(DEMOS[0].id,DEMOS.map(item=>item.id));}if(audio.paused){try{await audio.play();}catch{toast('Could not play this track');}}else audio.pause();updateFooter();});
  $('#next').addEventListener('click',()=>step(1));$('#prev').addEventListener('click',()=>{if(audio.currentTime>3){audio.currentTime=0;return;}step(-1);});
  $('#player-like').addEventListener('click',()=>state.current&&toggleLike(state.current.id));
  $('#shuffle').addEventListener('click',()=>{state.shuffle=!state.shuffle;updateFooter();});
  $('#repeat').addEventListener('click',()=>{const modes=['off','all','one'];state.repeat=modes[(modes.indexOf(state.repeat)+1)%3];updateFooter();toast(`Repeat: ${state.repeat}`);});
  $('#volume').addEventListener('input',event=>audio.volume=Number(event.target.value)/100);
  $('#seek').addEventListener('input',event=>{if(!state.current?.live && Number.isFinite(audio.duration))audio.currentTime=Number(event.target.value)/100*audio.duration;});
  audio.addEventListener('timeupdate',updateFooter);audio.addEventListener('durationchange',updateFooter);audio.addEventListener('play',updateFooter);audio.addEventListener('pause',updateFooter);audio.addEventListener('ended',()=>step(1));audio.addEventListener('error',()=>{if(!isEmbed(state.current))toast('Stream unavailable or not supported in this browser. Try another track or station.');});
  document.addEventListener('keydown',event=>{const node=event.target.closest('.album-card');if(node&&(event.key==='Enter'||event.key===' ')){event.preventDefault();playItem(node.dataset.id,DEMOS.map(t=>t.id));}});
  // Free Music and Community draw their own rows and neither one knows what is on disk, so
  // watching those two lists beats making every screen ask for the offline state.
  if('MutationObserver' in window){
    const offlineObserver=new MutationObserver(()=>syncOfflineButtons());
    for(const list of ['#free-results','#community-results']){const node=$(list);if(node)offlineObserver.observe(node,{childList:true,subtree:true});}
  }
  let dragDepth=0;window.addEventListener('dragenter',event=>{event.preventDefault();dragDepth++;document.body.classList.add('drop-active');});window.addEventListener('dragleave',event=>{event.preventDefault();dragDepth=Math.max(0,dragDepth-1);if(dragDepth===0)document.body.classList.remove('drop-active');});window.addEventListener('dragover',event=>event.preventDefault());window.addEventListener('drop',event=>{event.preventDefault();dragDepth=0;document.body.classList.remove('drop-active');if(event.dataTransfer?.files.length)importFiles(event.dataTransfer.files);});
  window.addEventListener('beforeunload',()=>{for(const url of state.objectUrls.values())URL.revokeObjectURL(url);});
}
async function init(){
  state.links=sanitizeLinks(readJSON('links',[]));
  state.online=(Array.isArray(readJSON('online',[])) ? readJSON('online',[]) : []).map(reviveSaved).filter(Boolean).slice(-300);
  state.liked=new Set(readJSON('liked',[]).filter(id=>typeof id==='string'));
  state.playlists=readJSON('playlists',[]).filter(isValidPlaylist).slice(0,100).map(p=>({id:p.id,name:p.name.slice(0,60),ids:p.ids.filter(id=>typeof id==='string')}));
  try{db=await openDB();const rows=await dbAll();for(const record of rows){if(!record?.file||!record?.item?.id)continue;if(record.item.fp)fingerprints.add(record.item.fp);state.tracks.push(record.item);state.objectUrls.set(record.item.id,URL.createObjectURL(record.file));}}catch(error){console.warn('Browser database unavailable',error);}
  state.queue=state.tracks.map(track=>track.id);audio.volume=.75;events();renderPage();updateFooter();
  loadOfflineLibrary().catch(error=>console.warn('Offline library unavailable',error));
  registerServiceWorker();
}
init();