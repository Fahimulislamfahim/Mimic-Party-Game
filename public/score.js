/* Voice-mimic scoring: compares a player's recording to the reference sound.
 * Features per 20ms frame: 12 MFCCs (speaker-normalised) + loudness contour.
 * Silence is trimmed from both clips, then DTW aligns them so timing slack is forgiven.
 * Runs in the browser (window.Score) and in Node (module.exports) so it can be tested.
 * TUNING: the constants below were calibrated on synthetic audio. Adjust D_GOOD / D_BAD
 * after trying real voices (open the console, each round logs the raw distance). */
(function (root) {
  'use strict';
  const SR = 16000, WIN = 400, HOP = 320, NFFT = 512, NMEL = 24, NCEP = 12;
  const MIN_PEAK = 0.006;      // below this the recording is treated as silence
  const W_MFCC = 1.0, W_ENERGY = 1.6;
  const D_GOOD = 0.9, D_BAD = 2.6, GAMMA = 1.15;

  function resample(x, from, to) {
    if (from === to) return x;
    const n = Math.floor((x.length * to) / from), out = new Float32Array(n), r = from / to;
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * r), b = Math.max(a + 1, Math.min(x.length, Math.floor((i + 1) * r)));
      let s = 0; for (let j = a; j < b; j++) s += x[j];
      out[i] = s / (b - a);
    }
    return out;
  }

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < h; k++) {
          const a = i + k, b = a + h;
          const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }

  const mel = (f) => 2595 * Math.log10(1 + f / 700), imel = (m) => 700 * (Math.pow(10, m / 2595) - 1);
  let FILTERS = null, HAMMING = null, DCT = null;
  function init() {
    if (FILTERS) return;
    HAMMING = new Float32Array(WIN); for (let i = 0; i < WIN; i++) HAMMING[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (WIN - 1));
    const lo = mel(60), hi = mel(SR / 2 - 400), pts = [];
    for (let i = 0; i < NMEL + 2; i++) pts.push(Math.floor((NFFT + 1) * imel(lo + (hi - lo) * i / (NMEL + 1)) / SR));
    FILTERS = [];
    for (let m = 1; m <= NMEL; m++) {
      const f = new Float32Array(NFFT / 2 + 1);
      for (let k = pts[m - 1]; k < pts[m]; k++) f[k] = (k - pts[m - 1]) / Math.max(1, pts[m] - pts[m - 1]);
      for (let k = pts[m]; k < pts[m + 1]; k++) f[k] = (pts[m + 1] - k) / Math.max(1, pts[m + 1] - pts[m]);
      FILTERS.push(f);
    }
    DCT = []; for (let c = 1; c <= NCEP; c++) { const r = new Float32Array(NMEL); for (let m = 0; m < NMEL; m++) r[m] = Math.cos(Math.PI * c * (m + 0.5) / NMEL); DCT.push(r); }
  }

  // returns null if silent / too short
  function features(samples, rate) {
    init();
    const x = resample(samples, rate, SR);
    const nf = Math.floor((x.length - WIN) / HOP) + 1;
    if (nf < 5) return null;
    const rms = new Float32Array(nf), ceps = [], re = new Float32Array(NFFT), im = new Float32Array(NFFT);
    for (let f = 0; f < nf; f++) {
      const o = f * HOP; let e = 0;
      for (let i = 0; i < WIN; i++) e += x[o + i] * x[o + i];
      rms[f] = Math.sqrt(e / WIN);
      re.fill(0); im.fill(0);
      for (let i = 0; i < WIN; i++) re[i] = ((x[o + i] - (i ? 0.97 * x[o + i - 1] : 0))) * HAMMING[i];
      fft(re, im);
      const lm = new Float32Array(NMEL);
      for (let m = 0; m < NMEL; m++) {
        let s = 0; const fl = FILTERS[m];
        for (let k = 0; k <= NFFT / 2; k++) if (fl[k]) s += fl[k] * (re[k] * re[k] + im[k] * im[k]);
        lm[m] = Math.log(s + 1e-9);
      }
      const c = new Float32Array(NCEP);
      for (let k = 0; k < NCEP; k++) { let s = 0; for (let m = 0; m < NMEL; m++) s += lm[m] * DCT[k][m]; c[k] = s; }
      ceps.push(c);
    }
    let peak = 0; for (let f = 0; f < nf; f++) if (rms[f] > peak) peak = rms[f];
    if (peak < MIN_PEAK) return { silent: true, peak };
    const thr = Math.max(MIN_PEAK, peak * 0.08);
    let first = -1, last = -1;
    for (let f = 0; f < nf; f++) if (rms[f] >= thr) { if (first < 0) first = f; last = f; }
    first = Math.max(0, first - 2); last = Math.min(nf - 1, last + 2);
    const n = last - first + 1; if (n < 4) return null;
    // speaker/mic normalisation on active frames only
    const mean = new Float32Array(NCEP), sd = new Float32Array(NCEP); let cnt = 0;
    for (let f = first; f <= last; f++) if (rms[f] >= thr) { cnt++; for (let k = 0; k < NCEP; k++) mean[k] += ceps[f][k]; }
    for (let k = 0; k < NCEP; k++) mean[k] /= cnt;
    for (let f = first; f <= last; f++) if (rms[f] >= thr) for (let k = 0; k < NCEP; k++) sd[k] += (ceps[f][k] - mean[k]) ** 2;
    for (let k = 0; k < NCEP; k++) sd[k] = Math.sqrt(sd[k] / cnt) + 1e-3;
    const mf = [], en = new Float32Array(n), maxDb = 20 * Math.log10(peak);
    for (let f = first; f <= last; f++) {
      const act = rms[f] >= thr, v = new Float32Array(NCEP);
      if (act) for (let k = 0; k < NCEP; k++) v[k] = Math.max(-3, Math.min(3, (ceps[f][k] - mean[k]) / sd[k]));
      mf.push(v);
      en[f - first] = Math.max(-45, 20 * Math.log10(rms[f] + 1e-5) - maxDb) / 15;
    }
    return { silent: false, n, mf, en, peak };
  }

  function dtw(A, B) {
    const n = A.n, m = B.n, band = Math.max(Math.abs(n - m), Math.ceil(0.3 * Math.max(n, m))) + 2;
    let pc = new Float32Array(m + 1).fill(Infinity), pl = new Float32Array(m + 1);
    let cc = new Float32Array(m + 1), cl = new Float32Array(m + 1);
    pc[0] = 0;
    for (let i = 1; i <= n; i++) {
      cc.fill(Infinity); cl.fill(0);
      const lo = Math.max(1, Math.round(i * m / n) - band), hi = Math.min(m, Math.round(i * m / n) + band);
      const a = A.mf[i - 1], ae = A.en[i - 1];
      for (let j = lo; j <= hi; j++) {
        const b = B.mf[j - 1]; let s = 0;
        for (let k = 0; k < NCEP; k++) { const d = a[k] - b[k]; s += d * d; }
        const de = ae - B.en[j - 1];
        const d = Math.sqrt((W_MFCC * s / NCEP) + W_ENERGY * de * de * 4);
        let best = pc[j - 1], bl = pl[j - 1];
        if (pc[j] < best) { best = pc[j]; bl = pl[j]; }
        if (cc[j - 1] < best) { best = cc[j - 1]; bl = cl[j - 1]; }
        cc[j] = best + d; cl[j] = bl + 1;
      }
      [pc, cc] = [cc, pc]; [pl, cl] = [cl, pl];
    }
    return pc[m] / Math.max(1, pl[m]);
  }

  // distance with no time warping (frame i <-> i scaled): punishes wrong rhythm
  function linear(A, B) {
    const n = Math.max(A.n, B.n); let tot = 0;
    for (let i = 0; i < n; i++) {
      const ia = Math.min(A.n - 1, Math.round(i * (A.n - 1) / (n - 1))), ib = Math.min(B.n - 1, Math.round(i * (B.n - 1) / (n - 1)));
      const a = A.mf[ia], b = B.mf[ib]; let s = 0;
      for (let k = 0; k < NCEP; k++) { const d = a[k] - b[k]; s += d * d; }
      const de = A.en[ia] - B.en[ib];
      tot += Math.sqrt((W_MFCC * s / NCEP) + W_ENERGY * de * de * 4);
    }
    return tot / n;
  }

  function computeScore(ref, refRate, rec, recRate) {
    const R = features(ref, refRate), P = features(rec, recRate);
    if (!R || R.silent) return { score: 0, reason: 'bad-reference' };
    if (!P) return { score: 0, reason: 'too-short' };
    if (P.silent) return { score: 0, reason: 'silent' };
    const dist = 0.55 * dtw(R, P) + 0.45 * linear(R, P);
    const ratio = Math.min(R.n, P.n) / Math.max(R.n, P.n);
    let s = Math.pow(Math.max(0, Math.min(1, (D_BAD - dist) / (D_BAD - D_GOOD))), GAMMA) * 100;
    s *= Math.pow(Math.min(1, ratio / 0.8), 1.5);  // within ~20% of the right length is free; far off costs a lot
    s = Math.max(6, Math.min(100, s));             // any real attempt gets a few points
    return { score: Math.round(s), dist: +dist.toFixed(3), lenRatio: +ratio.toFixed(2) };
  }

  const api = { computeScore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Score = api;
})(typeof window !== 'undefined' ? window : globalThis);
