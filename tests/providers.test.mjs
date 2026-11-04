import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCES,BROWSE_SOURCES,openverseUrl,mapOpenverse,commonsUrl,mapCommons,radioUrl,mapRadio,
  fetchProvider,searchAcross,reviveMultiTrack
} from '../src/providers.mjs';
import {
  itunesSearchUrl,itunesChartUrl,chartEntries,mapItunesChart,mapItunesSearch,newestFirst,savedPreview,fullListenUrl
} from '../src/itunes.mjs';
import {youtubeRow,savedEmbed,youtubeEmbed,youtubeWatch} from '../src/youtube.mjs';

const openRecord = {
  id:'6cfa5ae5-f1bd-4188-9961-71ad1454d766',title:'Golden Piano',
  creator:'Open Composer',url:'https://upload.wikimedia.org/example.mp3',
  foreign_landing_url:'https://commons.wikimedia.org/wiki/File:Golden_Piano.mp3',
  license:'by',license_version:'4.0',filetype:'mp3'
};
const commonsRecord = {
  pageid:563238,title:'File:A Creative Commons Song.ogg',
  imageinfo:[{url:'https://upload.wikimedia.org/wikipedia/commons/example.ogg',
    descriptionurl:'https://commons.wikimedia.org/wiki/File:A_Creative_Commons_Song.ogg',
    extmetadata:{LicenseShortName:{value:'CC BY-SA 4.0'}}}]
};
const station = {
  stationuuid:'12345678-abcd-4188-9961-71ad1454d766',name:'Jazz Online Radio',
  url_resolved:'https://radio.example.org/jazz.mp3',homepage:'https://radio.example.org',
  codec:'MP3',lastcheckok:1,countrycode:'IN',hls:0,tags:'jazz,blues'
};
// Live Openverse payloads are overwhelmingly Jamendo, which labels bitrates rather
// than formats. An exact-match check on these silently dropped every single result.
const jamendoRecord = {
  id:'8457fac8-84be-48b9-9b57-143ec5e5fbd9',title:'latino-jazz-cash',
  creator:'Les Oreilles en Ballades',
  url:'https://prod-1.storage.jamendo.com/?trackid=15767&format=mp32',
  foreign_landing_url:'https://www.jamendo.com/track/15767',
  license:'by-nc-nd',license_version:'2.5',filetype:'mp32'
};

// A real Apple chart entry: the preview URL, the track id and the release date all
// arrive inside the feed, so discovery costs one request rather than a lookup per row.
const chartEntry = {
  'im:name': { label: 'Roddy Theme (From "Jailer 2")' },
  'im:artist': { label: 'Anirudh Ravichander' },
  'im:releaseDate': { label: '2026-10-26T07:00:00-07:00' },
  id: {
    label: 'https://music.apple.com/in/album/roddy-theme/6827079993?i=6827080210&uo=2',
    attributes: { 'im:id': '6827080210' }
  },
  link: [
    { attributes: { rel: 'alternate', type: 'text/html',
      href: 'https://music.apple.com/in/album/roddy-theme-from-jailer-2/6827079993?i=6827080210&uo=2' } },
    { 'im:duration': { label: '30000' }, attributes: { title: 'Preview', rel: 'enclosure', type: 'audio/x-m4a',
      'im:assetType': 'preview',
      href: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/d9/b7/5a/mzaf_18389923733148569977.plus.aac.p.m4a' } }
  ]
};
const itunesSearchRecord = {
  kind: 'song', trackId: 6825791376, trackName: 'Zaalima', artistName: 'Arijit Singh & Harshdeep Kaur',
  releaseDate: '2026-10-23T00:00:00Z', trackTimeMillis: 255008,
  previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/e7/ce/b3/mzaf_3407.plus.aac.p.m4a',
  trackViewUrl: 'https://music.apple.com/in/album/zaalima/6825791151?i=6825791376&uo=4'
};

test('source choices are explicit and independent',()=>{
  assert.deepEqual(Object.keys(SOURCES),['audius','openverse','commons','radio','itunes','youtube']);
});

test('YouTube never joins an unmetered fan-out',()=>{
  assert.deepEqual([...BROWSE_SOURCES],['audius','openverse','commons','radio','itunes']);
});

test('a YouTube row is only ever an official embed of an 11-character video id',()=>{
  const t=youtubeRow({id:'dQw4w9WgXcQ',title:'Zaalima',artist:'Arijit Singh',released:Date.parse('2023-01-01')});
  assert.equal(t.provider,'youtube');
  assert.equal(t.source,'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0');
  assert.equal(t.page,'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(youtubeRow({id:'short',title:'Nope'}),null);
  assert.equal(youtubeRow({id:'dQw4w9WgXcQ',title:''}),null);
  assert.equal(youtubeWatch('dQw4w9WgXcQ</script>'),'');
  // A saved row rebuilds its URLs from the id alone; a tampered source field is ignored.
  const saved=savedEmbed({id:'youtube:dQw4w9WgXcQ',title:'Zaalima',artist:'Arijit',source:'https://evil.example/x.js'});
  assert.equal(saved.source,t.source);
  assert.equal(savedEmbed({id:'itunes:123',title:'x'}),null);
});

test('Openverse API: anonymous, query encoded and paginated',()=>{
  const url=new URL(openverseUrl({query:'sitar & raga',offset:12,limit:12}));
  assert.equal(url.origin,'https://api.openverse.org');
  assert.equal(url.pathname,'/v1/audio/');
  assert.equal(url.searchParams.get('q'),'sitar & raga');
  assert.equal(url.searchParams.get('page'),'2');
});

test('Openverse only accepts tracks with attribution metadata and audio',()=>{
  const t=mapOpenverse(openRecord);
  assert.equal(t?.kind,'openverse');
  assert.equal(t?.title,'Golden Piano');
  assert.match(t?.license,/by 4.0/);
  assert.equal(mapOpenverse({...openRecord,url:'javascript:alert(1)'}),null);
  assert.equal(mapOpenverse({...openRecord,license:''}),null);
  assert.equal(mapOpenverse({...openRecord,url:'https://example.org/page.html',filetype:'html'}),null);
  assert.equal(mapOpenverse({...openRecord,mature:true}),null);
});

test('Wikimedia Commons CORS-enabled search and original attribution',()=>{
  const u=new URL(commonsUrl({query:'Hindi classical',offset:9}));
  assert.equal(u.searchParams.get('origin'),'*');
  assert.equal(u.searchParams.get('gsrnamespace'),'6');
  assert.match(u.searchParams.get('gsrsearch'),/Hindi classical/);
  const t=mapCommons(commonsRecord);
  assert.equal(t.kind,'commons');
  assert.match(t.page,/commons.wikimedia.org/);
  assert.equal(t.license,'CC BY-SA 4.0');
  assert.equal(mapCommons({...commonsRecord,imageinfo:[{url:'https://example.org/song.exe'}]}),null);
});

test('Radio Browser listings are live stations, not downloadable tracks',()=>{
  const u=new URL(radioUrl({mode:'search',query:'Punjabi',limit:6}));
  assert.equal(u.searchParams.get('name'),'Punjabi');
  assert.equal(u.searchParams.get('is_https'),'true');
  const t=mapRadio(station);
  assert.equal(t?.kind,'radio'); assert.equal(t?.live,true);
  assert.equal(mapRadio({...station,hls:1}),null);
  assert.equal(mapRadio({...station,codec:'HLS'}),null);
  assert.equal(mapRadio({...station,url_resolved:'http://radio.example.org/'}),null);
});

test('One provider failure does not hide successful free-source results',async()=>{
  const mocked=async url=>{
    if(url.includes('api.openverse.org'))return {ok:true,json:async()=>({results:[openRecord]})};
    if(url.includes('commons.wikimedia.org'))return {ok:true,json:async()=>({batchcomplete:true,query:{pages:{a:commonsRecord}}})};
    if(url.includes('api.radio-browser.info'))return {ok:true,json:async()=>[station]};
    if(url.includes('itunes.apple.com'))return {ok:true,json:async()=>({results:[itunesSearchRecord]})};
    return {ok:false,status:502,json:async()=>({})};
  };
  const response=await searchAcross({provider:'all',mode:'search',query:'music'},mocked);
  assert.deepEqual(response.tracks.map(x=>x.kind),['openverse','commons','radio','itunes']);
  assert.equal(response.errors.length,1);
  assert.equal(response.errors[0].provider,'audius');
});

test('saved tracks reject fabricated provider IDs and executable URLs',()=>{
  const t=mapOpenverse(openRecord);
  const saved=reviveMultiTrack(t);
  assert.equal(saved?.title,t.title);
  assert.equal(reviveMultiTrack({...t,source:'file:///etc/passwd'}),null);
  assert.equal(reviveMultiTrack({...t,source:'http://127.0.0.1/audio.mp3'}),null);
  assert.equal(reviveMultiTrack({...t,id:'audius:123'}),null);
});

test('Unsupported provider is rejected and provider fetch responses validated',async()=>{
  await assert.rejects(searchAcross({provider:'anything'}),/Unknown source/);
  await assert.rejects(fetchProvider('openverse',{mode:'search',query:'piano'},async()=>({ok:true,json:async()=>({results:'bad'})})),/Unexpected Openverse/);
});

test('Openverse maps Jamendo bitrate-suffixed filetypes instead of dropping them',()=>{
  const t=mapOpenverse(jamendoRecord);
  assert.equal(t?.kind,'openverse');
  assert.equal(t?.title,'latino-jazz-cash');
  assert.match(t?.source,/prod-1\.storage\.jamendo\.com/);
  assert.equal(mapOpenverse({...jamendoRecord,filetype:'ogg3'}).kind,'openverse');
  assert.equal(mapOpenverse({...jamendoRecord,filetype:'html'}),null);
  assert.equal(mapOpenverse({...jamendoRecord,filetype:'pdf'}),null);
});

test('Commons rejects Wikipedia pronunciation and spoken-article recordings',()=>{
  // Real "coldplay" search hits that were drowning out actual music.
  for(const junk of ['File:En-us-starfish.ogg','File:Nl-Coldplay-article.ogg',
                     'File:LL-Q1860 (eng)-Vealhurl-coldplay.wav','File:Ru-Korean War.ogg']){
    assert.equal(mapCommons({...commonsRecord,title:junk},'coldplay'),null,junk);
  }
  const kept=mapCommons({...commonsRecord,title:'File:Coldplay_Live_Concert.ogg'},'coldplay');
  assert.equal(kept?.title,'Coldplay Live Concert');
  assert.equal(mapCommons({...commonsRecord,title:'File:Jazz_at_the_park.ogg'},'coldplay'),null);
  // Generic terms must not gate matching or every query would need a title hit.
  assert.ok(mapCommons(commonsRecord,'music'));
  assert.ok(mapCommons(commonsRecord,''));
});

test('sources report independently as they settle, not as a batch',async()=>{
  const order=[];
  const mocked=async url=>{
    if(url.includes('api.audius.co')) {await new Promise(r=>setTimeout(r,60));
      return {ok:true,json:async()=>({data:[{id:'abcd1234efgh',title:'Slow but first',user:{name:'A'}}]})};}
    if(url.includes('api.openverse.org')) return {ok:true,json:async()=>({results:[openRecord]})};
    if(url.includes('commons.wikimedia.org')) return {ok:false,status:500,json:async()=>({})};
    if(url.includes('itunes.apple.com')) return {ok:true,json:async()=>
      url.includes('/search') ? {results:[itunesSearchRecord]} : {feed:{entry:[chartEntry]}}};
    return {ok:true,json:async()=>[station]};
  };
  const data=await searchAcross({provider:'all',mode:'search',query:'jazz',
    onSource:({provider,tracks,error})=>order.push(provider+(error?'!':'+'+tracks.length))},mocked);
  assert.equal(order.length,5);
  assert.equal(new Set(order.map(x=>x.split(/[!+]/)[0])).size,5,'each source reports once');
  assert.ok(order.includes('commons!'),order.join(','));
  assert.ok(order.at(-1).startsWith('audius'),order.join(','));
  // the aggregate stays in declared source order regardless of who answered first
  assert.deepEqual(data.tracks.map(t=>t.provider),['audius','openverse','radio','itunes']);
  assert.deepEqual(data.errors.map(e=>e.provider),['commons']);
});

test('internal addresses cannot become an audio source',()=>{
  for(const host of ['[::1]','[::ffff:7f00:1]','[fd00::1]','[fe80::1%25eth0]','localhost.','db.internal',
                     'x.corp','127.0.0.1','10.1.2.3','192.168.4.4','172.16.9.9','169.254.169.254',
                     '2130706433','0x7f000001','127.1','0.0.0.0']){
    assert.equal(mapOpenverse({...openRecord,url:'https://'+host+'/a.mp3'}),null,host);
  }
  for(const host of ['[2606:4700:0::1]','cdn.example.org','172.15.0.1','8.8.8.8']){
    assert.ok(mapOpenverse({...openRecord,url:'https://'+host+'/a.mp3'}),host);
  }
});

test('throttled providers are retried before giving up',async()=>{
  let calls=0;
  const flaky=async()=>{
    calls++;
    return calls<3 ? {ok:false,status:429,json:async()=>({})}
                   : {ok:true,json:async()=>({results:[jamendoRecord]})};
  };
  const tracks=await fetchProvider('openverse',{mode:'search',query:'piano'},flaky);
  assert.equal(calls,3);
  assert.equal(tracks.length,1);
});

test('non-throttled failures surface immediately without retry',async()=>{
  let calls=0;
  const failing=async()=>{calls++;return {ok:false,status:500,json:async()=>({})};};
  await assert.rejects(fetchProvider('openverse',{mode:'search',query:'piano'},failing),/HTTP 500/);
  assert.equal(calls,1);
});

// Browser network failures reject with TypeError, so they look retryable. Without a
// per-provider budget a single dead mirror retried across all three for ~90s and the
// Browse screen never resolved.
test('network failures retry a bounded number of times then surface',async()=>{
  let calls=0;
  const dead=async()=>{calls++;throw new TypeError('Failed to fetch');};
  await assert.rejects(fetchProvider('commons',{mode:'search',query:'piano'},dead),/Failed to fetch/);
  assert.equal(calls,3);
});

test('a cancelled search abandons a hung provider without retrying',async()=>{
  const controller=new AbortController();
  let calls=0;
  const hanging=()=>{
    calls++;
    return new Promise((_,reject)=>controller.signal.addEventListener('abort',
      ()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
  };
  setTimeout(()=>controller.abort(),120);
  await assert.rejects(fetchProvider('openverse',{mode:'search',query:'piano',signal:controller.signal},hanging),/Aborted/);
  assert.equal(calls,1);
});

// Real payload for a Commons search with no hits: batchcomplete is present but empty.
test('an empty Wikimedia result is not reported as a broken source',async()=>{
  const empty=async()=>({ok:true,json:async()=>({batchcomplete:''})});
  assert.deepEqual(await fetchProvider('commons',{mode:'search',query:'arijit singh official album'},empty),[]);
  const failed=async()=>({ok:true,json:async()=>({batchcomplete:'',error:{info:'The search query is too long'}})});
  await assert.rejects(fetchProvider('commons',{mode:'search',query:'x'},failed),/search query is too long/);
  await assert.rejects(fetchProvider('commons',{mode:'search',query:'x'},async()=>({ok:true,json:async()=>'not json'})),/Unexpected Wikimedia/);
});

test('Apple endpoints need no key and stay inside one store',()=>{
  const search=new URL(itunesSearchUrl({query:'latest punjabi songs 2026'}));
  assert.equal(search.origin,'https://itunes.apple.com');
  assert.equal(search.pathname,'/search');
  assert.equal(search.searchParams.get('media'),'music');
  assert.equal(search.searchParams.get('entity'),'song');
  assert.equal(search.searchParams.get('country'),'in');
  assert.equal(search.searchParams.get('term'),'latest punjabi songs 2026');
  assert.throws(()=>itunesSearchUrl({query:'   '}),/Search query required/);
  assert.equal(new URL(itunesChartUrl({limit:12})).pathname,'/in/rss/topsongs/limit=12/json');
  // The store code is a path segment, so junk must not be able to restructure the URL.
  assert.equal(new URL(itunesChartUrl({store:'../etc',limit:5})).pathname,'/in/rss/topsongs/limit=5/json');
  assert.equal(new URL(itunesChartUrl({limit:99999})).pathname,'/in/rss/topsongs/limit=25/json');
});

test('a chart row needs Apple’s own preview link and a real track id',()=>{
  const row=mapItunesChart(chartEntry);
  assert.equal(row.provider,'itunes');
  assert.equal(row.id,'6827080210');
  assert.match(row.source,/audio-ssl\.itunes\.apple\.com/);
  assert.match(row.page,/music\.apple\.com\/in\/album/);
  assert.equal(row.license,'30-sec preview · Apple');
  assert.equal(row.released,Date.parse('2026-10-26T07:00:00-07:00'));
  // No preview enclosure means Apple offers no free clip: drop the row instead of
  // listing a song the player then cannot load.
  assert.equal(mapItunesChart({...chartEntry,link:[chartEntry.link[0]]}),null);
  assert.equal(mapItunesChart({...chartEntry,id:{attributes:{}}}),null);
  assert.equal(mapItunesChart({...chartEntry,'im:name':{label:'  '}}),null);
  // A feed can hold a single entry as a bare object rather than a list.
  assert.equal(chartEntries({feed:{entry:chartEntry}}).length,1);
  assert.deepEqual(chartEntries({feed:{}}),[]);
});

test('a search result without a preview is metadata, not a song',()=>{
  const row=mapItunesSearch(itunesSearchRecord);
  assert.equal(row.id,'6825791376');
  assert.equal(row.title,'Zaalima');
  assert.equal(row.artist,'Arijit Singh & Harshdeep Kaur');
  assert.match(row.page,/music\.apple\.com/);
  assert.equal(mapItunesSearch({...itunesSearchRecord,previewUrl:''}),null);
  assert.equal(mapItunesSearch({...itunesSearchRecord,kind:'album'}),null);
  assert.equal(mapItunesSearch({...itunesSearchRecord,trackId:''}),null);
});

test('newest release leads New releases while Popular keeps chart order',async()=>{
  const older={...chartEntry,
    id:{label:'https://music.apple.com/in/album/old/1?i=1111111111&uo=2',attributes:{'im:id':'1111111111'}},
    'im:releaseDate':{label:'2020-01-01T05:00:00-07:00'}};
  const feed=async()=>({ok:true,json:async()=>({feed:{entry:[older,chartEntry]}})});
  assert.deepEqual((await fetchProvider('itunes',{mode:'latest'},feed)).map(t=>t.id),
    ['itunes:6827080210','itunes:1111111111']);
  assert.deepEqual((await fetchProvider('itunes',{mode:'trending'},feed)).map(t=>t.id),
    ['itunes:1111111111','itunes:6827080210']);
  const searched=async()=>({ok:true,json:async()=>({results:[itunesSearchRecord]})});
  const rows=await fetchProvider('itunes',{mode:'search',query:'zaalima'},searched);
  assert.equal(rows[0].kind,'itunes');
  assert.equal(rows[0].source,itunesSearchRecord.previewUrl);
  await assert.rejects(fetchProvider('itunes',{mode:'latest'},async()=>({ok:true,json:async()=>({results:[]} )})),
    /Unexpected Apple chart/);
  assert.deepEqual(newestFirst([{released:1},{released:9},null,{released:9}]).length,3);
});

test('an Apple preview aimed at a private address never reaches the player',async()=>{
  const evil={...chartEntry,link:[chartEntry.link[0],
    {attributes:{rel:'enclosure',type:'audio/x-m4a','im:assetType':'preview',
      href:'http://169.254.169.254/latest/meta-data/x.m4a'}}]};
  const rows=await fetchProvider('itunes',{mode:'trending'},
    async()=>({ok:true,json:async()=>({feed:{entry:[evil,chartEntry]}})}));
  assert.deepEqual(rows.map(r=>r.id),['itunes:6827080210']);
});

test('a saved Apple favorite is rebuilt against Apples own host only',()=>{
  const row=mapItunesChart(chartEntry);
  const saved={id:'itunes:'+row.id,kind:'itunes',title:row.title,artist:row.artist,
    source:row.source,page:row.page,license:row.license};
  assert.equal(reviveMultiTrack(saved).source,row.source);
  assert.equal(reviveMultiTrack({...saved,source:'https://evil.example/stolen.m4a'}),null);
  assert.equal(savedPreview({...saved,source:'https://audio-ssl.itunes.apple.com/a.m4a'}),
    'https://audio-ssl.itunes.apple.com/a.m4a');
  assert.equal(savedPreview({...saved,source:'http://audio-ssl.itunes.apple.com/a.m4a'}),null);
});

test('the full listen hands an Apple preview to YouTubes own public search',()=>{
  assert.equal(fullListenUrl('Monsoon Lofi','Ari Sound'),
    'https://www.youtube.com/results?search_query=Monsoon%20Lofi%20Ari%20Sound%20song');
  assert.ok(fullListenUrl('Saajna','Ari & Co').includes('Saajna%20Ari%20%26%20Co%20song'),'symbols are encoded, not injected');
  assert.ok(!fullListenUrl('Ari',null).includes('null'),'a missing artist is skipped, not spelled out');
  assert.equal(fullListenUrl('',''),'','nothing to search for means no link');
  assert.ok(fullListenUrl('x'.repeat(200),'y'.repeat(90)).length<220,'the handed-off term stays bounded');
});

test('YouTube rows come back from our own server and are pinned to the embed host',async()=>{
  const asked=[];
  const mocked=async url=>{
    asked.push(String(url));
    return {ok:true,json:async()=>({tracks:[
      {id:'dQw4w9WgXcQ',title:'Monsoon (Official Video)',artist:'Ari Sound',
        page:'https://evil.example/steal',source:'javascript:alert(1)',license:'Full-length video'}
    ]})};
  };
  const rows=await fetchProvider('youtube',{mode:'search',query:'Ari Monsoon',limit:8},mocked);
  assert.equal(rows[0].id,'youtube:dQw4w9WgXcQ');
  assert.equal(rows[0].kind,'youtube');
  assert.equal(rows[0].source,'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0');
  assert.equal(rows[0].page,'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.match(asked[0],/\/api\/youtube\?q=Ari\+Monsoon&limit=8$/,'searched through the server, never with a key in the browser');
  assert.ok(!asked[0].includes('googleapis'));
});

test('YouTube is not asked for anything outside a named search',async()=>{
  const never=async()=>{throw new Error('a browse mode must not bill the search quota');};
  for(const mode of ['latest','trending'])
    assert.deepEqual(await fetchProvider('youtube',{mode,query:'Ari'},never),[]);
  await assert.rejects(fetchProvider('youtube',{mode:'search',query:'   '},never),/Search query required/);
});

test('a saved YouTube favorite is rebuilt from its video id only',()=>{
  const saved={id:'youtube:dQw4w9WgXcQ',kind:'youtube',title:'Monsoon',artist:'Ari Sound',
    source:'https://evil.example/x.js',page:'https://evil.example/x.html',license:'Full-length video'};
  const row=reviveMultiTrack(saved);
  assert.equal(row.source,'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0');
  assert.equal(row.page,'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(reviveMultiTrack({...saved,id:'youtube:tooshort'}),null);
  assert.equal(reviveMultiTrack({...saved,id:'spotify:dQw4w9WgXcQ'}),null);
});
