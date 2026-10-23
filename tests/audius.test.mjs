import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogUrl, streamUrl, toFreeTrack, reviveFreeTrack, fetchFreeTracks } from '../src/audius.mjs';

const song = (id = 'abc123') => ({
  id, title: 'An original song', is_streamable: true,
  user: { name: 'Independent Artist' }
});

test('Latest and trending endpoints use only official Audius HTTPS API', () => {
  const latest = new URL(catalogUrl());
  assert.equal(latest.origin, 'https://api.audius.co');
  assert.equal(latest.pathname, '/v1/tracks/latest');
  assert.equal(latest.searchParams.get('app_name'), 'OpenMic');
  const trending = new URL(catalogUrl({ mode:'trending', offset:18 }));
  assert.equal(trending.pathname, '/v1/tracks/trending');
  assert.equal(trending.searchParams.get('time'), 'week');
  assert.equal(trending.searchParams.get('offset'), '18');
});

test('Search query URL-encodes Unicode names and clamps page size', () => {
  const url = new URL(catalogUrl({ mode:'search', query:'  Dil Se ❤️  ', limit:999, offset:-2 }));
  assert.equal(url.pathname, '/v1/tracks/search');
  assert.equal(url.searchParams.get('query'), 'Dil Se ❤️');
  assert.equal(url.searchParams.get('limit'), '50');
  assert.equal(url.searchParams.get('offset'), '0');
  assert.throws(() => catalogUrl({mode:'search',query:'  '}), /required/);
});

test('Stream URL is an official Audius track endpoint', () => {
  assert.equal(streamUrl('aB_c-23'), 'https://api.audius.co/v1/tracks/aB_c-23/stream?app_name=OpenMic');
  assert.throws(() => streamUrl('../evil'));
  assert.throws(() => streamUrl(''));
});

test('Track conversion excludes paywalled, invalid and unstreamable recordings', () => {
  assert.equal(toFreeTrack({...song(),is_streamable:false}), null);
  assert.equal(toFreeTrack({...song(),is_premium:true}), null);
  assert.equal(toFreeTrack({...song(),access:{stream:false}}), null);
  assert.equal(toFreeTrack({...song(),access:{stream:'purchase'}}), null);
  assert.equal(toFreeTrack({...song('../unsafe')}), null);
  assert.equal(toFreeTrack({...song(),title:''}), null);
  const result = toFreeTrack(song());
  assert.equal(result.id, 'audius:abc123');
  assert.equal(result.kind, 'audius');
  assert.equal(result.artist, 'Independent Artist');
  assert.match(result.source, /\/tracks\/abc123\/stream/);
});

test('Saved online tracks are sanitized and stream links regenerated', () => {
  const track = reviveFreeTrack({id:'audius:abc123',title:'Saved',artist:'Artist',source:'https://evil.example/track'});
  assert.equal(track.source, streamUrl('abc123'));
  assert.equal(reviveFreeTrack({id:'spotify:abc123',title:'Other'}), null);
  assert.equal(reviveFreeTrack({id:'audius:../../bad',title:'Invalid'}), null);
});

test('Attribution links point at the artist page and never leave audius.co', () => {
  assert.equal(toFreeTrack(song()).page, 'https://audius.co');
  assert.equal(toFreeTrack({...song(), permalink: '/LofiArmy/vibes-relaxing'}).page,
    'https://audius.co/LofiArmy/vibes-relaxing');
  for (const bad of ['//evil.example/', 'https://evil.example/audius.co', '../evil', 'javascript:alert(1)', '/a b', 42, null]) {
    assert.equal(toFreeTrack({...song(), permalink: bad}).page, 'https://audius.co', String(bad));
  }
  assert.equal(reviveFreeTrack({id:'audius:abc123',title:'Saved',page:'https://audius.co/me/song'}).page,
    'https://audius.co/me/song');
  for (const bad of ['https://evil.example/x', 'javascript:alert(1)', '//audius.co/x', undefined]) {
    assert.equal(reviveFreeTrack({id:'audius:abc123',title:'Saved',page:bad}).page, 'https://audius.co', String(bad));
  }
});

test('Catalog fetch maps, filters and deduplicates open tracks', async () => {
  const fakeFetch = async (url, options) => {
    assert.match(url, /^https:\/\/api\.audius\.co\/v1\/tracks\/latest/);
    assert.equal(typeof options, 'object');
    return { ok:true, json:async()=>({ data:[song('abc123'), song('abc123'), {...song('abc124'),is_streamable:false},song('abc125')] }) };
  };
  const tracks = await fetchFreeTracks({},fakeFetch);
  assert.deepEqual(tracks.map(t=>t.id),['audius:abc123','audius:abc125']);
});

test('Network errors and malformed API responses surface clearly', async () => {
  await assert.rejects(fetchFreeTracks({},async()=>({ok:false,status:429})),/HTTP 429/);
  await assert.rejects(fetchFreeTracks({},async()=>({ok:true,json:async()=>({nope:[]})})),/Unexpected Audius response/);
});
