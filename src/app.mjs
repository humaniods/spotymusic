import { parseSpotifyUrl, formatTime, nextIndex, searchItems, escapeHtml, safeFile } from './core.mjs';
import { makeDemo } from './demo-audio.mjs';

const DEMOS = [
  {id:'demo:golden-hour',title:'Golden Hour',artist:'SpotBridge Sessions',source:makeDemo(0),kind:'demo',art:0},
  {id:'demo:night-drive',title:'Night Drive',artist:'SpotBridge Sessions',source:makeDemo(1),kind:'demo',art:1},
  {id:'demo:slow-motion',title:'Slow Motion',artist:'SpotBridge Sessions',source:makeDemo(2),kind:'demo',art:2}
];
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
const state = {tracks:[...DEMOS],links:[],liked:new Set(),playlists:[],page:'home',activePlaylist:null,current:null,queue:[],queueIndex:0,repeat:'off',shuffle:false,query:'',objectUrls:new Map()};
let db = null, toastTimer;

function readJSON(key, fallback) {
  try {const value = JSON.parse(localStorage.getItem(`spotbridge:v1:${key}`));return value ?? fallback;}catch{return fallback;}
}
function persist() {
  try {
    localStorage.setItem('spotbridge:v1:links',JSON.stringify(state.links));
    localStorage.setItem('spotbridge:v1:liked',JSON.stringify([...state.liked]));
    localStorage.setItem('spotbridge:v1:playlists',JSON.stringify(state.playlists));
  } catch { toast('Storage unavailable; changes may not persist'); }
}
function openDB() {
  return new Promise((resolve,reject)=>{
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    const request=indexedDB.open('spotbridge-music',1);
    request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('audio'))request.result.createObjectStore('audio',{keyPath:'id'});};
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
function dbPut(record){return new Promise((resolve,reject)=>{if(!db)return reject(new Error('No database'));const tx=db.transaction('audio','readwrite');tx.objectStore('audio').put(record);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
function dbAll(){return new Promise((resolve,reject)=>{if(!db)return resolve([]);const req=db.transaction('audio').objectStore('audio').getAll();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
function sanitizeLinks(links){return Array.isArray(links)?links.filter(entry=>parseSpotifyUrl(entry?.url)).slice(0,1000).map(entry=>({...parseSpotifyUrl(entry.url),title:String(entry.title||'Spotify '+entry.kind).slice(0,100),artist:'Spotify · Official embed',kind:'spotify',spotifyKind:parseSpotifyUrl(entry.url).kind,art:4})):[];}
function isValidPlaylist(value){return value&&typeof value.name==='string'&&Array.isArray(value.ids)&&typeof value.id==='string';}
function allItems(){return [...state.tracks,...state.links];}
function getItem(id){return allItems().find(t=>t.id===id);}
function isLiked(id){return state.liked.has(id);}
function notifyNextStatus(){const controls=$$('.transport-buttons button:not(#toggle-play)');controls.forEach(btn=>btn.disabled=state.current?.kind==='spotify');$('#toggle-play').disabled=state.current?.kind==='spotify';$('#seek').disabled=state.current?.kind==='spotify';$('#volume').disabled=state.current?.kind==='spotify';}
function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),2900);}
function artStyle(item){return ART[Number.isInteger(item?.art)?item.art%ART.length:3];}
function glyph(item){return item?.kind==='spotify'?'◉':item?.kind==='demo'?'♫':'♪';}
function icon(name){return `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;}
function likedClass(item){return isLiked(item.id)?' liked':'';}
function itemRow(item,index){const active=item.id===state.current?.id;return `<div class="track-item${active?' selected':''}" data-id="${escapeHtml(item.id)}"><button class="row-play" data-action="play" data-id="${escapeHtml(item.id)}" aria-label="Play ${escapeHtml(item.title)}">${icon('play')}</button><div class="track-cover" style="background:${artStyle(item)}"><span>${glyph(item)}</span></div><div style="min-width:0"><div class="track-title">${escapeHtml(item.title)}</div><div class="track-artist">${escapeHtml(item.artist)}</div></div><div class="track-kind">${item.kind==='spotify'?`SPOTIFY ${escapeHtml(item.spotifyKind).toUpperCase()}`:item.kind==='demo'?'ORIGINAL DEMO':'LOCAL AUDIO'}</div><button class="icon-button row-like${likedClass(item)}" data-action="like" data-id="${escapeHtml(item.id)}" title="Like" aria-label="Like ${escapeHtml(item.title)}">${icon('heart')}</button><button class="icon-button row-add" data-action="add" data-id="${escapeHtml(item.id)}" title="Add to playlist" aria-label="Add ${escapeHtml(item.title)} to playlist">${icon('plus')}</button></div>`;}
function empty(text,sub='Use the buttons above to add something.'){return `<div class="empty-state"><b>${escapeHtml(text)}</b>${escapeHtml(sub)}</div>`;}
function renderRows(selector,items,emptyMsg='No items yet'){const container=$(selector);container.innerHTML=items.length?items.map(itemRow).join(''):empty(emptyMsg);}
function renderFeatured(){ $('#featured-grid').innerHTML=DEMOS.map(item=>`<article class="album-card" data-action="play" data-id="${item.id}" tabindex="0" role="button" aria-label="Play ${item.title}"><div class="album-art" style="background:${artStyle(item)}"><div class="album-symbol">${glyph(item)}</div></div><div class="album-meta"><div><b>${item.title}</b><span>${item.artist}</span></div><button class="album-play" data-action="play" data-id="${item.id}" aria-label="Play ${item.title}">${icon('play')}</button></div></article>`).join('');}
function renderSidebar(){const nav=$('#playlist-nav');nav.innerHTML=state.playlists.length?state.playlists.map(p=>`<button class="playlist-link${state.page==='playlist'&&state.activePlaylist===p.id?' active':''}" data-action="playlist" data-id="${escapeHtml(p.id)}">${icon('music')}<span>${escapeHtml(p.name)}</span></button>`).join(''):'<div class="muted-side">Create a playlist to organize your music.</div>'; $$('.nav-item').forEach(btn=>btn.classList.toggle('active',btn.dataset.page===state.page));}
function renderPage(){
  renderSidebar();
  ['home-panel','search-panel','library-panel','collection-panel'].forEach(id=>$('#'+id).classList.add('hidden'));
  const breadcrumb={home:'Your listening space',search:'Find your music',library:'Your collection',liked:'Your favourites',playlist:'Your playlist'};
  $('#breadcrumb').textContent=breadcrumb[state.page]||breadcrumb.home;
  if(state.page==='home'){
    $('#home-panel').classList.remove('hidden');
    renderFeatured(); renderRows('#recent-list',allItems().slice().reverse().slice(0,6),'Your library is ready','Import audio or save a Spotify link to get started.');
  } else if(state.page==='search'){
    $('#search-panel').classList.remove('hidden');
    const items=searchItems(allItems(),state.query);$('#search-count').textContent=`${items.length} result${items.length===1?'':'s'}`;renderRows('#search-results',items,'Nothing matched your search');
  } else if(state.page==='library'){
    $('#library-panel').classList.remove('hidden');
    const items=allItems();$('#library-count').textContent=`${items.length} saved items`;renderRows('#library-list',items,'No tracks saved');
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
}
function navigate(page, playlistId){state.page=page;if(playlistId)state.activePlaylist=playlistId;renderPage();$('#main-scroll').scrollTop=0;if(page==='search')$('#search-input').focus();}
function updatePlayIcon(){const playing=!audio.paused&&state.current?.kind!=='spotify';$('#toggle-play').innerHTML=icon(playing?'pause':'play');$('#toggle-play').setAttribute('aria-label',playing?'Pause':'Play');}
function updateFooter(){
 const item=state.current;$('#player-title').textContent=item?.title||'Nothing playing yet';$('#player-artist').textContent=item?.artist||'Choose a track';$('#player-cover').textContent=item?glyph(item):'♫';$('#player-cover').style.background=item?artStyle(item):ART[3];
 $('#player-like').disabled=!item;$('#player-like').classList.toggle('liked',!!item&&isLiked(item.id));
 $('#playback-mode').textContent=item?.kind==='spotify'?'SPOTIFY EMBED':'LOCAL PLAYER';
 $('#right-title').textContent=item?.title||'Your soundtrack starts here';$('#right-artist').textContent=item?.artist||'Pick something to play';
 $('#right-cover').style.background=item?artStyle(item):ART[3];
 $('#right-cover').querySelector('.right-cover-glyph').textContent=item?glyph(item):'♫';
 $('#elapsed').textContent=formatTime(audio.currentTime);$('#duration').textContent=formatTime(audio.duration);$('#seek').value=Number.isFinite(audio.duration)&&audio.duration>0?String(Math.round(audio.currentTime/audio.duration*100)):0;
 $('#shuffle').classList.toggle('enabled',state.shuffle);$('#repeat').classList.toggle('enabled',state.repeat!=='off');$('#repeat').title=`Repeat: ${state.repeat}`;
 updatePlayIcon();notifyNextStatus();
}
function clearSpotifyFrame(){const frame=$('#spotify-frame');frame.removeAttribute('src');frame.removeAttribute('data-big');$('#embed-container').classList.add('hidden');$('.rightbar').classList.remove('embed-active');$('#local-info').classList.remove('hidden');}
function enableSpotifyFrame(item){const parsed=parseSpotifyUrl(item.url);if(!parsed)return toast('Invalid Spotify link');const frame=$('#spotify-frame');frame.src=parsed.embedUrl;frame.dataset.big=parsed.kind==='track'?'false':'true';$('#spotify-open').href=parsed.url;$('#embed-container').classList.remove('hidden');$('.rightbar').classList.add('embed-active');$('#local-info').classList.add('hidden');}
function releaseAudio(){audio.pause();audio.removeAttribute('src');audio.load();}
async function playItem(id, queueIds){const item=getItem(id);if(!item)return toast('Track not found');if(Array.isArray(queueIds)){state.queue=queueIds.filter(x=>getItem(x));state.queueIndex=Math.max(0,state.queue.indexOf(id));}else if(!state.queue.includes(id)){state.queue=allItems().filter(t=>t.kind!=='spotify').map(t=>t.id);if(!state.queue.includes(id))state.queue=[id,...state.queue];state.queueIndex=state.queue.indexOf(id);}else state.queueIndex=state.queue.indexOf(id);
  if(state.current?.id===id&&item.kind!=='spotify'){if(audio.paused){try{await audio.play();}catch{toast('Could not play this audio file');}}else audio.pause();updateFooter();return;}
  state.current=item;
  if(item.kind==='spotify'){releaseAudio();enableSpotifyFrame(item);toast('Official Spotify player opened');}
  else{clearSpotifyFrame();releaseAudio();const source=item.source||state.objectUrls.get(item.id);if(!source){toast('Audio missing. Please import this file again.');return;}audio.src=source;try{await audio.play();}catch(error){toast('Playback blocked or unsupported audio. Press Play again.');}}
  updateFooter();renderPage();
}
function step(direction){if(!state.queue.length)return;let index;if(direction===-1){index=state.queueIndex>0?state.queueIndex-1:state.repeat==='all'?state.queue.length-1:-1;}else{index=nextIndex(state.queueIndex,state.queue.length,{repeat:state.repeat,shuffle:state.shuffle});}if(index<0){audio.pause();audio.currentTime=0;updateFooter();return;}state.queueIndex=index;playItem(state.queue[index],state.queue);}
function toggleLike(id){if(!getItem(id))return;state.liked.has(id)?state.liked.delete(id):state.liked.add(id);persist();renderPage();updateFooter();}
function addToPlaylist(id){const item=getItem(id);if(!item)return; if(!state.playlists.length){const name=prompt('No playlists yet. Name your first playlist:');if(!name?.trim())return;state.playlists.push({id:`list:${crypto.randomUUID()}`,name:name.trim().slice(0,60),ids:[]});}
const labels=state.playlists.map((p,i)=>`${i+1}. ${p.name}`).join('\n');const answer=prompt(`Choose playlist by number:\n${labels}`,'1');if(answer===null)return;const index=Number(answer)-1;const playlist=state.playlists[index];if(!playlist){toast('Invalid playlist number');return;}if(playlist.ids.includes(id)){toast('Already in playlist');return;}playlist.ids.push(id);persist();renderPage();toast(`Added to ${playlist.name}`);}
function createPlaylist(){const name=prompt('Give your playlist a name:');if(!name?.trim())return;const playlist={id:`list:${crypto.randomUUID()}`,name:name.trim().slice(0,60),ids:[]};state.playlists.push(playlist);persist();navigate('playlist',playlist.id);toast('Playlist created');}
function openSpotifyDialog(){$('#spotify-form').reset();$('#modal-error').textContent='';$('#spotify-dialog').showModal();$('#spotify-url').focus();}
function saveSpotifyLink(event){event.preventDefault();const parsed=parseSpotifyUrl($('#spotify-url').value);if(!parsed){$('#modal-error').textContent='Please enter a valid open.spotify.com URL or spotify: URI.';return;}const existing=state.links.find(link=>link.id===parsed.id);if(existing){$('#spotify-dialog').close();playItem(existing.id);navigate('library');return;}const title=$('#spotify-name').value.trim().slice(0,100)||`Spotify ${parsed.kind} · ${parsed.spotifyId.slice(0,8)}`;const item={...parsed,title,artist:'Spotify · Official embed',kind:'spotify',spotifyKind:parsed.kind,art:4};state.links.unshift(item);persist();$('#spotify-dialog').close();navigate('library');playItem(item.id);toast('Spotify link saved');}
async function importFiles(files){const valid=[...files].filter(safeFile);if(!valid.length){toast('No supported audio files (max 200 MB per file)');return;}let added=0;for(const file of valid){const id=`local:${crypto.randomUUID()}`;const item={id,title:file.name.replace(/\.[^.]+$/,'').replace(/[_-]/g,' ').trim()||file.name,artist:'Your local files',kind:'local',art:3};const url=URL.createObjectURL(file);state.objectUrls.set(id,url);state.tracks.push(item);try{await dbPut({id,item,file});}catch{ /* Playback still works for this session. */ }added++;}navigate('library');toast(`${added} audio file${added===1?'':'s'} added`);$('#file-input').value='';}
function events(){
  document.addEventListener('click',event=>{
    const click=event.target.closest('[data-action]');if(click){const {action,id}=click.dataset;if(action==='play'){const collection=click.closest('.track-list');const ids=collection?[...collection.querySelectorAll('.track-item')].map(row=>row.dataset.id):DEMOS.map(t=>t.id);playItem(id,ids);return;}if(action==='like')return toggleLike(id);if(action==='add')return addToPlaylist(id);if(action==='playlist')return navigate('playlist',id);}
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
  $('#search-input').addEventListener('input',event=>{state.query=event.target.value;renderPage();$('#search-input').focus();$('#search-input').setSelectionRange(state.query.length,state.query.length);});
  $('#toggle-play').addEventListener('click',async()=>{if(!state.current){return playItem(DEMOS[0].id,DEMOS.map(item=>item.id));}if(audio.paused){try{await audio.play();}catch{toast('Could not play this track');}}else audio.pause();updateFooter();});
  $('#next').addEventListener('click',()=>step(1));$('#prev').addEventListener('click',()=>{if(audio.currentTime>3){audio.currentTime=0;return;}step(-1);});
  $('#player-like').addEventListener('click',()=>state.current&&toggleLike(state.current.id));
  $('#shuffle').addEventListener('click',()=>{state.shuffle=!state.shuffle;updateFooter();});
  $('#repeat').addEventListener('click',()=>{const modes=['off','all','one'];state.repeat=modes[(modes.indexOf(state.repeat)+1)%3];updateFooter();toast(`Repeat: ${state.repeat}`);});
  $('#volume').addEventListener('input',event=>audio.volume=Number(event.target.value)/100);
  $('#seek').addEventListener('input',event=>{if(Number.isFinite(audio.duration))audio.currentTime=Number(event.target.value)/100*audio.duration;});
  audio.addEventListener('timeupdate',updateFooter);audio.addEventListener('durationchange',updateFooter);audio.addEventListener('play',updateFooter);audio.addEventListener('pause',updateFooter);audio.addEventListener('ended',()=>step(1));audio.addEventListener('error',()=>{if(state.current?.kind!=='spotify')toast('Audio could not be loaded');});
  document.addEventListener('keydown',event=>{const node=event.target.closest('.album-card');if(node&&(event.key==='Enter'||event.key===' ')){event.preventDefault();playItem(node.dataset.id,DEMOS.map(t=>t.id));}});
  let dragDepth=0;window.addEventListener('dragenter',event=>{event.preventDefault();dragDepth++;document.body.classList.add('drop-active');});window.addEventListener('dragleave',event=>{event.preventDefault();dragDepth=Math.max(0,dragDepth-1);if(dragDepth===0)document.body.classList.remove('drop-active');});window.addEventListener('dragover',event=>event.preventDefault());window.addEventListener('drop',event=>{event.preventDefault();dragDepth=0;document.body.classList.remove('drop-active');if(event.dataTransfer?.files.length)importFiles(event.dataTransfer.files);});
  window.addEventListener('beforeunload',()=>{for(const url of state.objectUrls.values())URL.revokeObjectURL(url);});
}
async function init(){
  state.links=sanitizeLinks(readJSON('links',[]));
  state.liked=new Set(readJSON('liked',[]).filter(id=>typeof id==='string'));
  state.playlists=readJSON('playlists',[]).filter(isValidPlaylist).slice(0,100).map(p=>({id:p.id,name:p.name.slice(0,60),ids:p.ids.filter(id=>typeof id==='string')}));
  try{db=await openDB();const rows=await dbAll();for(const record of rows){if(!record?.file||!record?.item?.id)continue;state.tracks.push(record.item);state.objectUrls.set(record.item.id,URL.createObjectURL(record.file));}}catch(error){console.warn('Browser database unavailable',error);}
  state.queue=state.tracks.map(track=>track.id);audio.volume=.75;events();renderPage();updateFooter();
}
init();