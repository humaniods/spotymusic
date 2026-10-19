/**
 * Three original browser-synthesized instrumentals. No Spotify audio is used.
 * Generated as PCM WAV in memory so this static app needs no audio hosting.
 */
const RATE = 11025;
const ROOTS = [196, 146.83, 220];
const SCALES = [
  [0, 4, 7, 11, 7, 4, 2, 7],
  [0, 3, 7, 10, 7, 5, 3, 7],
  [0, 5, 9, 12, 9, 5, 4, 7]
];

export function synthesizeDemo(seed = 0, seconds = 20) {
  const samples = Math.floor(RATE * seconds);
  const bytes = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(bytes);
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true);
  write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); write(36, 'data');
  view.setUint32(40, samples * 2, true);

  const root = ROOTS[seed % ROOTS.length];
  const pattern = SCALES[seed % SCALES.length];
  const beat = seed === 1 ? .42 : seed === 2 ? .62 : .52;
  for (let i = 0; i < samples; i++) {
    const t = i / RATE;
    const index = Math.floor(t / beat);
    const note = pattern[index % pattern.length];
    const frequency = root * 2 ** (note / 12);
    const phase = t * 2 * Math.PI;
    const pulse = (t % beat) / beat;
    const attack = Math.min(1, pulse * 35);
    const fall = Math.exp(-pulse * 3.2);
    const melody = Math.sin(phase * frequency) * .31
      + Math.sin(phase * frequency * 2) * .085
      + Math.sin(phase * frequency * .5) * .10;
    const bass = Math.sin(phase * root * .5) * .18 * Math.exp(-pulse * 5);
    const kickPulse = (t % (beat * 2)) / beat;
    const kick = Math.sin(2 * Math.PI * (63 - kickPulse * 12) * t)
      * Math.exp(-kickPulse * 14) * .14;
    const fade = Math.min(1, t / .4, (seconds - t) / 1.2);
    const output = Math.max(-1, Math.min(1,
      (melody * attack * fall + bass + kick) * Math.max(0, fade)));
    view.setInt16(44 + i * 2, Math.round(output * 32767), true);
  }
  return bytes;
}

export function makeDemo(seed = 0) {
  return URL.createObjectURL(new Blob([synthesizeDemo(seed)], { type: 'audio/wav' }));
}
