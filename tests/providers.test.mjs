import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCES,openverseUrl,mapOpenverse,commonsUrl,mapCommons,radioUrl,mapRadio,
  fetchProvider,searchAcross,reviveMultiTrack
} from '../src/providers.mjs';

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

test('four source choices are explicit and independent',()=>{
  assert.deepEqual(Object.keys(SOURCES),['audius','openverse','commons','radio']);
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
    return {ok:false,status:502,json:async()=>({})};
  };
  const response=await searchAcross({provider:'all',mode:'search',query:'music'},mocked);
  assert.deepEqual(response.tracks.map(x=>x.kind),['openverse','commons','radio']);
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
    return {ok:true,json:async()=>[station]};
  };
  const data=await searchAcross({provider:'all',mode:'search',query:'jazz',
    onSource:({provider,tracks,error})=>order.push(provider+(error?'!':'+'+tracks.length))},mocked);
  assert.equal(order.length,4);
  assert.equal(new Set(order.map(x=>x.split(/[!+]/)[0])).size,4,'each source reports once');
  assert.ok(order.includes('commons!'),order.join(','));
  assert.ok(order[3].startsWith('audius'),order.join(','));
  // the aggregate stays in declared source order regardless of who answered first
  assert.deepEqual(data.tracks.map(t=>t.provider),['audius','openverse','radio']);
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
