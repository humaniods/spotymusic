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
  await assert.rejects(fetchProvider('openverse',{},async()=>({ok:true,json:async()=>({results:'bad'})})),/Unexpected Openverse/);
});
