import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeDemo } from '../src/demo-audio.mjs';

test('generated demo is a correctly sized playable PCM WAV', () => {
  const buffer = synthesizeDemo(0, 1);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  assert.equal(new TextDecoder().decode(bytes.slice(0,4)), 'RIFF');
  assert.equal(new TextDecoder().decode(bytes.slice(8,12)), 'WAVE');
  assert.equal(new TextDecoder().decode(bytes.slice(36,40)), 'data');
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 11025);
  assert.equal(buffer.byteLength, 44 + 11025 * 2);
});

test('different demo seeds produce different music', () => {
  const first = new Uint8Array(synthesizeDemo(0, 1));
  const second = new Uint8Array(synthesizeDemo(1, 1));
  assert.notDeepEqual(first.subarray(44, 400), second.subarray(44, 400));
});
