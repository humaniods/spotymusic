// Public music discovery providers. Each stream is used only as its source permits.
// No Spotify stream ripping, paywall bypass, client secrets or bundled copyrighted audio.
import {fetchFreeTracks, PAGE_SIZE} from './audius.mjs';

export const SOURCES = Object.freeze({
  audius: 'Audius', openverse: 'Openverse', commons: 'Wikimedia Commons', radio: 'Internet Radio'
});
export const SOURCE_LIMIT = 12;
const AUDIO_TYPES = /\.(mp3|ogg|oga|wav|flac|m4a|aac|opus|webm)(?:$)/i;
const PROVIDER_NAMES = Object.keys(SOURCES);
const ID = /^[\w-]{2,120}$/;

function clip(value, n = 140) { return String(value || '').trim().slice(0,n); }
// Provider records point this browser at someone else's server, so a source that
// lists an internal address would make the user's own machine probe its LAN.
function isInternalHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');            // "localhost." is still localhost
  if (/^(localhost|.+\.localhost|.+\.local|.+\.internal|.+\.corp|.+\.home|.+\.lan)$/.test(host)) return true;
  if (/^(127\.|10\.|192\.168\.|0\.|169\.254\.)/.test(host)) return true;
  const match = /^172\.(\d+)\./.exec(host);
  if (match && +match[1] >= 16 && +match[1] <= 31) return true;
  if (host.startsWith('[')) {                                        // WHATWG keeps IPv6 wrapped in brackets
    const withZone = host.slice(1, -1).toLowerCase();
    const v6 = withZone.includes('%') ? withZone.slice(0, withZone.indexOf('%')) : withZone;
    // "::" covers loopback ::1, unspecified ::, v4-mapped ::ffff:x and v4-compatible ::1.2.3.4.
    if (/^(::|f[cd]|fe80)/.test(v6)) return true;
  }
  return false;
}
function safeHttp(raw, allowedHttp = false) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'https:' && !(allowedHttp && url.protocol === 'http:')) return null;
    if (isInternalHost(url.hostname)) return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}
function track({provider, id, title, artist, source, page, license, live = false}) {
  const sourceUrl = safeHttp(source);
  const pageUrl = safeHttp(page);
  if (!PROVIDER_NAMES.includes(provider) || !ID.test(id) ||
      !clip(title) || !sourceUrl || !pageUrl) return null;
  return {
    id: provider + ':' + id, title: clip(title), artist: clip(artist,100) || SOURCES[provider],
    source: sourceUrl, page: pageUrl, provider, kind: provider, license: clip(license,70),
    live, art: PROVIDER_NAMES.indexOf(provider) + 1
  };
}

export function openverseUrl({mode='search', query='', offset=0, limit=SOURCE_LIMIT}={}) {
  const url = new URL('https://api.openverse.org/v1/audio/');
  // Openverse only provides search; discovery defaults to broadly licensed music.
  const term = mode === 'search' ? clip(query,100) : 'music';
  if (!term) throw new Error('Search query required');
  url.searchParams.set('q', term);
  url.searchParams.set('page_size', String(Math.min(20,Math.max(1,limit))));
  url.searchParams.set('page', String(Math.floor(Math.max(0,offset)/limit)+1));
  if (mode === 'latest') url.searchParams.set('unstable__sort_by','indexed_on');
  url.searchParams.set('category','music');
  return url.toString();
}

export function mapOpenverse(raw) {
  if (!raw || raw.mature === true) return null;
  const source = safeHttp(raw.url);
  if (!source) return null;
  const audioType = clip(raw.filetype,12).replace(/^\./,'');
  if (!AUDIO_TYPES.test(new URL(source).pathname) &&
      // Unanchored on purpose: Openverse serves Jamendo's bitrate-suffixed labels
      // ("mp32", "ogg3"), which an exact match silently rejected for every result.
      !/^(mp3|ogg|oga|wav|flac|m4a|aac|opus|webm)/i.test(audioType)) return null;
  const id = clip(raw.id,120);
  if (!ID.test(id)) return null;
  const license = clip(raw.license,40) + (raw.license_version ? ' ' + clip(raw.license_version,10) : '');
  if (!clip(raw.license) || !raw.foreign_landing_url) return null;
  return track({ provider:'openverse', id, title:raw.title, artist:raw.creator || 'Unknown creator',
    source, page:raw.foreign_landing_url, license });
}

export function commonsUrl({mode='search',query='',offset=0,limit=SOURCE_LIMIT}={}) {
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  const term = mode === 'search' ? clip(query,100) : 'music';
  if (!term) throw new Error('Search query required');
  const q = term + ' filetype:audio';
  Object.entries({
    action:'query', format:'json', origin:'*', generator:'search',
    gsrsearch:q, gsrnamespace:'6', gsrlimit:String(Math.min(40,Math.max(1,limit)*3)),
    gsroffset:String(Math.max(0,offset)), prop:'imageinfo', iiprop:'url|extmetadata',
    iiextmetadatafilter:'LicenseShortName|LicenseUrl|Artist|Credit|AttributionRequired'
  }).forEach(([key,value])=>url.searchParams.set(key,value));
  return url.toString();
}

// Commons is full of Wikipedia pronunciation and spoken-article recordings, and
// "filetype:audio" happily matches them — a "coldplay" query returned starfish
// audio and a Dutch Wikipedia article read aloud.
const SPOKEN_WORD = /^[A-Za-z]{2}(-[A-Za-z]{2})?-|^(?:LL-)?Q\d/;
const SEARCH_STOPWORDS = new Set(['the','a','an','of','and','ft','feat','with','song','music','track']);

function queryTerms(query) {
  return clip(query,100).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2 && !SEARCH_STOPWORDS.has(t));
}

export function mapCommons(page, query='') {
  const info = page?.imageinfo?.[0];
  if (!info?.url || !AUDIO_TYPES.test(new URL(safeHttp(info.url) || 'https://invalid.example/').pathname)) return null;
  const license = clip(info.extmetadata?.LicenseShortName?.value,70);
  if (!license) return null;
  const rawTitle = clip(page.title,140).replace(/^File:/i,'').replace(/\.(mp3|ogg|oga|wav|flac|m4a|aac|opus|webm)$/i,'').replace(/_/g,' ');
  if (SPOKEN_WORD.test(rawTitle)) return null;
  const terms = queryTerms(query);
  if (terms.length && !terms.some(term => rawTitle.toLowerCase().includes(term))) return null;
  return track({provider:'commons',id:String(page.pageid),title:rawTitle,
    artist:'Wikimedia Commons contributor',source:info.url,
    page:info.descriptionurl || ('https://commons.wikimedia.org/wiki/' + encodeURIComponent(page.title)),
    license});
}

const RADIO_SERVERS=['https://de1.api.radio-browser.info','https://nl1.api.radio-browser.info','https://at1.api.radio-browser.info'];
export function radioUrl({mode='trending',query='',offset=0,limit=SOURCE_LIMIT}={}, server=RADIO_SERVERS[0]) {
  const searching = mode==='search';
  const url = new URL(server + (searching ? '/json/stations/search' : '/json/stations/topvote'));
  if (searching) {
    const term = clip(query,100);
    if (!term) throw new Error('Search query required');
    url.searchParams.set('name',term);
  }
  url.searchParams.set('hidebroken','true');
  url.searchParams.set('is_https','true');
  url.searchParams.set('limit',String(Math.min(30,Math.max(1,limit))));
  url.searchParams.set('offset',String(Math.max(0,offset)));
  return url.toString();
}
export function mapRadio(raw) {
  const source = safeHttp(raw?.url_resolved || raw?.url);
  if (!source || !raw?.stationuuid || raw.hls === 1 || raw.hls === true || raw.lastcheckok === 0 || raw.lastcheckok === false) return null;
  const codec = clip(raw.codec,20).toUpperCase();
  if (!['MP3','AAC','AAC+','OGG','VORBIS','OPUS'].includes(codec)) return null;
  const uuid = clip(raw.stationuuid,120);
  if (!ID.test(uuid)) return null;
  return track({provider:'radio',id:uuid,title:raw.name,
    artist:[raw.countrycode, raw.tags?.split(',')[0]].filter(Boolean).join(' · ') || 'Live internet radio',
    source,page:safeHttp(raw.homepage) || 'https://www.radio-browser.info/',license:'Live station · station terms apply',live:true});
}

// Anonymous callers get throttled hard when four sources fire at once, so retry
// the two codes that actually mean "back off". Other 5xx surface immediately.
const THROTTLED = /HTTP (429|503)\b/;
const MAX_ATTEMPTS = 3;
// Measured on a cold index, Openverse answers in 9-10s (and once in 46s) while the
// other three sources are under 2s. This covers retries plus the radio mirror
// failover as one unit, so a dead source reports itself instead of hanging Browse.
const REQUEST_TIMEOUT_MS = 15000;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function isThrottle(err) {
  return THROTTLED.test(String(err?.message ?? '')) || err?.name === 'TypeError';
}

// One deadline covers a provider's whole attempt sequence. Without it a hung or
// rate-limited source retried indefinitely and the search screen never resolved.
function deadline(signal) {
  const timer = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (!signal) return timer;
  return AbortSignal.any ? AbortSignal.any([signal, timer]) : signal;
}

async function withRetry(run, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (signal?.aborted || attempt >= MAX_ATTEMPTS - 1 || !isThrottle(err)) throw err;
      await wait(300 * 2 ** attempt);
    }
  }
}

async function getJSON(url,fetchImpl,signal) {
  const res = await fetchImpl(url, {signal,headers:{Accept:'application/json'}});
  if (!res.ok) throw new Error('HTTP '+res.status);
  return res.json();
}

export async function fetchProvider(provider, options={}, fetchImpl=fetch) {
  const {mode='search',query='',offset=0,limit=SOURCE_LIMIT,signal}=options;
  // One budget per provider, so retries and the radio mirror failover cannot stack
  // into a minute of dead time while the search screen waits on a hung source.
  const budget = deadline(signal);
  const get = url => withRetry(()=>getJSON(url,fetchImpl,budget), budget);
  if (provider==='audius') {
    const items = await withRetry(()=>fetchFreeTracks({mode,query,offset,limit,signal:budget},fetchImpl), budget);
    return items.map(t=>({...t,provider:'audius',page:'https://audius.co',license:'Artist-provided stream',live:false}));
  }
  if (provider==='openverse') {
    const data = await get(openverseUrl({mode,query,offset,limit}));
    if (!Array.isArray(data?.results)) throw new Error('Unexpected Openverse response');
    return data.results.map(mapOpenverse).filter(Boolean);
  }
  if (provider==='commons') {
    const data = await get(commonsUrl({mode,query,offset,limit}));
    // "batchcomplete" is an empty string on a search with zero hits, so a truthiness
    // test reported every legitimate empty result as a broken source.
    if (!data || typeof data !== 'object' || !('batchcomplete' in data || 'query' in data || 'error' in data)) {
      throw new Error('Unexpected Wikimedia response');
    }
    if (data.error) throw new Error('Wikimedia: '+clip(data.error.info,60));
    return Object.values(data.query?.pages || {}).map(page=>mapCommons(page,query)).filter(Boolean);
  }
  if (provider==='radio') {
    let error;
    for(const server of RADIO_SERVERS) {
      try {
        const data = await get(radioUrl({mode,query,offset,limit},server));
        if (!Array.isArray(data)) throw new Error('Unexpected Radio Browser response');
        return data.map(mapRadio).filter(Boolean);
      } catch(err) {
        if (budget.aborted) throw err;
        error=err;
      }
    }
    throw error;
  }
  throw new Error('Unsupported provider');
}

export async function searchAcross({provider='all',mode='search',query='',offset=0,limit=SOURCE_LIMIT,signal,onSource}={}, fetchImpl=fetch) {
  const selected = provider==='all' ? PROVIDER_NAMES : [provider];
  if (!selected.every(x=>PROVIDER_NAMES.includes(x))) throw new Error('Unknown source');
  // Each source reports back on its own so the screen can paint what has already
  // arrived: Audius answers in about 1.5s while a cold Openverse index takes 10s+.
  const settled=await Promise.all(selected.map(key=>fetchProvider(key,{mode,query,offset,limit,signal},fetchImpl)
    .then(tracks=>({provider:key,tracks,error:null}))
    .catch(err=>{
      if (signal?.aborted) throw err;
      return {provider:key,tracks:[],error:String(err?.message||err)};
    })
    .then(outcome=>{ onSource?.(outcome); return outcome; })));
  if(signal?.aborted) throw new DOMException('Aborted','AbortError');
  const errors=[];
  const tracks=[];
  const seen=new Set();
  settled.forEach(({provider:key,tracks:items,error})=>{
    if (error) {errors.push({provider:key,message:error});return;}
    for(const item of items) if(!seen.has(item.id)){seen.add(item.id);tracks.push(item);}
  });
  return {tracks,errors,sources:selected.length};
}

export function reviveMultiTrack(saved) {
  if (!saved || typeof saved !== 'object') return null;
  const provider=String(saved.kind||'');
  if (!['openverse','commons','radio'].includes(provider)) return null;
  const id=String(saved.id||'');
  if (!id.startsWith(provider+':')) return null;
  return track({provider,id:id.slice(provider.length+1),title:saved.title,artist:saved.artist,
    source:saved.source,page:saved.page,license:saved.license,live:provider==='radio'});
}
