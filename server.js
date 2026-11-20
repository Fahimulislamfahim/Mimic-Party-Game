'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const { ensureSeed } = require('./seed');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const MAX_PLAYERS = 8;
const DATA_FILE = path.join(__dirname, 'data', 'sounds.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
ensureSeed();

// ---------------------------------------------------------------- sounds store
const loadSounds = () => { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; } };
const saveSounds = (list) => fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
const publicSound = (s) => ({ id: s.id, name: s.name, audioUrl: '/uploads/' + s.audio, imageUrl: '/uploads/' + s.image, duration: s.duration });

// ---------------------------------------------------------------- http + admin api
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'three', 'build')));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h' }));

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
function requireAdmin(req, res, next) {
  if (crypto.timingSafeEqual(sha(req.get('x-admin-password') || ''), sha(ADMIN_PASSWORD))) return next();
  res.status(401).json({ error: 'Wrong admin password' });
}

const AUDIO_EXT = { 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/ogg': '.ogg', 'audio/webm': '.webm', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/m4a': '.m4a', 'audio/aac': '.aac' };
const IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
const extMap = (field) => (field === 'audio' ? AUDIO_EXT : IMAGE_EXT);
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(8).toString('hex') + extMap(file.fieldname)[file.mimetype]),
  }),
  fileFilter: (req, file, cb) => cb(null, !!extMap(file.fieldname)[file.mimetype]),
  limits: { fileSize: 8 * 1024 * 1024, files: 2 },
});

app.get('/api/admin/sounds', requireAdmin, (req, res) => res.json(loadSounds().map(publicSound)));

app.post('/api/admin/sounds', requireAdmin, upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'image', maxCount: 1 }]), (req, res) => {
  const audio = req.files && req.files.audio && req.files.audio[0];
  const image = req.files && req.files.image && req.files.image[0];
  const cleanup = () => [audio, image].forEach((f) => f && fs.unlink(f.path, () => {}));
  const name = String(req.body.name || '').trim().slice(0, 40);
  const duration = Number(req.body.duration);
  if (!audio || !image) { cleanup(); return res.status(400).json({ error: 'Need an audio file (mp3/wav/ogg/m4a) and an image (png/jpg/webp/gif)' }); }
  if (!name) { cleanup(); return res.status(400).json({ error: 'Name is required' }); }
  if (!(duration >= 0.3 && duration <= 20)) { cleanup(); return res.status(400).json({ error: 'Sound must be between 0.3s and 20s' }); }
  const entry = { id: crypto.randomBytes(6).toString('hex'), name, audio: audio.filename, image: image.filename, duration: +duration.toFixed(2), createdAt: Date.now() };
  saveSounds([...loadSounds(), entry]);
  res.json(publicSound(entry));
});

app.delete('/api/admin/sounds/:id', requireAdmin, (req, res) => {
  const list = loadSounds();
  const hit = list.find((s) => s.id === req.params.id);
  if (!hit) return res.status(404).json({ error: 'Not found' });
  saveSounds(list.filter((s) => s.id !== hit.id));
  [hit.audio, hit.image].forEach((f) => fs.unlink(path.join(UPLOAD_DIR, path.basename(f)), () => {}));
  res.json({ ok: true });
});

app.use((err, req, res, next) => res.status(400).json({ error: err.message || 'Bad request' })); // eslint-disable-line

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

// ---------------------------------------------------------------- game rooms
const rooms = new Map();
const LISTEN_PAD_MS = 800, COUNTDOWN_MS = 3000, RECORD_PAD_MS = 1500, SCORE_WAIT_MS = 7000, RESULTS_MS = 8000, LOAD_WAIT_MS = 6000;
const WIN_BONUS = 10;

const send = (ws, type, data = {}) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, ...data })); };
const broadcast = (room, type, data) => room.players.forEach((p) => send(p.ws, type, data));
const board = (room) => [...room.players.values()].map((p) => ({ id: p.id, name: p.name, score: p.score, isBot: !!p.isBot })).sort((a, b) => b.score - a.score);
const pushState = (room) => broadcast(room, 'state', {
  code: room.code, phase: room.phase, hostId: room.hostId, round: room.round, totalRounds: room.totalRounds,
  players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, score: p.score, isBot: !!p.isBot })),
});
const later = (room, ms, fn) => { clearTimeout(room.timer); room.timer = setTimeout(fn, ms); };

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[crypto.randomInt(letters.length)];
    if (!rooms.has(c)) return c;
  }
}

function addPlayer(room, ws, rawName) {
  let name = String(rawName || '').trim().slice(0, 16) || 'Player';
  const taken = new Set([...room.players.values()].map((p) => p.name.toLowerCase()));
  let n = name, i = 2;
  while (taken.has(n.toLowerCase())) n = `${name} ${i++}`;
  const p = { id: crypto.randomBytes(4).toString('hex'), name: n, ws, score: 0 };
  room.players.set(p.id, p);
  ws.playerId = p.id; ws.roomCode = room.code;
  if (!room.hostId) room.hostId = p.id;
  send(ws, 'joined', { id: p.id, code: room.code });
  pushState(room);
}

function startGame(room, rounds) {
  const sounds = loadSounds();
  if (!sounds.length) return broadcast(room, 'error', { message: 'No sounds yet. Add some at /admin.html' });
  room.totalRounds = Math.max(1, Math.min(15, Number(rounds) || 5));
  room.round = 0; room.used = new Set();
  room.players.forEach((p) => { p.score = 0; });
  nextRound(room);
}

function nextRound(room) {
  room.round++;
  if (room.round > room.totalRounds) return endGame(room);
  const sounds = loadSounds();
  if (!sounds.length) { room.phase = 'lobby'; room.round = 0; pushState(room); return broadcast(room, 'error', { message: 'No sounds available' }); }
  let pool = sounds.filter((s) => !room.used.has(s.id));
  if (!pool.length) { room.used.clear(); pool = sounds; }
  const s = pool[crypto.randomInt(pool.length)];
  room.used.add(s.id);
  room.current = { sound: s, ready: new Set(), scores: new Map() };
  room.phase = 'loading';
  pushState(room);
  broadcast(room, 'round', { round: room.round, total: room.totalRounds, sound: publicSound(s) });
  
  // Bots auto-ready
  room.players.forEach((p) => {
    if (p.isBot) room.current.ready.add(p.id);
  });
  if ([...room.players.keys()].every((id) => room.current.ready.has(id))) {
    later(room, 500, () => beginListen(room));
  } else {
    later(room, LOAD_WAIT_MS, () => beginListen(room));
  }
}

function beginListen(room) {
  if (room.phase !== 'loading') return;
  room.phase = 'listen';
  broadcast(room, 'listen', {});
  later(room, room.current.sound.duration * 1000 + LISTEN_PAD_MS, () => {
    room.phase = 'countdown';
    broadcast(room, 'countdown', { seconds: COUNTDOWN_MS / 1000 });
    later(room, COUNTDOWN_MS, () => {
      const ms = Math.round(room.current.sound.duration * 1000 + RECORD_PAD_MS);
      room.phase = 'record';
      broadcast(room, 'record', { ms });
      
      // Bots auto-record
      room.players.forEach((p) => {
        if (p.isBot) {
          setTimeout(() => {
            if (room.current && (room.phase === 'record' || room.phase === 'scoring')) {
              const base = 35 + Math.random() * 55;
              const score = Math.max(15, Math.min(97, Math.round(base)));
              room.current.scores.set(p.id, score);
              checkAllScored(room);
            }
          }, ms * 0.7 + Math.random() * 400);
        }
      });

      later(room, ms + 800, () => {
        room.phase = 'scoring';
        broadcast(room, 'scoring', {});
        if (!checkAllScored(room)) later(room, SCORE_WAIT_MS, () => finishRound(room));
      });
    });
  });
}

function checkAllScored(room) {
  if (room.phase !== 'scoring') return false;
  for (const id of room.players.keys()) if (!room.current.scores.has(id)) return false;
  finishRound(room);
  return true;
}

function finishRound(room) {
  if (room.phase !== 'scoring') return;
  room.phase = 'results';
  const rows = [...room.players.values()].map((p) => ({ id: p.id, name: p.name, round: room.current.scores.get(p.id) || 0 }));
  const best = Math.max(0, ...rows.map((r) => r.round));
  rows.forEach((r) => { r.bonus = best > 0 && r.round === best ? WIN_BONUS : 0; room.players.get(r.id).score += r.round + r.bonus; });
  rows.sort((a, b) => b.round + b.bonus - (a.round + a.bonus));
  pushState(room);
  broadcast(room, 'results', { round: room.round, total: room.totalRounds, sound: publicSound(room.current.sound), results: rows, leaderboard: board(room), last: room.round >= room.totalRounds });
  const resultsDuration = Math.max(9000, room.players.size * 2600 + 3500);
  later(room, resultsDuration, () => nextRound(room));
}

function endGame(room) {
  room.phase = 'final';
  pushState(room);
  broadcast(room, 'final', { leaderboard: board(room) });
}

function removePlayer(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room || !room.players.delete(ws.playerId)) return;
  if (!room.players.size) { clearTimeout(room.timer); rooms.delete(room.code); return; }
  if (room.hostId === ws.playerId) room.hostId = room.players.keys().next().value;
  pushState(room);
  if (room.phase === 'loading' && [...room.players.keys()].every((id) => room.current.ready.has(id))) beginListen(room);
  checkAllScored(room);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => removePlayer(ws));
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== 'string') return;
    const room = rooms.get(ws.roomCode);

    if (m.type === 'create' && !room) {
      const r = { code: makeCode(), players: new Map(), hostId: null, phase: 'lobby', round: 0, totalRounds: 5, used: new Set(), current: null, timer: null };
      rooms.set(r.code, r);
      return addPlayer(r, ws, m.name);
    }
    if (m.type === 'join' && !room) {
      const r = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!r) return send(ws, 'error', { message: 'Room not found' });
      if (r.phase !== 'lobby') return send(ws, 'error', { message: 'Game already started' });
      if (r.players.size >= MAX_PLAYERS) return send(ws, 'error', { message: 'Room is full' });
      return addPlayer(r, ws, m.name);
    }
    if (!room) return;

    if (m.type === 'start' && ws.playerId === room.hostId && room.phase === 'lobby') return startGame(room, m.rounds);
    if (m.type === 'add_bot' && ws.playerId === room.hostId && room.phase === 'lobby') {
      if (room.players.size >= MAX_PLAYERS) return;
      const botPool = ['Rogue-V', 'Illusion', 'Kikiglimpse', 'Ankmay', 'Buzzer', 'Echo'];
      const taken = new Set([...room.players.values()].map((p) => p.name.toLowerCase()));
      const chosen = botPool.find((n) => !taken.has(n.toLowerCase())) || ('Bot ' + (room.players.size + 1));
      const b = { id: 'bot_' + crypto.randomBytes(3).toString('hex'), name: chosen, ws: null, score: 0, isBot: true };
      room.players.set(b.id, b);
      return pushState(room);
    }
    if (m.type === 'remove_bot' && ws.playerId === room.hostId && room.phase === 'lobby') {
      const bots = [...room.players.values()].filter((p) => p.isBot);
      if (bots.length) {
        const last = bots[bots.length - 1];
        room.players.delete(last.id);
        return pushState(room);
      }
    }
    if (m.type === 'again' && ws.playerId === room.hostId && room.phase === 'final') { room.phase = 'lobby'; room.round = 0; room.players.forEach((p) => { p.score = 0; }); return pushState(room); }
    if (m.type === 'ready' && room.phase === 'loading') {
      room.current.ready.add(ws.playerId);
      if ([...room.players.keys()].every((id) => room.current.ready.has(id))) beginListen(room);
      return;
    }
    if (m.type === 'score' && (room.phase === 'record' || room.phase === 'scoring') && !room.current.scores.has(ws.playerId)) {
      const s = Math.round(Number(m.score));
      room.current.scores.set(ws.playerId, Number.isFinite(s) ? Math.max(0, Math.min(100, s)) : 0);
      checkAllScored(room);
    }
  });
});

setInterval(() => wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 30000);

server.listen(PORT, () => {
  console.log(`Mimic Party running on http://localhost:${PORT}`);
  console.log(`Admin page: http://localhost:${PORT}/admin.html  (password: ${ADMIN_PASSWORD === 'admin' ? '"admin" - set ADMIN_PASSWORD to change it' : 'from ADMIN_PASSWORD'})`);
});
