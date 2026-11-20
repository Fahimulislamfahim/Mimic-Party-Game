'use strict';
// Creates 3 tiny placeholder sounds + images so the game is playable on first run.
// Replace them from /admin.html with real meme sounds.
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'sounds.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

function wav(samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-1, Math.min(1, samples[i])) * 32767 | 0, 44 + i * 2);
  return buf;
}

function tone(rate, secs, fn) {
  const n = Math.floor(rate * secs), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(i / rate, i / n);
  return out;
}
const cat = (...a) => { const o = new Float32Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const gap = (rate, s) => new Float32Array(Math.floor(rate * s));
const env = (u) => Math.min(1, u * 12, (1 - u) * 12);

function makeSounds() {
  const R = 22050;
  const beep = cat(
    tone(R, 0.25, (t, u) => 0.6 * env(u) * Math.sin(2 * Math.PI * 440 * t)), gap(R, 0.12),
    tone(R, 0.25, (t, u) => 0.6 * env(u) * Math.sin(2 * Math.PI * 880 * t)), gap(R, 0.12),
    tone(R, 0.45, (t, u) => 0.6 * env(u) * Math.sin(2 * Math.PI * 330 * t)));
  const siren = tone(R, 1.8, (t, u) => 0.6 * env(u) * Math.sin(2 * Math.PI * (500 + 300 * Math.sin(2 * Math.PI * 1.2 * t)) * t));
  const laser = cat(
    tone(R, 0.35, (t, u) => 0.6 * env(u) * Math.sin(2 * Math.PI * (1800 - 1500 * u) * t)), gap(R, 0.15),
    tone(R, 0.35, (t, u) => 0.6 * env(u) * Math.sin(2 * Math.PI * (1800 - 1500 * u) * t)), gap(R, 0.15),
    tone(R, 0.6, (t, u) => 0.6 * env(u) * Math.sin(2 * Math.PI * (900 - 700 * u) * t)));
  return [
    { name: 'Beep Boop', rate: R, data: beep, color: '#7c5cff', text: 'BEEP BOOP' },
    { name: 'Wobble Siren', rate: R, data: siren, color: '#ff5c7c', text: 'WEE-OO' },
    { name: 'Laser Pew', rate: R, data: laser, color: '#18b88a', text: 'PEW PEW' },
  ];
}

function ensureSeed() {
  if (fs.existsSync(DATA_FILE)) return;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const list = makeSounds().map((s, i) => {
    const id = 'seed' + (i + 1);
    const audio = id + '.wav', image = id + '.svg';
    fs.writeFileSync(path.join(UPLOAD_DIR, audio), wav(s.data, s.rate));
    fs.writeFileSync(path.join(UPLOAD_DIR, image),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320"><rect width="320" height="320" rx="36" fill="${s.color}"/>` +
      `<text x="160" y="175" font-family="Arial,sans-serif" font-weight="800" font-size="40" fill="#fff" text-anchor="middle">${s.text}</text></svg>`);
    return { id, name: s.name, audio, image, duration: +(s.data.length / s.rate).toFixed(2), createdAt: Date.now() };
  });
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
  console.log('Seeded', list.length, 'placeholder sounds');
}

module.exports = { ensureSeed };
if (require.main === module) { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); ensureSeed(); }
