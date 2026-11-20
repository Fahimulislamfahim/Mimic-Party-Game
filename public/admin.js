(() => {
'use strict';
const $ = (s) => document.querySelector(s);
let pw = '', duration = 0;
try { pw = sessionStorage.getItem('mp-admin') || ''; } catch (e) { /* storage unavailable */ }
const hdr = () => ({ 'x-admin-password': pw });

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...hdr(), ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Request failed');
  return body;
}

async function refresh() {
  const list = await api('/api/admin/sounds');
  $('#total').textContent = `(${list.length})`;
  const box = $('#list'); box.replaceChildren();
  for (const s of list) {
    const card = document.createElement('div'); card.className = 'card item';
    const img = document.createElement('img'); img.src = s.imageUrl; img.alt = '';
    const meta = document.createElement('div'); meta.className = 'meta';
    const b = document.createElement('b'); b.textContent = s.name;
    const d = document.createElement('span'); d.className = 'note'; d.textContent = s.duration + ' s';
    const a = document.createElement('audio'); a.controls = true; a.preload = 'none'; a.src = s.audioUrl;
    meta.append(b, d, a);
    const del = document.createElement('button'); del.className = 'danger'; del.textContent = 'Delete';
    del.onclick = async () => { if (confirm(`Delete "${s.name}"?`)) { await api('/api/admin/sounds/' + s.id, { method: 'DELETE' }); refresh(); } };
    card.append(img, meta, del); box.append(card);
  }
}

async function signIn() {
  $('#loginErr').textContent = '';
  try { await refresh(); $('#login').hidden = true; $('#panel').hidden = false; try { sessionStorage.setItem('mp-admin', pw); } catch (e) { /* ignore */ } }
  catch (e) { $('#loginErr').textContent = e.message; $('#login').hidden = false; $('#panel').hidden = true; }
}
$('#loginBtn').onclick = () => { pw = $('#pw').value; signIn(); };
$('#pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#loginBtn').click(); });
if (pw) signIn();

$('#saudio').addEventListener('change', async (e) => {
  duration = 0; const f = e.target.files[0]; if (!f) return;
  $('#durInfo').textContent = 'Reading...';
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const b = await ctx.decodeAudioData(await f.arrayBuffer()); ctx.close();
    duration = b.duration;
    $('#durInfo').textContent = `Length: ${duration.toFixed(2)} s` + (duration > 20 ? '  (too long, max 20 s)' : '');
    if (!$('#sname').value) $('#sname').value = f.name.replace(/\.[^.]+$/, '').slice(0, 40);
  } catch (err) { $('#durInfo').textContent = 'Could not read this audio file.'; }
});
$('#simage').addEventListener('change', (e) => {
  const f = e.target.files[0]; const p = $('#preview');
  if (f) { p.src = URL.createObjectURL(f); p.hidden = false; } else p.hidden = true;
});

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#formErr').textContent = '';
  if (!(duration > 0)) return ($('#formErr').textContent = 'Pick a readable audio file first');
  const fd = new FormData();
  fd.append('name', $('#sname').value); fd.append('duration', String(duration));
  fd.append('audio', $('#saudio').files[0]); fd.append('image', $('#simage').files[0]);
  $('#addBtn').disabled = true;
  try { await api('/api/admin/sounds', { method: 'POST', body: fd }); $('#form').reset(); $('#preview').hidden = true; $('#durInfo').textContent = ''; duration = 0; await refresh(); }
  catch (err) { $('#formErr').textContent = err.message; }
  $('#addBtn').disabled = false;
});
})();
