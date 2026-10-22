import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpotifyUrl, formatTime, nextIndex, searchItems, escapeHtml, safeFile } from '../src/core.mjs';
const id='4cOdK2wGLETKBW3PvgPWqT';
test('accepts official track URL and normalizes share parameters',()=>{
 const parsed=parseSpotifyUrl(`https://open.spotify.com/track/${id}?si=abc`);
 assert.equal(parsed?.id,`track:${id}`);
 assert.equal(parsed?.embedUrl,`https://open.spotify.com/embed/track/${id}?utm_source=generator`);
});
test('accepts Spotify URI and international link',()=>{
 assert.equal(parseSpotifyUrl(`spotify:playlist:${id}`)?.kind,'playlist');
 assert.equal(parseSpotifyUrl(`https://open.spotify.com/intl-en/album/${id}`)?.kind,'album');
});
test('rejects deceptive domains, protocols, and invalid ids',()=>{
 for(const url of [`https://evil.example/track/${id}`,`https://open.spotify.com.evil.net/track/${id}`,`http://open.spotify.com/track/${id}`,`https://open.spotify.com/track/bad`,`https://open.spotify.com/track/${id}/extra`,`javascript:alert(1)`]) assert.equal(parseSpotifyUrl(url),null,url);
});
test('formatTime handles bounds and rolls over an hour',()=>{
 assert.equal(formatTime(65.8),'1:05');assert.equal(formatTime(3599),'59:59');
 assert.equal(formatTime(3600),'1:00:00');assert.equal(formatTime(3665),'1:01:05');
 assert.equal(formatTime(-1),'0:00');assert.equal(formatTime(NaN),'0:00');assert.equal(formatTime(Infinity),'0:00');
});
test('queue has a real ending when repeat is off',()=>{
 assert.equal(nextIndex(2,3),-1);assert.equal(nextIndex(2,3,{repeat:'all'}),0);assert.equal(nextIndex(1,3,{repeat:'one'}),1);
});
test('shuffle excludes currently playing item',()=>{
 assert.equal(nextIndex(1,4,{shuffle:true,random:()=>0}),0);
 assert.equal(nextIndex(1,4,{shuffle:true,random:()=>0.99}),3);
});
test('search is case-insensitive across title and artist',()=>{
 const items=[{title:'Golden Hour',artist:'Sessions'},{title:'Drive',artist:'Lo-Fi Collective'}];
 assert.equal(searchItems(items,'gold').length,1);assert.equal(searchItems(items,'LO-fi').length,1);
});
test('HTML escaping blocks injection in user labels',()=>assert.equal(escapeHtml('<img src=x onerror="a">'),'&lt;img src=x onerror=&quot;a&quot;&gt;'));
test('accepted audio files have supported types and reasonable size',()=>{
 assert.equal(safeFile({name:'audio.mp3',type:'audio/mpeg',size:5}),true);
 assert.equal(safeFile({name:'script.js',type:'application/javascript',size:10}),false);
 assert.equal(safeFile({name:'big.mp3',type:'audio/mpeg',size:300*1024*1024}),false);
});
test('credentials in a share link cannot redirect the embed',()=>{
 const parsed=parseSpotifyUrl(`https://evil.example@open.spotify.com/track/${id}`);
 assert.equal(parsed?.url,`https://open.spotify.com/track/${id}`);
 assert.ok(!parsed.embedUrl.includes('evil'));
});
