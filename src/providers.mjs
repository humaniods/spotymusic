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
function safeHttp(raw, allowedHttp = false) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'https:' && !(allowedHttp && url.protocol === 'http:')) return null;
    if (/^(localhost|.+\.localhost|.+\.local)$/i.test(url.hostname)) return null;
    if (/^(127\.|10\.|192\.168\.|0\.|169\.254\.)/.test(url.hostname)) return null;
    const match = /^172\.(\d+)\./.exec(url.hostname);
    if (match && +match[1] >= 16 && +match[1] <= 31) return null;
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
  if (mode === 'latest') url.searchParams.set('sort_by','indexed_on');
  return url.toString();
}

export function mapOpenverse(raw) {
  if (!raw || raw.mature === true) return null;
  const source = safeHttp(raw.url);
  if (!source) return null;
  const audioType = clip(raw.filetype,12).replace(/^\./,'');
  if (!AUDIO_TYPES.test(new URL(source).pathname) &&
      !/^(mp3|ogg|oga|wav|flac|m4a|aac|opus|webm)$/i.test(audioType)) return null;
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
    gsrsearch:q, gsrnamespace:'6', gsrlimit:String(Math.min(20,Math.max(1,limit))),
    gsroffset:String(Math.max(0,offset)), prop:'imageinfo', iiprop:'url|extmetadata',
    iiextmetadatafilter:'LicenseShortName|LicenseUrl|Artist|Credit|AttributionRequired'
  }).forEach(([key,value])=>url.searchParams.set(key,value));
  return url.toString();
}

export function mapCommons(page) {
  const info = page?.imageinfo?.[0];
  if (!info?.url || !AUDIO_TYPES.test(new URL(safeHttp(info.url) || 'https://invalid.example/').pathname)) return null;
  const license = clip(info.extmetadata?.LicenseShortName?.value,70);
  if (!license) return null;
  const rawTitle = clip(page.title,140).replace(/^File:/i,'').replace(/\.(mp3|ogg|oga|wav|flac|m4a|aac|opus|webm)$/i,'').replace(/_/g,' ');
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

async function getJSON(url,fetchImpl,signal) {
  const res = await fetchImpl(url, {signal,headers:{Accept:'application/json'}});
  if (!res.ok) throw new Error('HTTP '+res.status);
  return res.json();
}

export async function fetchProvider(provider, options={}, fetchImpl=fetch) {
  const {mode='search',query='',offset=0,limit=SOURCE_LIMIT,signal}=options;
  if (provider==='audius') return fetchFreeTracks({mode,query,offset,limit,signal},fetchImpl)
    .then(items=>items.map(t=>({...t,provider:'audius',page:'https://audius.co',license:'Artist-provided stream',live:false})));
  if (provider==='openverse') {
    const data = await getJSON(openverseUrl({mode,query,offset,limit}),fetchImpl,signal);
    if (!Array.isArray(data?.results)) throw new Error('Unexpected Openverse response');
    return data.results.map(mapOpenverse).filter(Boolean);
  }
  if (provider==='commons') {
    const data = await getJSON(commonsUrl({mode,query,offset,limit}),fetchImpl,signal);
    if (!data?.query && !data?.batchcomplete) throw new Error('Unexpected Wikimedia response');
    return Object.values(data.query?.pages || {}).map(mapCommons).filter(Boolean);
  }
  if (provider==='radio') {
    let error;
    for(const server of RADIO_SERVERS) {
      try {
        const data = await getJSON(radioUrl({mode,query,offset,limit},server),fetchImpl,signal);
        if (!Array.isArray(data)) throw new Error('Unexpected Radio Browser response');
        return data.map(mapRadio).filter(Boolean);
      } catch(err) {
        if (signal?.aborted) throw err;
        error=err;
      }
    }
    throw error;
  }
  throw new Error('Unsupported provider');
}

export async function searchAcross({provider='all',mode='search',query='',offset=0,limit=SOURCE_LIMIT,signal}={}, fetchImpl=fetch) {
  const selected = provider==='all' ? PROVIDER_NAMES : [provider];
  if (!selected.every(x=>PROVIDER_NAMES.includes(x))) throw new Error('Unknown source');
  const outcomes=await Promise.allSettled(selected.map(key=>fetchProvider(key,{mode,query,offset,limit,signal},fetchImpl)));
  if(signal?.aborted) throw new DOMException('Aborted','AbortError');
  const errors=[];
  const tracks=[];
  const seen=new Set();
  outcomes.forEach((outcome,index)=>{
    if (outcome.status==='rejected') {errors.push({provider:selected[index],message:String(outcome.reason?.message||outcome.reason)});return;}
    for(const item of outcome.value) if(!seen.has(item.id)){seen.add(item.id);tracks.push(item);}
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
