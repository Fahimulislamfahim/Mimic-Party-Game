'use strict';
// Sanity test for scoring using synthetic "voices" (formant synthesis). Real voices still need tuning.
const { computeScore } = require('../public/score.js');
const SR = 16000;

function resonate(x, f, bw) {
  const r = Math.exp(-Math.PI * bw / SR), a1 = -2 * r * Math.cos(2 * Math.PI * f / SR), a2 = r * r, y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] - a1 * (i > 0 ? y[i - 1] : 0) - a2 * (i > 1 ? y[i - 2] : 0);
  return y;
}
// syllables: [seconds, f0Start, f0End, [F1,F2,F3], gapAfter]
function voice(sylls, { pitch = 1, formant = 1, stretch = 1, gain = 1, noise = 0 } = {}) {
  const parts = [];
  for (const [dur, f0a, f0b, F, gap] of sylls) {
    const n = Math.floor(dur * stretch * SR), src = new Float32Array(n); let ph = 0;
    for (let i = 0; i < n; i++) { const u = i / n, f0 = (f0a + (f0b - f0a) * u) * pitch; ph = (ph + f0 / SR) % 1; src[i] = (2 * ph - 1) * Math.min(1, u * 15, (1 - u) * 8); }
    let y = new Float32Array(n);
    F.forEach((f, k) => { const r = resonate(src, f * formant, 80 + 40 * k); for (let i = 0; i < n; i++) y[i] += r[i] / (k + 1); });
    parts.push(y, new Float32Array(Math.floor(gap * stretch * SR)));
  }
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0)); let p = 0; for (const x of parts) { out.set(x, p); p += x.length; }
  let mx = 0; for (const v of out) mx = Math.max(mx, Math.abs(v));
  for (let i = 0; i < out.length; i++) out[i] = (out[i] / mx) * 0.5 * gain + (Math.random() * 2 - 1) * noise;
  return out;
}
const AH = [750, 1200, 2500], EE = [300, 2300, 3000], OO = [330, 900, 2400], EH = [550, 1800, 2500];
const REF = [[0.25, 140, 170, AH, 0.08], [0.25, 170, 120, EE, 0.15], [0.45, 130, 100, OO, 0]];
const OTHER_PATTERN = [[0.5, 120, 120, EH, 0.3], [0.12, 200, 220, OO, 0.05], [0.12, 220, 240, AH, 0.05], [0.12, 240, 260, EE, 0]];

const ref = voice(REF);
const noiseBurst = (() => { const x = new Float32Array(SR * 1.2); for (let i = 0; i < x.length; i++) x[i] = (Math.random() * 2 - 1) * 0.4; return x; })();
const cases = [
  ['identical', ref],
  ['same, quieter + mic noise', voice(REF, { gain: 0.3, noise: 0.004 })],
  ['same, 15% slower', voice(REF, { stretch: 1.15, noise: 0.003 })],
  ['same words, different speaker (higher voice)', voice(REF, { pitch: 1.6, formant: 1.18, noise: 0.003 })],
  ['same words, flat monotone', voice(REF.map(([d, a, b, F, g]) => [d, 140, 140, F, g]), { noise: 0.003 })],
  ['same rhythm, wrong vowels', voice(REF.map(([d, a, b, F, g], i) => [d, a, b, [EH, EH, EH][i], g]), { noise: 0.003 })],
  ['different rhythm and vowels', voice(OTHER_PATTERN, { noise: 0.003 })],
  ['half the length', voice(REF, { stretch: 0.5, noise: 0.003 })],
  ['white noise burst', noiseBurst],
  ['silence + faint hiss', (() => { const x = new Float32Array(SR * 1.5); for (let i = 0; i < x.length; i++) x[i] = (Math.random() - 0.5) * 0.004; return x; })()],
];
for (const [name, sig] of cases) {
  const r = computeScore(ref, SR, sig, SR);
  console.log(String(r.score).padStart(3), ' ', name.padEnd(46), JSON.stringify({ d: r.dist, len: r.lenRatio, why: r.reason }));
}
// resampling path: same signal arriving at 48 kHz
const up = new Float32Array(ref.length * 3); for (let i = 0; i < up.length; i++) up[i] = ref[Math.floor(i / 3)];
console.log(String(computeScore(ref, SR, up, 48000).score).padStart(3), '  identical but recorded at 48 kHz');
