(() => {
const S = window.Shared;
const $ = id => document.getElementById(id);
const cv = $('c'), ctx = cv.getContext('2d');
let W = 0, H = 0, DPR = 1;

function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = innerWidth; H = innerHeight;
  cv.width = W * DPR; cv.height = H * DPR;
}
addEventListener('resize', resize); resize();

// ---------------- state ----------------
let ws = null, myId = null, lobby = null, game = null;
let chatOpen = false;
const keys = {};
const touch = {};
const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

// ---------------- sound ----------------
const Snd = {
  ac: null, muted: false, eng: null, engGain: null, filt: null,
  init() {
    if (this.ac) return;
    try {
      this.ac = new (window.AudioContext || window.webkitAudioContext)();
      this.eng = this.ac.createOscillator(); this.eng.type = 'sawtooth';
      this.filt = this.ac.createBiquadFilter(); this.filt.type = 'lowpass'; this.filt.frequency.value = 600;
      this.engGain = this.ac.createGain(); this.engGain.gain.value = 0;
      this.eng.connect(this.filt).connect(this.engGain).connect(this.ac.destination);
      this.eng.start();
    } catch (e) { this.ac = null; }
  },
  engine(speed, on) {
    if (!this.ac) return;
    const t = this.ac.currentTime;
    this.eng.frequency.setTargetAtTime(48 + Math.abs(speed) * 0.17, t, 0.05);
    this.engGain.gain.setTargetAtTime(on && !this.muted ? 0.035 : 0, t, 0.1);
  },
  beep(f, dur = 0.12, type = 'square', vol = 0.08, slide = 0) {
    if (!this.ac || this.muted) return;
    const t = this.ac.currentTime, o = this.ac.createOscillator(), g = this.ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, f + slide), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.ac.destination); o.start(t); o.stop(t + dur);
  },
  boom() {
    if (!this.ac || this.muted) return;
    const t = this.ac.currentTime, n = this.ac.sampleRate * 0.4;
    const buf = this.ac.createBuffer(1, n, this.ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2;
    const s = this.ac.createBufferSource(), g = this.ac.createGain();
    s.buffer = buf; g.gain.value = 0.25; s.connect(g).connect(this.ac.destination); s.start(t);
  },
};

// ---------------- networking ----------------
function connect(onOpen) {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = onOpen;
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose = () => {
    if (myId) { alert('Disconnected from server.'); location.reload(); }
  };
}
function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }

function handle(m) {
  switch (m.t) {
    case 'welcome':
      myId = m.id;
      history.replaceState(null, '', '?r=' + m.code);
      break;
    case 'error':
      $('menuErr').textContent = m.msg;
      break;
    case 'lobby':
      lobby = m;
      renderLobby();
      if (m.phase === 'lobby') { game = null; show('lobby'); }
      else if (m.phase === 'racing' && !game) show('lobby');
      break;
    case 'start': startGame(m); break;
    case 'snap': if (game) onSnap(m); break;
    case 'box':
      if (game) { const b = game.boxes.find(x => x.id === m.id); if (b) b.until = performance.now() + m.ms; }
      break;
    case 'item':
      if (!game) break;
      game.pending = false;
      if (m.kind) { game.item = m.kind; game.itemFlash = 0.6; Snd.beep(880, 0.08); Snd.beep(1320, 0.12); }
      break;
    case 'spawn':
      if (!game) break;
      game.objs.set(m.o.id, Object.assign({}, m.o, { born: performance.now() }));
      Snd.beep(m.o.kind === 'rocket' ? 300 : 160, 0.25, 'sawtooth', 0.05, m.o.kind === 'rocket' ? 600 : -80);
      break;
    case 'despawn':
      if (!game) break;
      game.objs.delete(m.oid);
      if (m.hit) explode(m.x, m.y);
      break;
    case 'finished':
      if (game) { const c = game.cars.get(m.id); if (c) c.fin = m.ft; if (m.id === myId) game.me.fin = m.ft; }
      break;
    case 'left':
      if (game) game.cars.delete(m.id);
      break;
    case 'results': showResults(m.list); break;
    case 'chat': addChat(m); break;
  }
}

// ---------------- UI ----------------
function show(which) {
  for (const id of ['menu', 'lobby', 'results']) $(id).classList.toggle('hidden', id !== which);
  $('chat').classList.toggle('hidden', which === 'menu');
  $('touch').classList.toggle('hidden', !(isTouch && which === null));
}

$('name').value = (() => { try { return localStorage.getItem('tb_name') || ''; } catch { return ''; } })();
const urlRoom = new URLSearchParams(location.search).get('r');
if (urlRoom) $('roomCode').value = urlRoom.toUpperCase();

function join(room) {
  const name = $('name').value.trim() || 'Racer' + Math.floor(Math.random() * 90 + 10);
  try { localStorage.setItem('tb_name', name); } catch {}
  Snd.init();
  $('menuErr').textContent = '';
  connect(() => send({ t: 'join', name, room }));
}
$('createBtn').onclick = () => join('');
$('joinBtn').onclick = () => {
  const c = $('roomCode').value.trim().toUpperCase();
  if (c.length !== 4) { $('menuErr').textContent = 'Room codes are 4 letters.'; return; }
  join(c);
};
$('roomCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });
$('name').addEventListener('keydown', e => { if (e.key === 'Enter') (urlRoom ? $('joinBtn') : $('createBtn')).click(); });

$('copyBtn').onclick = () => {
  const link = location.origin + location.pathname + '?r=' + lobby.code;
  (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(
    () => { $('copyBtn').textContent = 'Copied!'; setTimeout(() => $('copyBtn').textContent = 'Copy invite link', 1500); },
    () => prompt('Share this link:', link));
};
for (let i = 1; i <= 9; i++) $('lapSel').add(new Option(i, i));
for (let i = 0; i <= 7; i++) $('botSel').add(new Option(i, i));
const sendSettings = () => send({ t: 'settings', track: +$('trackSel').value, laps: +$('lapSel').value, bots: +$('botSel').value });
['trackSel', 'lapSel', 'botSel'].forEach(id => $(id).onchange = sendSettings);
$('startBtn').onclick = () => { Snd.init(); send({ t: 'start' }); };
$('againBtn').onclick = () => send({ t: 'lobby' });

function renderLobby() {
  const L = lobby, host = L.hostId === myId;
  $('lobbyCode').textContent = L.code;
  if ($('trackSel').options.length !== L.tracks.length) {
    $('trackSel').innerHTML = '';
    L.tracks.forEach((t, i) => $('trackSel').add(new Option(t, i)));
  }
  $('trackSel').value = L.track; $('lapSel').value = L.laps; $('botSel').value = L.bots;
  ['trackSel', 'lapSel', 'botSel'].forEach(id => $(id).disabled = !host);
  const ul = $('playerList'); ul.innerHTML = '';
  for (const p of L.players) {
    const li = document.createElement('li');
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = p.color;
    const nm = document.createElement('span'); nm.textContent = p.name + (p.id === myId ? ' (you)' : '');
    li.append(dot, nm);
    if (p.id === L.hostId) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = 'HOST'; li.append(t); }
    ul.append(li);
  }
  $('startBtn').classList.toggle('hidden', !host || L.phase !== 'lobby');
  $('lobbyNote').textContent = L.phase === 'racing' ? 'A race is in progress. You will join the next one.'
    : host ? 'Share the code or link with friends, then hit start. Empty slots are filled by CPU drivers.'
    : 'Waiting for the host to start the race…';
  $('againBtn').disabled = !host;
  $('resNote').textContent = host ? '' : 'Waiting for the host…';
}

function fmtTime(ms) {
  if (ms == null) return 'DNF';
  const m = Math.floor(ms / 60000), s = (ms % 60000) / 1000;
  return m + ':' + s.toFixed(2).padStart(5, '0');
}
function showResults(list) {
  const tb = $('resTable'); tb.innerHTML = '';
  list.forEach((r, i) => {
    const tr = document.createElement('tr');
    const p = document.createElement('td'); p.className = 'pos'; p.textContent = i + 1;
    const n = document.createElement('td');
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.cssText = `display:inline-block;vertical-align:middle;margin-right:8px;background:${r.color}`;
    n.append(dot, document.createTextNode(r.name + (r.bot ? ' (CPU)' : '') + (r.id === myId ? ' — you' : '')));
    if (r.id === myId) n.style.fontWeight = '800';
    const t = document.createElement('td'); t.className = 'time'; t.textContent = fmtTime(r.time);
    tr.append(p, n, t); tb.append(tr);
  });
  if (lobby) renderLobby();
  show('results');
  Snd.engine(0, false);
}

function addChat(m) {
  const d = document.createElement('div');
  const b = document.createElement('b'); b.style.color = m.color; b.textContent = m.name + ': ';
  d.append(b, document.createTextNode(m.text));
  $('chatlog').append(d);
  while ($('chatlog').children.length > 6) $('chatlog').firstChild.remove();
  setTimeout(() => d.remove(), 15000);
}
$('chatin').addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    const v = $('chatin').value.trim();
    if (v) send({ t: 'chat', text: v });
    $('chatin').value = ''; $('chatin').classList.add('hidden'); $('chatin').blur(); chatOpen = false;
  } else if (e.key === 'Escape') { $('chatin').classList.add('hidden'); $('chatin').blur(); chatOpen = false; }
});

// ---------------- input ----------------
const KEYMAP = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', Space: 'fire', KeyE: 'fire', ShiftLeft: 'fire' };
addEventListener('keydown', e => {
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  if (e.code === 'Enter' && myId) { chatOpen = true; $('chatin').classList.remove('hidden'); $('chatin').focus(); e.preventDefault(); return; }
  if (e.code === 'KeyM') { Snd.muted = !Snd.muted; return; }
  const k = KEYMAP[e.code];
  if (k) { keys[k] = true; if (game) e.preventDefault(); }
});
addEventListener('keyup', e => { const k = KEYMAP[e.code]; if (k) keys[k] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
document.querySelectorAll('#touch .tb').forEach(el => {
  const k = el.dataset.k;
  const on = e => { e.preventDefault(); touch[k] = true; el.classList.add('on'); };
  const off = e => { e.preventDefault(); touch[k] = false; el.classList.remove('on'); };
  el.addEventListener('pointerdown', on); el.addEventListener('pointerup', off);
  el.addEventListener('pointercancel', off); el.addEventListener('pointerleave', off);
});
const inp = k => !!(keys[k] || touch[k]);

// ---------------- game setup ----------------
function rng(seed) { return () => (seed = (seed * 16807) % 2147483647) / 2147483647; }

function buildScenery(track) {
  const r = rng(track.idx * 977 + 13), b = track.bounds, out = [];
  const pad = 700;
  for (let tries = 0; tries < 3000 && out.length < 340; tries++) {
    const x = b.minX - pad + r() * (b.maxX - b.minX + pad * 2);
    const y = b.minY - pad + r() * (b.maxY - b.minY + pad * 2);
    const n = S.nearest(track, x, y);
    if (n.d > track.width / 2 + 70) out.push({ x, y, s: 18 + r() * 22, k: r() < 0.15 ? 'rock' : 'tree', h: r() });
  }
  return out;
}
function trackPath(track, scale = 1, ox = 0, oy = 0) {
  const p = new Path2D();
  track.pts.forEach((q, i) => (i ? p.lineTo : p.moveTo).call(p, (q.x - ox) * scale, (q.y - oy) * scale));
  p.closePath();
  return p;
}
function grassPattern(color) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), r = rng(7);
  g.fillStyle = color; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 260; i++) {
    g.fillStyle = r() < 0.5 ? 'rgba(0,0,0,.07)' : 'rgba(255,255,255,.06)';
    g.fillRect(r() * 128, r() * 128, 2 + r() * 3, 2 + r() * 3);
  }
  return ctx.createPattern(c, 'repeat');
}

const preview = {};
function getPreview(idx) {
  if (preview[idx]) return preview[idx];
  const track = S.buildTrack(idx);
  const b = track.bounds, mw = isTouch ? 100 : 170, sc = mw / Math.max(b.maxX - b.minX, b.maxY - b.minY);
  return preview[idx] = {
    track, path: trackPath(track), scenery: buildScenery(track), grass: grassPattern(track.grass),
    mini: trackPath(track, sc, b.minX, b.minY), miniScale: sc,
    miniW: (b.maxX - b.minX) * sc, miniH: (b.maxY - b.minY) * sc,
  };
}

function startGame(m) {
  const P = getPreview(m.track), track = P.track;
  const cars = new Map();
  let me = null;
  m.cars.forEach((c, slot) => {
    if (c.id === myId) {
      me = Object.assign(S.makeCar(track, slot), { id: c.id, name: c.name, color: c.color, fin: 0 });
    } else {
      cars.set(c.id, { id: c.id, name: c.name, color: c.color, bot: c.bot, x: c.x, y: c.y, a: c.a, tx: c.x, ty: c.y, ta: c.a, sp: 0, total: 0, f: 0, fin: 0 });
    }
  });
  if (!me) return; // joined mid-race: spectate the lobby
  game = {
    P, track, laps: m.laps, cars, me,
    goAt: performance.now() + m.delay, lastBeep: 4,
    boxes: track.boxes.map(b => Object.assign({ until: 0 }, b)),
    objs: new Map(), parts: [], item: null, itemFlash: 0, pending: false,
    lastSend: 0, cam: { x: me.x, y: me.y, z: 1 }, shake: 0, firedLatch: false, lapShown: 1, lapBanner: 0,
  };
  show(null);
}

function onSnap(m) {
  for (const s of m.cars) {
    if (s.id === myId) { if (s.fin) game.me.fin = s.fin; continue; }
    let c = game.cars.get(s.id);
    if (!c) continue;
    c.tx = s.x; c.ty = s.y; c.ta = s.a; c.sp = s.sp; c.total = s.total; c.f = s.f; c.fin = s.fin;
  }
}

function explode(x, y) {
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * 6.283, v = 80 + Math.random() * 260;
    game.parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.5 + Math.random() * 0.4, max: 0.9,
      size: 6 + Math.random() * 10, color: ['#ffd23f', '#ff7a1a', '#ff3d1f', '#666'][i % 4] });
  }
  if (game && Math.hypot(x - game.me.x, y - game.me.y) < 700) { game.shake = 0.35; Snd.boom(); }
}

function useItem() {
  const g = game, me = g.me;
  if (!g.item || me.spin > 0) return;
  const k = g.item; g.item = null;
  if (k === 'boost') { me.boost = 1.8; Snd.beep(200, 0.5, 'sawtooth', 0.06, 500); }
  else if (k === 'shield') { me.shield = 6; Snd.beep(600, 0.3, 'sine', 0.08, 400); }
  else send({ t: 'use', kind: k });
}

// ---------------- update ----------------
function update(dt, now) {
  const g = game, me = g.me, track = g.track;
  const racing = now >= g.goAt;
  const finished = !!me.fin || me.total >= g.laps * track.len;

  // countdown beeps
  const left = Math.ceil((g.goAt - now) / 1000);
  if (left < g.lastBeep && left >= 0) { g.lastBeep = left; Snd.beep(left === 0 ? 880 : 440, left === 0 ? 0.4 : 0.15); }

  let input = {};
  if (racing && !finished) input = { up: inp('up'), down: inp('down'), left: inp('left'), right: inp('right') };
  else if (racing && finished) input = S.botInput(track, me, 0);
  S.stepCar(me, input, dt, track);

  // lap banner
  const lap = Math.max(1, Math.floor(me.total / track.len) + 1);
  if (lap > g.lapShown && lap <= g.laps) { g.lapShown = lap; g.lapBanner = 2; Snd.beep(660, 0.1); Snd.beep(990, 0.2); }
  g.lapBanner = Math.max(0, g.lapBanner - dt);

  if (!me.fin && !g.sentFinish && me.total >= g.laps * track.len) { g.sentFinish = true; send({ t: 'finish' }); Snd.beep(523, 0.15); Snd.beep(784, 0.4); }

  // fire
  if (inp('fire') && !g.firedLatch && racing && !finished) { useItem(); }
  g.firedLatch = inp('fire');

  // remote cars smoothing (extrapolate toward server target)
  for (const c of g.cars.values()) {
    c.tx += Math.cos(c.ta) * c.sp * dt; c.ty += Math.sin(c.ta) * c.sp * dt;
    const k = Math.min(1, dt * 10);
    if (Math.hypot(c.tx - c.x, c.ty - c.y) > 400) { c.x = c.tx; c.y = c.ty; }
    c.x += (c.tx - c.x) * k; c.y += (c.ty - c.y) * k;
    c.a += S.wrapAngle(c.ta - c.a) * k;
    // bump
    const dx = me.x - c.x, dy = me.y - c.y, d = Math.hypot(dx, dy);
    if (d > 0 && d < 34) {
      const nx = dx / d, ny = dy / d;
      me.x += nx * (34 - d); me.y += ny * (34 - d);
      const vn = me.vx * nx + me.vy * ny;
      if (vn < 0) { me.vx -= nx * vn * 1.3; me.vy -= ny * vn * 1.3; }
      if (Math.abs(vn) > 150) Snd.beep(90, 0.08, 'square', 0.05);
    }
  }

  // boxes
  if (!g.item && !g.pending && racing) {
    for (const b of g.boxes) {
      if (b.until > now) continue;
      if (Math.hypot(b.x - me.x, b.y - me.y) < 38) {
        b.until = now + S.BOX_RESPAWN_MS; g.pending = true;
        setTimeout(() => { if (game === g) g.pending = false; }, 1500);
        send({ t: 'pickup', box: b.id });
        break;
      }
    }
  }

  // objects
  for (const o of g.objs.values()) {
    const age = (now - o.born) / 1000;
    if (age > o.life) { g.objs.delete(o.id); continue; }
    o.x += o.vx * dt; o.y += o.vy * dt;
    if (o.kind === 'rocket' && Math.random() < 0.8) g.parts.push({ x: o.x, y: o.y, vx: 0, vy: 0, life: 0.4, max: 0.4, size: 8, color: 'rgba(200,200,200,.6)' });
    if (me.spin > 0) continue;
    if (o.owner === myId && (o.kind === 'rocket' || age < 1)) continue;
    if (Math.hypot(o.x - me.x, o.y - me.y) < 30) {
      g.objs.delete(o.id);
      send({ t: 'hit', oid: o.id, x: o.x, y: o.y });
      if (me.shield > 0) { me.shield = 0; Snd.beep(300, 0.2, 'sine'); }
      else { me.spin = 1.2; me.vx *= 0.35; me.vy *= 0.35; g.item = null; }
      explode(o.x, o.y);
    }
  }

  // particles: boost flames, dust
  const emit = (c, boosting, off) => {
    const bx = c.x - Math.cos(c.a) * 24, by = c.y - Math.sin(c.a) * 24;
    if (boosting) for (let i = 0; i < 2; i++) g.parts.push({ x: bx, y: by, vx: -Math.cos(c.a) * 200 + (Math.random() - .5) * 80, vy: -Math.sin(c.a) * 200 + (Math.random() - .5) * 80, life: 0.25, max: 0.25, size: 9, color: Math.random() < .5 ? '#ffd23f' : '#ff6a1a' });
    if (off && Math.abs(c.sp) > 120 && Math.random() < 0.6) g.parts.push({ x: bx, y: by, vx: (Math.random() - .5) * 60, vy: (Math.random() - .5) * 60, life: 0.6, max: 0.6, size: 10, color: 'rgba(140,110,70,.45)' });
  };
  emit(me, me.boost > 0, me.off);
  for (const c of g.cars.values()) emit(c, c.f & 2, false);
  for (const p of g.parts) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.94; p.vy *= 0.94; p.life -= dt; }
  g.parts = g.parts.filter(p => p.life > 0);
  if (g.parts.length > 600) g.parts.splice(0, g.parts.length - 600);

  g.itemFlash = Math.max(0, g.itemFlash - dt);
  g.shake = Math.max(0, g.shake - dt);

  // send state at 20Hz
  if (now - g.lastSend > 50) {
    g.lastSend = now;
    send({ t: 'state', x: +me.x.toFixed(1), y: +me.y.toFixed(1), a: +me.a.toFixed(3), sp: Math.round(me.sp),
      total: Math.round(me.total), spin: +me.spin.toFixed(2), boost: +me.boost.toFixed(2), shield: +me.shield.toFixed(2) });
  }

  // camera
  const base = Math.min(W, H) / 950 * (isTouch ? 0.85 : 1);
  const z = base * (1 - Math.min(0.18, Math.abs(me.sp) / 5000));
  g.cam.z += (z - g.cam.z) * Math.min(1, dt * 3);
  const lx = me.x + me.vx * 0.35, ly = me.y + me.vy * 0.35;
  g.cam.x += (lx - g.cam.x) * Math.min(1, dt * 5);
  g.cam.y += (ly - g.cam.y) * Math.min(1, dt * 5);
  Snd.engine(me.sp, true);
}

// ---------------- drawing ----------------
function drawWorld(P, cam, extra) {
  const track = P.track;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  let sx = 0, sy = 0;
  if (game && game.shake > 0) { sx = (Math.random() - .5) * 18 * game.shake; sy = (Math.random() - .5) * 18 * game.shake; }
  ctx.translate(W / 2 + sx, H / 2 + sy);
  ctx.scale(cam.z, cam.z);
  ctx.translate(-cam.x, -cam.y);

  const vw = W / cam.z, vh = H / cam.z;
  ctx.fillStyle = P.grass;
  ctx.fillRect(cam.x - vw / 2 - 50, cam.y - vh / 2 - 50, vw + 100, vh + 100);

  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  // shoulder + curbs
  ctx.strokeStyle = 'rgba(0,0,0,.18)'; ctx.lineWidth = track.width + 60; ctx.stroke(P.path);
  ctx.strokeStyle = '#f3f0e8'; ctx.lineWidth = track.width + 26; ctx.stroke(P.path);
  ctx.setLineDash([36, 36]); ctx.strokeStyle = '#d8322a'; ctx.stroke(P.path); ctx.setLineDash([]);
  ctx.strokeStyle = '#46454f'; ctx.lineWidth = track.width; ctx.stroke(P.path);
  ctx.strokeStyle = 'rgba(255,255,255,.035)'; ctx.lineWidth = track.width * 0.5; ctx.stroke(P.path);
  ctx.setLineDash([34, 40]); ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = 4; ctx.stroke(P.path); ctx.setLineDash([]);

  // start line checker
  const s0 = track.pts[0];
  ctx.save(); ctx.translate(s0.x, s0.y); ctx.rotate(Math.atan2(s0.dy, s0.dx));
  const sq = 14, rows = Math.ceil(track.width / sq);
  for (let i = 0; i < rows; i++) for (let j = 0; j < 2; j++) {
    ctx.fillStyle = (i + j) % 2 ? '#111' : '#fff';
    ctx.fillRect(j * sq - sq, -track.width / 2 + i * sq, sq, Math.min(sq, track.width / 2 - (-track.width / 2 + i * sq)));
  }
  ctx.restore();

  if (extra) extra();

  // scenery on top (trees cast over cars? keep beneath HUD only)
  for (const t of P.scenery) {
    if (Math.abs(t.x - cam.x) > vw / 2 + 60 || Math.abs(t.y - cam.y) > vh / 2 + 60) continue;
    if (t.k === 'tree') {
      ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.beginPath(); ctx.arc(t.x + 8, t.y + 10, t.s, 0, 6.283); ctx.fill();
      ctx.fillStyle = `hsl(${105 + t.h * 30},45%,${24 + t.h * 8}%)`; ctx.beginPath(); ctx.arc(t.x, t.y, t.s, 0, 6.283); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.beginPath(); ctx.arc(t.x - t.s * .3, t.y - t.s * .3, t.s * .5, 0, 6.283); ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(0,0,0,.2)'; ctx.beginPath(); ctx.ellipse(t.x + 6, t.y + 7, t.s * .8, t.s * .6, 0, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#8d8a85'; ctx.beginPath(); ctx.ellipse(t.x, t.y, t.s * .8, t.s * .6, t.h, 0, 6.283); ctx.fill();
    }
  }
}

function drawCar(c, color, flags, label) {
  ctx.save();
  ctx.translate(c.x, c.y);
  if (flags.shield) {
    ctx.strokeStyle = 'rgba(90,200,255,.8)'; ctx.lineWidth = 3; ctx.fillStyle = 'rgba(90,200,255,.15)';
    ctx.beginPath(); ctx.arc(0, 0, 34 + Math.sin(performance.now() / 90) * 2, 0, 6.283); ctx.fill(); ctx.stroke();
  }
  if (label) {
    ctx.font = '600 13px Inter,sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,.5)'; const w = ctx.measureText(label).width + 10;
    ctx.fillRect(-w / 2, -50, w, 18); ctx.fillStyle = '#fff'; ctx.fillText(label, 0, -37);
  }
  ctx.rotate(c.a);
  ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(-22, -11, 48, 28);
  ctx.fillStyle = '#151515';
  for (const [x, y] of [[-15, -14], [11, -14], [-15, 10], [11, 10]]) ctx.fillRect(x, y, 10, 4);
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.roundRect(-23, -12, 46, 24, 7); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fillRect(-20, -3, 40, 6);
  ctx.fillStyle = '#1d2a3a'; ctx.beginPath(); ctx.roundRect(2, -9, 10, 18, 3); ctx.fill();
  ctx.fillStyle = '#2b3a4d'; ctx.beginPath(); ctx.roundRect(-14, -8, 8, 16, 3); ctx.fill();
  ctx.fillStyle = '#ffe9a0'; ctx.fillRect(20, -10, 3, 5); ctx.fillRect(20, 5, 3, 5);
  ctx.restore();
}

const ITEM_ICON = { boost: '⚡', rocket: '🚀', oil: '🛢️', shield: '🛡️' };
const ITEM_NAME = { boost: 'TURBO', rocket: 'ROCKET', oil: 'OIL SLICK', shield: 'SHIELD' };

function drawGame(now) {
  const g = game, me = g.me, track = g.track;
  drawWorld(g.P, g.cam, () => {
    // boxes
    for (const b of g.boxes) {
      if (b.until > now) continue;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(now / 600 + b.id);
      const s = 15 + Math.sin(now / 200 + b.id) * 1.5;
      ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(-s + 4, -s + 5, s * 2, s * 2);
      const gr = ctx.createLinearGradient(-s, -s, s, s); gr.addColorStop(0, '#ffe066'); gr.addColorStop(1, '#ff7b1c');
      ctx.fillStyle = gr; ctx.fillRect(-s, -s, s * 2, s * 2);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(-s, -s, s * 2, s * 2);
      ctx.rotate(-(now / 600 + b.id)); ctx.fillStyle = '#5a1e00'; ctx.font = '800 18px Inter,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('?', 0, 1); ctx.restore();
    }
    // oil slicks
    for (const o of g.objs.values()) if (o.kind === 'oil') {
      ctx.fillStyle = 'rgba(15,10,25,.85)'; ctx.beginPath(); ctx.ellipse(o.x, o.y, 30, 22, o.id, 0, 6.283); ctx.fill();
      ctx.fillStyle = 'rgba(120,80,200,.35)'; ctx.beginPath(); ctx.ellipse(o.x - 6, o.y - 5, 12, 7, o.id, 0, 6.283); ctx.fill();
    }
    // particles beneath cars
    for (const p of g.parts) {
      ctx.globalAlpha = Math.max(0, p.life / p.max); ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.5 + p.life / p.max * 0.5), 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // cars
    for (const c of g.cars.values()) drawCar(c, c.color, { shield: c.f & 4 }, c.name);
    drawCar(me, me.color, { shield: me.shield > 0 }, null);
    // rockets
    for (const o of g.objs.values()) if (o.kind === 'rocket') {
      ctx.save(); ctx.translate(o.x, o.y); ctx.rotate(Math.atan2(o.vy, o.vx));
      ctx.fillStyle = '#ff9a1f'; ctx.beginPath(); ctx.moveTo(-14, -4); ctx.lineTo(-24, 0); ctx.lineTo(-14, 4); ctx.fill();
      ctx.fillStyle = '#ddd'; ctx.fillRect(-14, -4, 22, 8); ctx.fillStyle = '#e22'; ctx.beginPath(); ctx.moveTo(8, -4); ctx.lineTo(15, 0); ctx.lineTo(8, 4); ctx.fill();
      ctx.restore();
    }
  });

  // ---- HUD ----
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const all = [{ id: myId, total: me.total, fin: me.fin }, ...[...g.cars.values()].map(c => ({ id: c.id, total: c.total, fin: c.fin }))];
  all.sort((a, b) => (a.fin && b.fin) ? a.fin - b.fin : a.fin ? -1 : b.fin ? 1 : b.total - a.total);
  const pos = all.findIndex(x => x.id === myId) + 1;
  const lap = Math.min(g.laps, Math.max(1, Math.floor(me.total / track.len) + 1));
  const elapsed = Math.max(0, now - g.goAt);

  ctx.textBaseline = 'top'; ctx.textAlign = 'left';
  panel(16, 16, 168, 86);
  ctx.fillStyle = '#ffc53d'; ctx.font = '400 34px Bungee,Impact,sans-serif';
  ctx.fillText(pos + ordinal(pos), 28, 24);
  ctx.fillStyle = '#a8a3b5'; ctx.font = '600 13px Inter,sans-serif'; ctx.fillText('of ' + all.length, 110, 40);
  ctx.fillStyle = '#fff'; ctx.font = '800 15px Inter,sans-serif';
  ctx.fillText(me.fin ? 'FINISHED' : `LAP ${lap}/${g.laps}`, 28, 70);
  ctx.fillStyle = '#a8a3b5'; ctx.font = '600 14px Inter,sans-serif';
  ctx.fillText(fmtTime(me.fin || elapsed), 110, 71);

  // item slot
  const ix = W - 96, iy = 16;
  panel(ix, iy, 80, 80);
  if (g.item) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '38px sans-serif';
    ctx.save(); const sc = 1 + g.itemFlash * 0.6; ctx.translate(ix + 40, iy + 36); ctx.scale(sc, sc);
    ctx.fillText(ITEM_ICON[g.item], 0, 0); ctx.restore();
    ctx.font = '800 10px Inter,sans-serif'; ctx.fillStyle = '#ffc53d'; ctx.fillText(ITEM_NAME[g.item], ix + 40, iy + 68);
  } else if (g.pending) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '34px sans-serif';
    ctx.fillText(Object.values(ITEM_ICON)[Math.floor(now / 80) % 4], ix + 40, iy + 40);
  } else {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#a8a3b5'; ctx.font = '600 11px Inter,sans-serif';
    ctx.fillText('NO ITEM', ix + 40, iy + 40);
  }

  // speedometer
  if (!isTouch) {
    const kmh = Math.round(Math.abs(me.sp) * 0.32);
    panel(16, H - 66, 130, 50);
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = me.boost > 0 ? '#ffc53d' : '#fff';
    ctx.font = '400 26px Bungee,Impact,sans-serif'; ctx.fillText(kmh, 28, H - 41);
    ctx.fillStyle = '#a8a3b5'; ctx.font = '600 12px Inter,sans-serif'; ctx.fillText('KM/H', 92, H - 40);
  }

  // minimap
  const P = g.P, mw = P.miniW, mh = P.miniH, mx = W - mw - 28, my = isTouch ? 112 : H - mh - 28;
  panel(mx - 12, my - 12, mw + 24, mh + 24);
  ctx.save(); ctx.translate(mx, my);
  ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 4; ctx.stroke(P.mini);
  const b = track.bounds, sc = P.miniScale;
  for (const c of g.cars.values()) { ctx.fillStyle = c.color; ctx.beginPath(); ctx.arc((c.x - b.minX) * sc, (c.y - b.minY) * sc, 4, 0, 6.283); ctx.fill(); }
  ctx.fillStyle = me.color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc((me.x - b.minX) * sc, (me.y - b.minY) * sc, 6, 0, 6.283); ctx.fill(); ctx.stroke();
  ctx.restore();

  // center text
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const left = (g.goAt - now) / 1000;
  if (left > 0) bigText(Math.ceil(left), '#fff', 1 + (left % 1) * 0.4);
  else if (left > -0.9) bigText('GO!', '#ffc53d', 1 + (-left) * 0.5);
  else if (g.lapBanner > 0) bigText(lap === g.laps ? 'FINAL LAP' : 'LAP ' + lap, '#fff', 0.6);
  else if (me.fin) bigText(pos + ordinal(pos) + '!', '#ffc53d', 0.8);
  if (me.spin > 0) { ctx.font = '800 18px Inter,sans-serif'; ctx.fillStyle = '#ff6b6b'; ctx.fillText('SPUN OUT!', W / 2, H * 0.7); }
  if (me.off && Math.abs(me.sp) > 50 && left <= 0) { ctx.font = '700 14px Inter,sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.fillText('Get back on the track!', W / 2, H * 0.78); }
}

function bigText(t, color, scale) {
  ctx.save(); ctx.translate(W / 2, H * 0.32); ctx.scale(scale, scale);
  ctx.font = `400 ${Math.min(110, W / 5)}px Bungee,Impact,sans-serif`;
  ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.strokeText(t, 0, 0);
  ctx.fillStyle = color; ctx.fillText(t, 0, 0); ctx.restore();
}
function panel(x, y, w, h) {
  ctx.fillStyle = 'rgba(15,13,22,.72)'; ctx.beginPath(); ctx.roundRect(x, y, w, h, 12); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1; ctx.stroke();
}
function ordinal(n) { return ['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4] || 'th'; }

// attract mode camera when not racing
let attract = { t: 0 };
function drawAttract(dt) {
  attract.t += dt;
  const idx = lobby ? lobby.track : 0, P = getPreview(idx), track = P.track;
  const k = Math.floor((attract.t * 14) % track.N), p = track.pts[k];
  drawWorld(P, { x: p.x, y: p.y, z: Math.min(W, H) / 1400 });
}

// ---------------- main loop ----------------
let last = performance.now();
function frame(now) {
  const dt = Math.max(0, Math.min(0.05, (now - last) / 1000)); last = now;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#14121c'; ctx.fillRect(0, 0, W, H);
  if (game) { update(dt, now); drawGame(now); }
  else { drawAttract(dt); Snd.engine(0, false); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
})();
