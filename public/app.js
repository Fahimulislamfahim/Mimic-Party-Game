import { MimicStage } from './stage3d.js';
import { SoundEffects } from './sfx.js';

(() => {
'use strict';

const $ = (s) => document.querySelector(s);
const COLORS = ['#e63946', '#2a6fdb', '#2ecc71', '#ff9f1a', '#9b5de5', '#00d2d3'];

let ws = null, me = null, hostId = null, players = [], phase = 'home';
let ac = null, micStream = null, micOk = false, micReason = '', analyser = null;
const decoded = new Map(); // soundId -> AudioBuffer
let sound = null, buf = null, peaks = [], playStart = 0, playing = false, recording = null, raf = 0;
let resultsQueueRunning = false;

// Initialize 3D Stage & SFX
const stageContainer = $('#stage3d');
const stage = new MimicStage(stageContainer);
const sfx = new SoundEffects();

const show = (id) => {
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== id; });
  phase = id;
  const topBar = $('#topBar');
  if (id === 'play' || id === 'lobby' || id === 'final') {
    topBar.hidden = false;
  } else {
    topBar.hidden = true;
  }
};

const send = (type, data = {}) => ws && ws.readyState === 1 && ws.send(JSON.stringify({ type, ...data }));

// ------------------------------------------------------------ Audio Setup
async function initAudio() {
  ac = ac || new (window.AudioContext || window.webkitAudioContext)();
  if (ac.state === 'suspended') await ac.resume();
  sfx.ensureContext();
  if (micStream) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    micOk = false;
    micReason = 'Mic needs a secure (https or localhost) connection.';
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
    });
    micOk = true;
    analyser = ac.createAnalyser();
    analyser.fftSize = 512;
    ac.createMediaStreamSource(micStream).connect(analyser);
  } catch (e) {
    micOk = false;
    micReason = 'Microphone blocked. You can still watch, but score will be 0.';
  }
}

async function loadSound(s) {
  if (decoded.has(s.id)) return decoded.get(s.id);
  const res = await fetch(s.audioUrl);
  const b = await ac.decodeAudioData(await res.arrayBuffer());
  decoded.set(s.id, b);
  return b;
}

function computePeaks(b, n = 90) {
  const d = b.getChannelData(0), step = Math.max(1, Math.floor(d.length / n)), out = [];
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = i * step; j < Math.min(d.length, (i + 1) * step); j++) m = Math.max(m, Math.abs(d[j]));
    out.push(m);
  }
  const mx = Math.max(...out, 0.001);
  return out.map((v) => v / mx);
}

function drawWave(progress, color) {
  const c = $('#wave');
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const n = peaks.length;
  if (!n) return;
  const bw = w / n;
  for (let i = 0; i < n; i++) {
    const bh = Math.max(4, peaks[i] * (h - 18));
    g.fillStyle = i / n <= progress ? color : '#1e3845';
    g.fillRect(i * bw + 1, (h - bh) / 2, Math.max(1, bw - 2), bh);
  }
}

function playReference() {
  const src = ac.createBufferSource();
  src.buffer = buf;

  // Analyser node to measure bass for stage speakers
  const soundAnalyser = ac.createAnalyser();
  soundAnalyser.fftSize = 256;
  src.connect(soundAnalyser);
  soundAnalyser.connect(ac.destination);
  src.start();

  playStart = ac.currentTime;
  playing = true;

  src.onended = () => {
    playing = false;
    stage.setBassLevel(0);
    $('#memeBox').hidden = true;
  };

  const dataArray = new Uint8Array(soundAnalyser.frequencyBinCount);
  const tick = () => {
    if (!playing) {
      drawWave(1, '#ffc83b');
      return;
    }
    const prog = (ac.currentTime - playStart) / buf.duration;
    drawWave(prog, '#ffc83b');

    // Feed bass into 3D stage speakers
    soundAnalyser.getByteFrequencyData(dataArray);
    let lowFreqSum = 0;
    for (let i = 0; i < 8; i++) lowFreqSum += dataArray[i];
    const bass = (lowFreqSum / (8 * 255)) * 1.4;
    stage.setBassLevel(bass);

    raf = requestAnimationFrame(tick);
  };
  cancelAnimationFrame(raf);
  tick();
}

function micLevel() {
  if (!analyser) return 0;
  const a = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(a);
  let s = 0;
  for (const v of a) {
    const x = (v - 128) / 128;
    s += x * x;
  }
  return Math.min(1, Math.sqrt(s / a.length) * 4);
}

function recordFor(ms) {
  return new Promise((resolve) => {
    if (!micOk) return resolve(null);
    let rec;
    const chunks = [];
    try {
      rec = new MediaRecorder(micStream);
    } catch (e) {
      return resolve(null);
    }
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType }));
    rec.start();
    setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, ms);
  });
}

async function doRecordRound(ms) {
  $('#subtitle').textContent = 'Make the sound with your voice!';
  const overlay = $('#statusOverlay');
  overlay.textContent = 'GO!';
  sfx.go();

  // All 3D characters animate mouth and sing
  players.forEach((p) => stage.setPerformerState(p.id, 'singing'));

  const t0 = performance.now();
  cancelAnimationFrame(raf);
  const tick = () => {
    if (recording === null) return;
    const lvl = micLevel();
    drawWave(Math.min(1, (performance.now() - t0) / ms), '#00e5ff');
    $('#level').style.width = Math.round(lvl * 100) + '%';
    stage.setBassLevel(lvl * 1.5);
    stage.setMouthAperture(me, lvl * 2.5);
    raf = requestAnimationFrame(tick);
  };
  recording = true;
  tick();

  const blob = await recordFor(ms);
  recording = null;
  $('#level').style.width = '0';
  overlay.textContent = '';
  players.forEach((p) => stage.setPerformerState(p.id, 'idle'));

  let score = 0;
  try {
    if (blob && blob.size) {
      const rb = await ac.decodeAudioData(await blob.arrayBuffer());
      const res = Score.computeScore(buf.getChannelData(0), buf.sampleRate, rb.getChannelData(0), rb.sampleRate);
      score = res.score;
    }
  } catch (e) {
    console.warn('Scoring error', e);
  }
  send('score', { score });
}

// ------------------------------------------------------------ Top Avatar Cards
function renderPlayerCards(activeId = null, scoringId = null) {
  const container = $('#playerCards');
  container.innerHTML = '';

  players.forEach((p, idx) => {
    const card = document.createElement('div');
    card.className = 'player-card' +
      (p.id === activeId ? ' active' : '') +
      (p.id === scoringId ? ' scoring' : '');

    // Hairstyle based on name
    let hairSvg = '';
    const lowerName = p.name.toLowerCase();
    if (lowerName.includes('illusion')) {
      hairSvg = '<path d="M4 18 Q22 2 40 18 Q32 8 18 10 Z" fill="#3d2110"/>';
    } else if (lowerName.includes('kiki')) {
      hairSvg = '<polygon points="18,12 26,2 28,12" fill="#e6b800"/>';
    }

    const avatarSvg = `
      <svg class="card-avatar-svg" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r="18" fill="#f5c396" stroke="#222" stroke-width="2"/>
        ${hairSvg}
        <ellipse cx="16" cy="20" rx="3" ry="4" fill="#111"/>
        <ellipse cx="28" cy="20" rx="3" ry="4" fill="#111"/>
        <circle cx="17" cy="18" r="1" fill="#fff"/>
        <circle cx="29" cy="18" r="1" fill="#fff"/>
        <path d="M16 28 Q22 34 28 28" stroke="#333" stroke-width="2" fill="none" stroke-linecap="round"/>
      </svg>
    `;

    card.innerHTML = `
      <div class="card-avatar-wrap">${avatarSvg}</div>
      <div class="card-name">${escapeHtml(p.name)}</div>
      <div class="card-score-pill"><span class="coin">🪙</span><span id="score_${p.id}">${p.score}</span></div>
    `;
    container.appendChild(card);
  });
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>'"]/g,
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag));
}

// ------------------------------------------------------------ WebSocket Handling
function connect(onOpen) {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = onOpen;
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    if (phase !== 'home') {
      show('home');
      $('#homeErr').textContent = 'Disconnected from server.';
    }
  };
}

function handle(m) {
  switch (m.type) {
    case 'joined':
      me = m.id;
      $('#roomCode').textContent = m.code;
      break;
    case 'state':
      players = m.players;
      hostId = m.hostId;
      $('#roomCode').textContent = m.code;
      stage.updatePlayers(players, me);
      renderPlayerCards();
      if (m.phase === 'lobby') {
        show('lobby');
        renderLobby();
      }
      break;
    case 'error':
      if (phase === 'home') $('#homeErr').textContent = m.message;
      else $('#lobbyErr').textContent = m.message;
      break;
    case 'round':
      onRound(m);
      break;
    case 'listen':
      onListen();
      break;
    case 'countdown':
      onCountdown(m.seconds);
      break;
    case 'record':
      doRecordRound(m.ms);
      break;
    case 'scoring':
      $('#statusOverlay').textContent = '...';
      $('#subtitle').textContent = 'Evaluating your mimic accuracy...';
      break;
    case 'results':
      onResults(m);
      break;
    case 'final':
      renderFinal(m);
      break;
  }
}

async function onRound(m) {
  sound = m.sound;
  buf = null;
  peaks = [];
  show('play');

  $('#statusOverlay').textContent = '';
  $('#subtitle').textContent = `Round ${m.round} of ${m.total} - Loading sound...`;
  $('#performerPointer').hidden = true;
  $('#stageScoreBanner').hidden = true;
  $('#memeBox').hidden = true;

  stage.setCameraMode('overview');
  renderPlayerCards();

  try {
    buf = await loadSound(sound);
    peaks = computePeaks(buf);
    drawWave(0, '#ffc83b');
  } catch (e) {
    console.warn('Failed to load audio', e);
  }
  send('ready');
}

function onListen() {
  $('#memeBox').hidden = false;
  $('#meme').src = sound.imageUrl;
  $('#soundName').textContent = sound.name;
  $('#subtitle').textContent = 'Listen carefully to the demo';
  $('#statusOverlay').textContent = '';
  if (buf) playReference();
}

function onCountdown(sec) {
  $('#memeBox').hidden = true;
  $('#subtitle').textContent = 'Everyone at once - one shot only!';
  stage.setCameraMode('performer');

  let n = sec;
  const overlay = $('#statusOverlay');
  const step = () => {
    if (n <= 0) return;
    sfx.tick();
    overlay.textContent = String(n--);
    setTimeout(step, 1000);
  };
  step();
  drawWave(0, '#00e5ff');
}

// ------------------------------------------------------------ Sequential 3D Turn Reveal
async function onResults(m) {
  if (resultsQueueRunning) return;
  resultsQueueRunning = true;

  const rows = m.results || [];
  const leaderboardMap = new Map((m.leaderboard || []).map((p) => [p.id, p.score]));

  $('#subtitle').textContent = 'Round Results! Watch the stage!';
  $('#statusOverlay').textContent = '';

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const playerId = row.id;
    const score = row.round;

    // 1. Highlight top card and walk player to microphone
    renderPlayerCards(playerId);
    $('#performerName').textContent = row.name;
    $('#performerPointer').hidden = false;

    await new Promise((resolve) => stage.walkPlayerToMic(playerId, resolve));

    // 2. Play tension drumroll and mimic animation
    sfx.drumroll(1.3);
    stage.setPerformerState(playerId, 'singing');
    await waitMs(1200);
    stage.setPerformerState(playerId, 'idle');

    // 3. Score Drop Reveal!
    const banner = $('#stageScoreBanner');
    const bannerScore = $('#bannerScore');
    const bannerBonus = $('#bannerBonus');

    bannerScore.textContent = `${score} / 100`;
    bannerScore.className = 'big-score' + (score >= 75 ? '' : score >= 45 ? ' mid' : ' low');

    if (row.bonus) {
      bannerBonus.textContent = `Bonus: +${row.bonus}`;
      bannerBonus.hidden = false;
    } else {
      bannerBonus.hidden = true;
    }
    banner.hidden = false;

    // 4. Sound & Character Reactions
    sfx.reveal(score);
    if (score >= 70) {
      stage.burstConfetti();
      stage.setPerformerState(playerId, 'celebrating');
    } else if (score < 40) {
      stage.setPerformerState(playerId, 'disappointed');
    }

    // 5. Roll up top card score
    renderPlayerCards(playerId, playerId);
    const scoreEl = $(`#score_${playerId}`);
    if (scoreEl && leaderboardMap.has(playerId)) {
      scoreEl.textContent = leaderboardMap.get(playerId);
    }
    if (row.bonus) sfx.bonus();

    // Enjoy the moment on stage
    await waitMs(2100);

    // 6. Return player to lineup
    banner.hidden = true;
    $('#performerPointer').hidden = true;
    await new Promise((resolve) => stage.returnPlayerToLine(playerId, resolve));
    renderPlayerCards();
    await waitMs(400);
  }

  resultsQueueRunning = false;
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------ Final View
function renderFinal(m) {
  show('final');
  stage.setCameraMode('overview');
  stage.burstConfetti();

  const [winner] = m.leaderboard || [];
  $('#podium').textContent = winner ? `Winner: ${winner.name} (${winner.score} pts)` : '';

  if (winner) {
    stage.setPerformerState(winner.id, 'celebrating');
  }

  const box = $('#finalList');
  box.replaceChildren();

  (m.leaderboard || []).forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'final-row' + (i === 0 ? ' first' : '') + (p.id === me ? ' me' : '');
    row.innerHTML = `
      <div class="final-rank">#${i + 1}</div>
      <div class="final-name">${escapeHtml(p.name)}</div>
      <div class="final-score">${p.score} pts</div>
    `;
    box.appendChild(row);
  });

  const isHost = me === hostId;
  $('#again').hidden = !isHost;
  $('#waitAgain').hidden = isHost;
}

// ------------------------------------------------------------ Lobby
function renderLobby() {
  const ul = $('#players');
  ul.innerHTML = '';

  players.forEach((p) => {
    const li = document.createElement('li');
    const dot = document.createElement('div');
    dot.className = 'p-dot';
    dot.textContent = p.name.slice(0, 1).toUpperCase();
    dot.style.background = COLORS[Math.abs(p.name.charCodeAt(0)) % COLORS.length];

    const nameSpan = document.createElement('span');
    nameSpan.className = 'p-name';
    nameSpan.textContent = p.name + (p.id === me ? ' (You)' : '');

    li.append(dot, nameSpan);

    if (p.id === hostId) {
      const tag = document.createElement('span');
      tag.className = 'tag-host';
      tag.textContent = 'HOST';
      li.append(tag);
    }
    if (p.isBot) {
      const botTag = document.createElement('span');
      botTag.className = 'tag-bot';
      botTag.textContent = 'AI BOT';
      li.append(botTag);
    }
    ul.append(li);
  });

  $('#count').textContent = `${players.length}/8`;
  const isHost = me === hostId;
  $('#hostBox').hidden = !isHost;
  $('#waitHost').hidden = isHost;
  $('#micNote').textContent = micOk ? 'Microphone ready.' : micReason;
}

// ------------------------------------------------------------ Events
async function enter(kind) {
  const name = $('#name').value.trim();
  const code = $('#code').value.trim().toUpperCase();
  const err = $('#homeErr');
  err.textContent = '';

  if (!name) return (err.textContent = 'Please enter your name first');
  if (kind === 'join' && code.length !== 4) return (err.textContent = 'Please enter a 4-letter room code');

  $('#create').disabled = $('#join').disabled = true;
  await initAudio();
  $('#create').disabled = $('#join').disabled = false;

  connect(() => send(kind, { name, code }));
}

$('#create').onclick = () => enter('create');
$('#join').onclick = () => enter('join');

$('#code').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/[^a-z]/gi, '').toUpperCase();
});

$('#name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') enter($('#code').value ? 'join' : 'create');
});

$('#start').onclick = () => send('start', { rounds: Number($('#rounds').value) });
$('#again').onclick = () => send('again');

// Bot management buttons
$('#addBot').onclick = () => send('add_bot');
$('#remBot').onclick = () => send('remove_bot');

const params = new URLSearchParams(location.search);
if (params.get('room')) $('#code').value = params.get('room').slice(0, 4).toUpperCase();

})();
