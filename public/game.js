import * as THREE from 'three';
import { Snd } from './audio.js';
import { Q, QNAME, makeComposer, saveQuality } from './gfx.js';
import { makeCarMesh, poseCar, CAR_TYPES } from './cars.js';
import { buildWorld, makeBoxMesh, makeRocketMesh, makeOilMesh, makeHomingMesh, makeMineMesh, Particles, Skids, isTouch } from './world.js';

const S = window.Shared;
const $ = id => document.getElementById(id);

// ---------------- renderer / canvases ----------------
const gl = $('gl'), hud = $('c'), ctx = hud.getContext('2d');
// with post-processing on, anti-aliasing happens in the composer (SMAA/FXAA)
const renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: !Q.post && !isTouch, powerPreference: 'high-performance' });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const camera = new THREE.PerspectiveCamera(64, 1, 1.5, 12000);
let W = 0, H = 0, DPR = 1, post = null, postScene = null;
// render through the post-processing chain when the quality preset has one
function render(scene, speed, now) {
  renderer.toneMappingExposure = scene.userData.exposure || 1.05;
  if (Q.post && !post) post = makeComposer(renderer, scene, camera, W, H);
  if (post) {
    if (postScene !== scene) { post.setScene(scene); postScene = scene; }
    const u = post.grade.material.uniforms;
    u.speed.value = speed; u.time.value = now / 1000;
    const tint = scene.userData.tint || [1, 1, 1]; u.tint.value.set(tint[0], tint[1], tint[2]);
    post.composer.render();
  } else renderer.render(scene, camera);
}
function resize() {
  W = innerWidth; H = innerHeight; DPR = Math.min(2, devicePixelRatio || 1);
  renderer.setPixelRatio(Math.min(DPR, Q.pr));
  renderer.setSize(W, H, false);
  if (post) post.setSize(W, H);
  hud.width = W * DPR; hud.height = H * DPR;
  camera.aspect = W / H; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

// ---------------- state ----------------
let ws = null, myId = null, lobby = null, game = null;
const keys = {}, touch = {};
let camMode = 0; // 0 chase, 1 far chase, 2 bumper
const worlds = {};
const getWorld = idx => worlds[idx] || (worlds[idx] = buildWorld(idx, renderer));

// ---------------- networking ----------------
function connect(onOpen) {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = onOpen;
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose = () => { if (myId) { alert('Disconnected from server.'); location.reload(); } };
}
function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }

function handle(m) {
  switch (m.t) {
    case 'welcome': myId = m.id; history.replaceState(null, '', '?r=' + m.code); break;
    case 'error': $('menuErr').textContent = m.msg; break;
    case 'lobby':
      lobby = m; renderLobby();
      if (m.phase === 'lobby') { endGame(); show('lobby'); }
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
      if (m.kind) { game.item = m.kind; game.itemFlash = 0.6; Snd.pickup(); }
      break;
    case 'spawn': if (game) spawnObj(m.o); break;
    case 'despawn':
      if (!game) break;
      removeObj(m.oid);
      if (m.hit) explode(m.x, m.y, m.kind === 'mine' ? 1.6 : 1);
      break;
    case 'blast': if (game) onBlast(m); break;
    case 'finished':
      if (game) { const c = game.cars.get(m.id); if (c) c.fin = m.ft; if (m.id === myId) game.me.fin = m.ft; }
      break;
    case 'left':
      if (game) { const c = game.cars.get(m.id); if (c) { game.world.scene.remove(c.mesh.root); game.cars.delete(m.id); } }
      break;
    case 'results': showResults(m.list); break;
    case 'lap': onLap(m); break;
    case 'chat': addChat(m); break;
  }
}

// ---------------- UI ----------------
function show(which) {
  for (const id of ['menu', 'lobby', 'results', 'board']) $(id).classList.toggle('hidden', id !== which);
  $('chat').classList.toggle('hidden', which === 'menu');
  $('touch').classList.toggle('hidden', !(isTouch && which === null));
}
$('name').value = (() => { try { return localStorage.getItem('tb_name') || ''; } catch { return ''; } })();
const urlRoom = new URLSearchParams(location.search).get('r');
if (urlRoom) $('roomCode').value = urlRoom.toUpperCase();
try { camMode = +localStorage.getItem('tb_cam') || 0; } catch {}

let myCar = (() => { try { const c = localStorage.getItem('tb_car'); return S.CARS[c] ? c : 'gt'; } catch { return 'gt'; } })();
const STAT_NAMES = { speed: 'Speed', accel: 'Accel', grip: 'Grip', offroad: 'Off-road', weight: 'Weight' };
function renderCars() {
  const grid = $('carGrid'); grid.innerHTML = '';
  for (const type of CAR_TYPES) {
    const b = document.createElement('button');
    b.textContent = S.CARS[type].name; b.className = type === myCar ? 'sel' : '';
    b.onclick = () => {
      myCar = type; try { localStorage.setItem('tb_car', type); } catch {}
      send({ t: 'car', car: type }); renderCars(); Snd.tone(660, 0.06, 'triangle', 0.05);
    };
    grid.append(b);
  }
  const C = S.CARS[myCar], info = $('carInfo'); info.innerHTML = '';
  const bl = document.createElement('div'); bl.className = 'blurb'; bl.textContent = C.blurb; info.append(bl);
  for (const k in STAT_NAMES) {
    const row = document.createElement('div'); row.className = 'stat';
    const lab = document.createElement('span'); lab.textContent = STAT_NAMES[k];
    const bar = document.createElement('div'); bar.className = 'bar';
    for (let i = 1; i <= 5; i++) { const seg = document.createElement('i'); if (i <= C.stats[k]) seg.className = 'on'; bar.append(seg); }
    row.append(lab, bar); info.append(row);
  }
}
renderCars();

function join(room) {
  const name = $('name').value.trim() || 'Racer' + Math.floor(Math.random() * 90 + 10);
  try { localStorage.setItem('tb_name', name); } catch {}
  Snd.init();
  $('menuErr').textContent = '';
  connect(() => send({ t: 'join', name, room, car: myCar }));
}
$('gfxSel').value = QNAME;
$('gfxSel').onchange = () => { saveQuality($('gfxSel').value); location.reload(); };
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
    const cn = document.createElement('span'); cn.className = 'carname'; cn.textContent = S.CARS[p.car] ? S.CARS[p.car].name : '';
    li.append(dot, nm, cn);
    if (p.id === L.hostId) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = 'HOST'; li.append(t); }
    ul.append(li);
  }
  $('startBtn').classList.toggle('hidden', !host || L.phase !== 'lobby');
  $('lobbyNote').textContent = L.phase === 'racing' ? 'A race is in progress. You will join the next one.'
    : host ? 'Share the code or link with friends, then hit start. Empty slots are filled by CPU drivers.'
    : 'Waiting for the host to start the race…';
  $('againBtn').disabled = !host;
  $('resNote').textContent = host ? '' : 'Waiting for the host…';
  const rec = L.record, lr = $('lobbyRecord'); lr.textContent = '';
  if (rec) {
    lr.append('Track record: ');
    const b = document.createElement('b'); b.textContent = fmtTime(rec.ms); lr.append(b);
    lr.append(` by ${rec.name}` + (S.CARS[rec.car] ? ` (${S.CARS[rec.car].name})` : ''));
  } else lr.textContent = 'No lap record on this track yet. Set the first one!';
}

function fmtTime(ms) {
  if (ms == null) return 'DNF';
  const m = Math.floor(ms / 60000), s = (ms % 60000) / 1000;
  return m + ':' + s.toFixed(2).padStart(5, '0');
}
// ---------- leaderboard ----------
let boardData = null, boardTrack = 0, boardReturn = 'menu';
function openBoard() {
  boardReturn = ['menu', 'lobby', 'results'].find(id => !$(id).classList.contains('hidden')) || 'menu';
  if (lobby) boardTrack = lobby.track;
  show('board');
  $('boardNote').textContent = 'Loading…';
  fetch('/api/leaderboard').then(r => r.json()).then(d => { boardData = d; renderBoard(); })
    .catch(() => { $('boardNote').textContent = 'Could not load the leaderboard.'; });
}
function renderBoard() {
  const tabs = $('boardTabs'); tabs.innerHTML = '';
  boardData.tracks.forEach((name, i) => {
    const b = document.createElement('button'); b.textContent = name; b.className = i === boardTrack ? 'sel' : '';
    b.onclick = () => { boardTrack = i; renderBoard(); };
    tabs.append(b);
  });
  const list = boardData.board[boardData.tracks[boardTrack]] || [], tb = $('boardTable'); tb.innerHTML = '';
  list.forEach((e, i) => {
    const tr = document.createElement('tr');
    const p = document.createElement('td'); p.className = 'pos'; p.textContent = i === 0 ? '🏆' : i + 1;
    const n = document.createElement('td'); n.textContent = e.name;
    const c = document.createElement('td'); c.className = 'car'; c.textContent = S.CARS[e.car] ? S.CARS[e.car].name : '';
    const t = document.createElement('td'); t.className = 'time'; t.textContent = fmtTime(e.ms);
    tr.append(p, n, c, t); tb.append(tr);
  });
  $('boardNote').textContent = list.length ? 'Best lap per driver. Race to get on the board!' : 'No laps recorded on this track yet.';
}
document.querySelectorAll('.boardBtn').forEach(b => b.onclick = openBoard);
$('boardClose').onclick = () => show(boardReturn);

function onLap(m) {
  if (!game) return;
  if (m.id === myId) {
    const g = game;
    g.lastLap = m.ms;
    if (m.pb) g.bestLap = m.ms;
    if (m.record) { g.popup = { text: 'TRACK RECORD!', sub: fmtTime(m.ms), color: '#ffc53d', t: 2.4 }; Snd.cheer(); Snd.tone(784, 0.15, 'triangle', 0.08); Snd.tone(1175, 0.3, 'triangle', 0.08); }
    else if (m.rank) { g.popup = { text: 'LEADERBOARD #' + m.rank, sub: fmtTime(m.ms), color: '#5ee07a', t: 2 }; Snd.tone(988, 0.2, 'triangle', 0.08); }
    else if (m.pb && m.lap > 1) g.popup = { text: 'PERSONAL BEST', sub: fmtTime(m.ms), color: '#7fd4ff', t: 1.6 };
  } else if (m.record) {
    const c = game.cars.get(m.id);
    if (c) addChat({ name: '🏆 ' + c.name, color: '#ffc53d', text: 'set a new track record: ' + fmtTime(m.ms) });
  }
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
    const bl = document.createElement('td'); bl.className = 'time'; bl.textContent = r.best ? 'best ' + fmtTime(r.best) : '';
    tr.append(p, n, t, bl); tb.append(tr);
  });
  if (lobby) renderLobby();
  show('results');
  Snd.cheer();
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
    $('chatin').value = ''; $('chatin').classList.add('hidden'); $('chatin').blur();
  } else if (e.key === 'Escape') { $('chatin').classList.add('hidden'); $('chatin').blur(); }
});

// ---------------- input ----------------
const KEYMAP = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right', Space: 'hand', KeyE: 'fire', ShiftLeft: 'fire', ShiftRight: 'fire', KeyX: 'fire', KeyR: 'reset' };
addEventListener('keydown', e => {
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  if (e.code === 'Enter' && myId) { $('chatin').classList.remove('hidden'); $('chatin').focus(); e.preventDefault(); return; }
  if (e.code === 'KeyM') { Snd.muted = !Snd.muted; return; }
  if (e.code === 'KeyC') { camMode = (camMode + 1) % 3; try { localStorage.setItem('tb_cam', camMode); } catch {} return; }
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

// ---------------- minimap (2D) ----------------
const mini = {};
function getMini(idx) {
  if (mini[idx]) return mini[idx];
  const track = S.buildTrack(idx), b = track.bounds;
  const mw = isTouch ? 100 : 160, sc = mw / Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const p = new Path2D();
  track.pts.forEach((q, i) => (i ? p.lineTo : p.moveTo).call(p, (q.x - b.minX) * sc, (q.y - b.minY) * sc));
  p.closePath();
  const sc2 = new Path2D();
  for (const R of track.roads.slice(1)) R.pts.forEach((q, i) => (i ? sc2.lineTo : sc2.moveTo).call(sc2, (q.x - b.minX) * sc, (q.y - b.minY) * sc));
  const ramps = track.ramps.map(r => [(r.x - b.minX) * sc, (r.y - b.minY) * sc]);
  return mini[idx] = { path: p, shortcuts: sc2, ramps, sc, w: (b.maxX - b.minX) * sc, h: (b.maxY - b.minY) * sc };
}

// ---------------- game lifecycle ----------------
function startGame(m) {
  endGame();
  clearShowroom();
  const world = getWorld(m.track), track = world.track;
  const scene = world.scene;
  const cars = new Map();
  let me = null;
  m.cars.forEach((c, slot) => {
    if (c.id === myId) {
      me = Object.assign(S.makeCar(track, slot), { id: c.id, name: c.name, color: c.color, fin: 0, car: c.car, mods: (S.CARS[c.car] || S.CARS.gt).mods });
      me.mesh = makeCarMesh(c.color, null, c.car);
      scene.add(me.mesh.root);
    } else {
      const rc = { id: c.id, name: c.name, color: c.color, bot: c.bot, x: c.x, y: c.y, a: c.a, tx: c.x, ty: c.y, ta: c.a,
        sp: 0, total: 0, f: 0, fin: 0, st: 0, vx: 0, vy: 0, z: 0, tz: 0, road: 0, mi: undefined, ni: 0, px: c.x, py: c.y, roll: 0, mesh: makeCarMesh(c.color, c.name, c.car), mods: (S.CARS[c.car] || S.CARS.gt).mods, skid: null, smoke: 0 };
      scene.add(rc.mesh.root);
      cars.set(c.id, rc);
    }
  });
  if (!me) return;
  const boxes = track.boxes.map(b => {
    const mesh = makeBoxMesh(); mesh.position.set(b.x, 14, b.y); scene.add(mesh);
    return Object.assign({ until: 0, mesh }, b);
  });
  game = {
    world, track, scene, laps: m.laps, cars, me, boxes,
    goAt: performance.now() + m.delay, lastBeep: 4,
    objs: new Map(), parts: new Particles(scene), skids: new Skids(scene), rings: [], warn: false,
    item: null, itemFlash: 0, pending: false, lastSend: 0, firedLatch: false,
    lapShown: 1, lapBanner: 0, shake: 0, camYaw: me.a, camPos: null, fov: 64,
    prevU: 0, prevV: 0, stuckT: 0, lastReset: -1e9, resetLatch: false, roll: 0, pitch: 0, dmg: 0, wrongWay: 0, mySkid: null, sentFinish: false,
  };
  show(null);
}

function endGame() {
  if (!game) return;
  const s = game.scene;
  // remove dynamic objects; the static world is cached for reuse
  s.remove(game.me.mesh.root);
  for (const c of game.cars.values()) s.remove(c.mesh.root);
  for (const b of game.boxes) s.remove(b.mesh);
  for (const o of game.objs.values()) s.remove(o.mesh);
  for (const rg of game.rings) s.remove(rg.m);
  for (const p of game.parts.pool) s.remove(p.s);
  s.remove(game.skids.mesh);
  game = null;
  Snd.silence();
}

function onSnap(m) {
  for (const s of m.cars) {
    if (s.id === myId) { if (s.fin) game.me.fin = s.fin; continue; }
    const c = game.cars.get(s.id);
    if (!c) continue;
    c.tx = s.x; c.ty = s.y; c.ta = s.a; c.sp = s.sp; c.total = s.total; c.f = s.f; c.fin = s.fin; c.stT = s.st || 0; c.ghost = s.f & 16 ? 1 : 0; c.tz = s.z || 0;
  }
}

function spawnObj(o) {
  const flying = o.kind === 'rocket' || o.kind === 'homing';
  const mesh = o.kind === 'rocket' ? makeRocketMesh() : o.kind === 'homing' ? makeHomingMesh() : o.kind === 'mine' ? makeMineMesh() : makeOilMesh();
  mesh.position.set(o.x, flying ? 10 : o.kind === 'mine' ? 0 : 0.35, o.y);
  if (flying) { mesh.rotation.y = -Math.atan2(o.vy, o.vx); Snd.whoosh(); if (o.kind === 'homing') Snd.tone(1400, 0.12, 'square', 0.05); }
  else if (o.kind === 'mine') Snd.tone(180, 0.15, 'square', 0.08, -60);
  else Snd.splat();
  game.scene.add(mesh);
  game.objs.set(o.id, Object.assign({}, o, { born: performance.now(), mesh }));
}
function removeObj(id) {
  const o = game.objs.get(id);
  if (o) { game.scene.remove(o.mesh); game.objs.delete(id); }
}

// expanding ground ring (shockwave)
function ring(x, y, r, color) {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  m.position.set(x, 3, y); m.scale.setScalar(10);
  game.scene.add(m);
  game.rings.push({ m, r, t: 0 });
}
function onBlast(m) {
  ring(m.x, m.y, m.r, 0x7fd4ff); ring(m.x, m.y, m.r * 0.7, 0xffffff);
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * 6.283;
    game.parts.emit(m.x, 6, m.y, { vx: Math.cos(a) * 520, vz: Math.sin(a) * 520, vy: 30, life: 0.5, size: 14, grow: 30, color: 0x9fe2ff, add: true, alpha: 0.8, drag: 3 });
  }
  const me = game.me, d = Math.hypot(me.x - m.x, me.y - m.y);
  if (d < 1200) { Snd.boom(); Snd.tone(90, 0.6, 'sine', 0.2, -40); game.shake = Math.max(game.shake, 0.6 * (1 - d / 1200)); }
  if (m.owner !== myId && d < m.r && me.spin <= 0) {
    const res = S.applyHit(me, 'shockwave');
    if (res === 'hit') { game.item = null; game.popup = { text: 'SHOCKWAVE!', sub: '', color: '#7fd4ff', t: 1.2 }; }
    else if (res === 'shield') Snd.tone(300, 0.25, 'sine', 0.1);
  }
}
function explode(x, y, big = 1) {
  const P = game.parts;
  for (let i = 0; i < 18 * big; i++) {
    const a = Math.random() * 6.283, v = 40 + Math.random() * 140;
    P.emit(x, 8 + Math.random() * 10, y, { vx: Math.cos(a) * v, vz: Math.sin(a) * v, vy: 40 + Math.random() * 80, life: 0.5 + Math.random() * 0.3,
      size: 14 * big, grow: 30 * big, color: i % 3 ? 0xffa030 : 0xffe080, add: true, alpha: 0.9, drag: 3 });
  }
  for (let i = 0; i < 10; i++) {
    P.emit(x + (Math.random() - .5) * 20, 10, y + (Math.random() - .5) * 20, { vy: 30 + Math.random() * 30, life: 1.6, size: 20, grow: 50, color: 0x333333, alpha: 0.55, drag: 1 });
  }
  const d = Math.hypot(x - game.me.x, y - game.me.y);
  if (d < 900) { game.shake = Math.max(game.shake, 0.5 * (1 - d / 900)); Snd.boom(); }
}

function sparks(x, y, n, nx = 0, ny = 0) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * 6.283, v = 80 + Math.random() * 220;
    game.parts.emit(x, 6 + Math.random() * 6, y, { vx: Math.cos(a) * v + nx * 120, vz: Math.sin(a) * v + ny * 120, vy: 60 + Math.random() * 120,
      g: 500, life: 0.35 + Math.random() * 0.25, size: 2.5, color: 0xffd060, add: true, alpha: 1, drag: 1 });
  }
}

function useItem() {
  const g = game, me = g.me;
  if (!g.item || me.spin > 0) return;
  const k = g.item; g.item = null;
  if (k === 'boost') { me.boost = 1.8; Snd.tone(200, 0.5, 'sawtooth', 0.05, 500); }
  else if (k === 'shield') { me.shield = 6; Snd.tone(600, 0.3, 'sine', 0.08, 400); }
  else if (k === 'mega') { me.boost = 3.2; me.mega = 3.2; Snd.tone(120, 1.2, 'sawtooth', 0.07, 400); Snd.cheer(); g.popup = { text: 'MEGA TURBO!', sub: 'unstoppable', color: '#ff8a2a', t: 1.4 }; }
  else send({ t: 'use', kind: k });
}

// ---------------- update ----------------
function rearWheels(c) {
  const fx = Math.cos(c.a), fy = Math.sin(c.a);
  return [[c.x - fx * 14 - fy * 12.5, c.y - fy * 14 + fx * 12.5], [c.x - fx * 14 + fy * 12.5, c.y - fy * 14 - fx * 12.5]];
}
function trackSkid(holder, car, sliding, dirt) {
  const wheels = rearWheels(car);
  if (sliding) {
    if (holder.last) wheels.forEach((w, i) => game.skids.add(holder.last[i][0], holder.last[i][1], w[0], w[1]));
    holder.last = wheels;
    if (Math.random() < 0.7) {
      const w = wheels[Math.random() < 0.5 ? 0 : 1];
      game.parts.emit(w[0], 3, w[1], { vx: (Math.random() - .5) * 30, vz: (Math.random() - .5) * 30, vy: 12 + Math.random() * 10,
        life: 1.1, size: 10, grow: 34, color: dirt ? 0x9a7a52 : 0xdedede, alpha: dirt ? 0.5 : 0.38, drag: 1.2 });
    }
  } else holder.last = null;
}

function update(dt, now) {
  const g = game, me = g.me, track = g.track;
  const racing = now >= g.goAt;
  const finished = !!me.fin || me.total >= g.laps * track.len;

  const left = Math.ceil((g.goAt - now) / 1000);
  if (left < g.lastBeep && left >= 0) { g.lastBeep = left; Snd.tone(left === 0 ? 880 : 440, left === 0 ? 0.5 : 0.18, 'square', 0.07); }

  let input = {};
  if (racing && !finished) input = { up: inp('up'), down: inp('down'), left: inp('left'), right: inp('right'), hand: inp('hand') };
  else if (racing && finished) { S.botRecover(me, dt, track); input = S.botInput(track, me, 0, 0.85); }
  else input = { hand: true }; // hold on the grid
  me.crash = 0;
  S.stepCar(me, input, dt, track);

  // wall impact feedback
  if (me.crash > 60) {
    const wn = me.wallN || { nx: 0, ny: 0 };
    sparks(me.x + wn.nx * 13, me.y + wn.ny * 13, Math.min(20, me.crash / 25 | 0), -wn.nx, -wn.ny);
    if (me.crash > 120) { Snd.crash(me.crash); g.shake = Math.max(g.shake, Math.min(0.6, me.crash / 900)); g.dmg += me.crash / 1500; }
    else if (Math.random() < 0.3) Snd.burst(0.1, 2500, 'bandpass', 0.05, 2);
  }

  // landings and stunts
  if (me.landImpact) {
    const imp = me.landImpact; me.landImpact = 0;
    if (imp > 80) {
      for (let i = 0; i < 16; i++) {
        const a = Math.random() * 6.283;
        g.parts.emit(me.x + Math.cos(a) * 14, 3, me.y + Math.sin(a) * 14, { vx: Math.cos(a) * 90, vz: Math.sin(a) * 90, vy: 15, life: 0.9,
          size: 10, grow: 30, color: me.surf === 'dirt' ? 0x9a7a52 : 0xcfcfcf, alpha: 0.5, drag: 2 });
      }
      Snd.crash(Math.min(320, imp * 0.9)); g.shake = Math.max(g.shake, Math.min(0.45, imp / 700));
    }
  }
  if (me.stunt) {
    const st = me.stunt; me.stunt = null;
    if (st.kind === 'clean') {
      const txt = st.spins >= 2 ? (360 * st.spins) + '!!' : st.spins === 1 ? '360!' : st.air > 0.7 ? 'BIG AIR!' : 'NICE JUMP';
      g.popup = { text: txt, sub: '+TURBO', color: '#ffc53d', t: 1.6 };
      Snd.tone(784, 0.1, 'triangle', 0.08); Snd.tone(1175, 0.18, 'triangle', 0.07);
      if (st.spins) Snd.tone(1568, 0.25, 'triangle', 0.06);
    } else if (st.kind === 'rough') g.popup = { text: 'ROUGH LANDING', sub: '', color: '#ffffff', t: 1.2 };
    else { g.popup = { text: 'CRASH LANDING!', sub: '', color: '#ff5a4a', t: 1.4 }; Snd.crash(400); }
  }
  if (g.popup) { g.popup.t -= dt; if (g.popup.t <= 0) g.popup = null; }

  // lap banner / finish
  const lap = Math.max(1, Math.floor(me.total / track.len) + 1);
  if (lap > g.lapShown && lap <= g.laps) { g.lapShown = lap; g.lapBanner = 2; Snd.tone(660, 0.1); Snd.tone(990, 0.2); }
  g.lapBanner = Math.max(0, g.lapBanner - dt);
  if (!me.fin && !g.sentFinish && me.total >= g.laps * track.len) { g.sentFinish = true; send({ t: 'finish' }); Snd.cheer(); Snd.tone(523, 0.15); Snd.tone(784, 0.4); }

  if (inp('fire') && !g.firedLatch && racing && !finished) useItem();
  g.firedLatch = inp('fire');

  // reset onto the track (R / touch button), with a short cooldown
  if (inp('reset') && !g.resetLatch && racing && !finished && now - g.lastReset > 1500) {
    S.resetCar(track, me);
    g.lastReset = now; g.last = null; g.stuckSince = 0; g.wrongWay = 0;
    g.camYaw = me.a; g.camPos = null;
    Snd.tone(520, 0.12, 'triangle', 0.08); Snd.tone(780, 0.16, 'triangle', 0.06);
  }
  g.resetLatch = inp('reset');
  const stuckNow = racing && !finished && Math.abs(me.sp) < 40 && me.spin <= 0;
  if (!stuckNow) g.stuckSince = 0; else if (!g.stuckSince) g.stuckSince = now;
  g.stuckT = g.stuckSince ? (now - g.stuckSince) / 1000 : 0;

  // wrong way detection
  const tp = S.roadPoint(track, me);
  const along = Math.cos(me.a) * tp.dx + Math.sin(me.a) * tp.dy;
  g.wrongWay = racing && along < -0.4 && me.sp > 80 ? g.wrongWay + dt : 0;

  // remote cars
  let otherRpm = 0, otherVol = 0;
  for (const c of g.cars.values()) {
    c.tx += Math.cos(c.ta) * c.sp * dt; c.ty += Math.sin(c.ta) * c.sp * dt;
    const k = Math.min(1, dt * 12);
    if (Math.hypot(c.tx - c.x, c.ty - c.y) > 300) { c.x = c.tx; c.y = c.ty; }
    c.px = c.x; c.py = c.y;
    c.x += (c.tx - c.x) * k; c.y += (c.ty - c.y) * k;
    c.a += S.wrapAngle(c.ta - c.a) * k;
    c.st += ((c.stT || 0) - c.st) * Math.min(1, dt * 10);
    c.vx = (c.x - c.px) / Math.max(dt, 1e-3); c.vy = (c.y - c.py) / Math.max(dt, 1e-3);
    const spd = Math.hypot(c.vx, c.vy);
    const latv = -c.vx * Math.sin(c.a) + c.vy * Math.cos(c.a);
    c.roll += (Math.max(-0.08, Math.min(0.08, -latv * 0.0004 - c.st * spd * 0.00006)) - c.roll) * Math.min(1, dt * 6);
    S.locate(track, c);
    const env = S.envelope(track, c), remoteDirt = !env.onRoad || env.kind === 'dirt';
    c.z += ((c.tz || 0) - c.z) * Math.min(1, dt * 14);
    trackSkid(c, c, c.z < 1 && ((Math.abs(latv) > 70 && spd > 120) || (c.f & 1)), remoteDirt);
    if (remoteDirt && c.z < 1 && spd > 150 && Math.random() < 0.4) g.parts.emit(c.x - Math.cos(c.a) * 20, 3, c.y - Math.sin(c.a) * 20, { vy: 18, life: 0.9, size: 9, grow: 30, color: 0x9a7a52, alpha: 0.45, drag: 1.5 });
    if (c.f & 1) c.smoke = 2.5;
    c.smoke = Math.max(0, c.smoke - dt);
    if (c.smoke > 0 && Math.random() < 0.4) g.parts.emit(c.x, 14, c.y, { vy: 25, vx: (Math.random() - .5) * 20, vz: (Math.random() - .5) * 20, life: 1.4, size: 10, grow: 28, color: 0x2a2a2a, alpha: 0.5, drag: 0.8 });
    if (c.f & 2) emitFlame(c);
    // physical bump: only my car reacts; theirs is authoritative elsewhere
    const imp = S.collide(me, c, true, false);
    if (imp > 70) { Snd.crash(imp * 0.8); sparks((me.x + c.x) / 2, (me.y + c.y) / 2, Math.min(18, imp / 30 | 0)); g.shake = Math.max(g.shake, Math.min(0.5, imp / 1000)); }
    const d = Math.hypot(c.x - me.x, c.y - me.y);
    const vol = Math.max(0, 1 - d / 700);
    if (vol > otherVol) { otherVol = vol; otherRpm = 1200 + (Math.abs(c.sp) % 130) * 45; }
  }

  // pickups
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
  for (const b of g.boxes) {
    const vis = b.until <= now;
    b.mesh.visible = vis;
    if (vis) { b.mesh.rotation.set(now / 900 + b.id, now / 700 + b.id, 0); b.mesh.position.y = 15 + Math.sin(now / 300 + b.id) * 2.5; }
  }

  // projectiles / hazards
  g.warn = false;
  for (const o of g.objs.values()) {
    const age = (now - o.born) / 1000;
    if (age > o.life) { removeObj(o.id); continue; }
    const tgt = o.target ? (o.target === myId ? me : g.cars.get(o.target)) : null;
    S.stepProjectile(o, dt, tgt, age);
    o.mesh.position.x = o.x; o.mesh.position.z = o.y;
    if (o.kind === 'homing') { o.mesh.rotation.y = -Math.atan2(o.vy, o.vx); if (o.target === myId) g.warn = true; }
    if (o.kind === 'rocket' || o.kind === 'homing') g.parts.emit(o.x, 10, o.y, { vy: 6, life: 0.7, size: 6, grow: 22, color: o.kind === 'homing' ? 0xffb0a0 : 0xcfcfcf, alpha: 0.45, drag: 2 });
    if (o.kind === 'mine' && o.mesh.userData.light) o.mesh.userData.light.material.emissiveIntensity = age > S.PROJ.mineArm && Math.floor(now / 250) % 2 ? 4 : 0.2;
    if (me.spin > 0 || !S.canHit(o, myId, age)) continue;
    if (Math.hypot(o.x - me.x, o.y - me.y) < 30) {
      removeObj(o.id);
      send({ t: 'hit', oid: o.id, x: o.x, y: o.y });
      const res = S.applyHit(me, o.kind);
      if (res === 'shield') Snd.tone(300, 0.25, 'sine', 0.1);
      else if (res === 'hit') { g.item = null; if (o.kind === 'oil') Snd.burst(0.6, 1200, 'bandpass', 0.2, 6); }
      explode(o.x, o.y, o.kind === 'mine' ? 1.6 : 1);
    }
  }

  for (const rg of g.rings) {
    rg.t += dt; const k = Math.min(1, rg.t / 0.55);
    rg.m.scale.setScalar(10 + (rg.r - 10) * (1 - (1 - k) * (1 - k)));
    rg.m.material.opacity = 0.9 * (1 - k);
    if (k >= 1) g.scene.remove(rg.m);
  }
  g.rings = g.rings.filter(rg => rg.t < 0.55);
  if (g.warn) { g.warnT = (g.warnT || 0) - dt; if (g.warnT <= 0) { Snd.tone(1700, 0.08, 'square', 0.05); g.warnT = 0.35; } }

  // my car effects
  const spd = Math.hypot(me.vx, me.vy);
  trackSkid(g, me, !me.inAir && ((me.slip > 0.13 && spd > 90) || me.spin > 0 || (input.hand && spd > 60)), me.off || me.surf === 'dirt');
  if ((me.off || me.surf === 'dirt') && !me.inAir && spd > 120 && Math.random() < 0.6) {
    const w = rearWheels(me)[Math.random() < 0.5 ? 0 : 1];
    g.parts.emit(w[0], 3, w[1], { vx: -me.vx * 0.15, vz: -me.vy * 0.15, vy: 20, life: 0.9, size: 9, grow: 30, color: 0x9a7a52, alpha: 0.5, drag: 1.5 });
  }
  if (me.boost > 0) emitFlame(me);
  g.dmg = Math.max(0, g.dmg - dt * 0.02);
  if ((g.dmg > 0.6 || me.spin > 0) && Math.random() < 0.35) {
    g.parts.emit(me.x + Math.cos(me.a) * 16, 14, me.y + Math.sin(me.a) * 16, { vy: 25, life: 1.3, size: 8, grow: 26, color: 0x303030, alpha: 0.45, drag: 0.8 });
  }

  // body roll & pitch from accelerations
  const fx = Math.cos(me.a), fy = Math.sin(me.a);
  const u = me.vx * fx + me.vy * fy;
  const longA = (u - g.prevU) / Math.max(dt, 1e-3);
  g.prevU = u;
  const latA = me.w * u;
  g.roll += (Math.max(-0.1, Math.min(0.1, -latA * 0.00007)) - g.roll) * Math.min(1, dt * 7);
  const pitchT = me.inAir ? Math.max(-0.35, Math.min(0.3, me.vz / 700))
    : me.onRamp ? Math.atan2(me.onRamp.h, me.onRamp.len) : Math.max(-0.06, Math.min(0.06, -longA * 0.00005));
  g.pitch += (pitchT - g.pitch) * Math.min(1, dt * (me.onRamp ? 20 : 7));

  g.parts.update(dt);
  g.itemFlash = Math.max(0, g.itemFlash - dt);
  g.shake = Math.max(0, g.shake - dt * 1.5);

  if (now - g.lastSend > 50) {
    g.lastSend = now;
    send({ t: 'state', x: +me.x.toFixed(1), y: +me.y.toFixed(1), a: +me.a.toFixed(3), sp: Math.round(me.sp),
      vx: Math.round(me.vx), vy: Math.round(me.vy), z: Math.round(me.z), st: +me.steer.toFixed(2), br: me.braking ? 1 : 0,
      gh: me.ghost > 0 ? 1 : 0, total: Math.round(me.total), spin: +me.spin.toFixed(2), boost: +me.boost.toFixed(2), shield: +me.shield.toFixed(2), mega: +(me.mega || 0).toFixed(2) });
  }

  // audio
  let crowd = 0;
  for (const s of g.world.crowdAt) crowd = Math.max(crowd, 1 - Math.hypot(s.x - me.x, s.y - me.y) / 900);
  Snd.update({ active: true, rpm: me.rpm, throttle: input.up || me.boost > 0 ? 1 : 0, boost: me.boost > 0,
    slip: Math.max(me.slip, input.hand && spd > 60 ? 0.35 : 0, me.spin > 0 ? 0.5 : 0), speed: spd, off: me.off,
    otherRpm, otherVol, crowd: Math.max(0, crowd) });
}

function emitFlame(c) {
  const fx = Math.cos(c.a), fy = Math.sin(c.a);
  game.parts.emit(c.x - fx * 30, 8, c.y - fy * 30, { vx: -fx * 160 + (c.vx || 0) * 0.6, vz: -fy * 160 + (c.vy || 0) * 0.6, vy: 5,
    life: 0.22, size: 8, grow: 6, color: Math.random() < 0.5 ? 0xffc040 : 0xff6020, add: true, alpha: 0.9, drag: 4 });
}

// ---------------- camera ----------------
function updateCamera(dt) {
  const g = game, me = g.me;
  const spd = Math.hypot(me.vx, me.vy);
  // during spins and air tricks the camera follows where the car is going, not where it points
  const target = me.spin > 0 || me.inAir ? (spd > 80 ? Math.atan2(me.vy, me.vx) : g.camYaw) : me.a;
  g.camYaw += S.wrapAngle(target - g.camYaw) * Math.min(1, dt * (camMode === 2 ? 14 : 5));
  const cx = Math.cos(g.camYaw), cy = Math.sin(g.camYaw);
  const [dist, height, look] = camMode === 0 ? [92, 36, 60] : camMode === 1 ? [150, 62, 70] : [-6, 17, 120];
  g.camZ = (g.camZ || 0) + ((me.z || 0) - (g.camZ || 0)) * Math.min(1, dt * 6); // ease up/down with jumps
  const want = new THREE.Vector3(me.x - cx * dist, height + g.camZ * (camMode === 2 ? 1 : 0.75), me.y - cy * dist);
  if (!g.camPos || camMode === 2) g.camPos = want.clone();
  else g.camPos.lerp(want, Math.min(1, dt * 9));
  camera.position.copy(g.camPos);
  if (g.shake > 0) camera.position.add(new THREE.Vector3((Math.random() - .5) * 10 * g.shake, (Math.random() - .5) * 6 * g.shake, (Math.random() - .5) * 10 * g.shake));
  camera.lookAt(me.x + cx * look, (camMode === 2 ? 14 : 12) + g.camZ * 0.6, me.y + cy * look);
  const fov = 62 + Math.min(1, spd / 700) * 12 + (me.boost > 0 ? 8 : 0);
  g.fov += (fov - g.fov) * Math.min(1, dt * 3);
  camera.fov = g.fov; camera.updateProjectionMatrix();
  const w = g.world;
  w.sun.position.set(me.x + w.sunOff.x, w.sunOff.y, me.y + w.sunOff.z);
  w.sun.target.position.set(me.x, 0, me.y);
  // debug-only showroom camera used by automated screenshots
  if (window.__camOverride) {
    const o = window.__camOverride, a = me.a + o.ang;
    camera.position.set(me.x + Math.cos(a) * o.dist, o.hgt, me.y + Math.sin(a) * o.dist);
    camera.lookAt(me.x, 8, me.y); camera.fov = 45; camera.updateProjectionMatrix();
  }
}

// attract mode: a camera drone flies along the current lobby track
const attract = { t: 0 };
// garage showroom: in the lobby, orbit the selected car parked behind the start line
const showroom = { mesh: null, key: '', scene: null };
function clearShowroom() {
  if (showroom.mesh) showroom.scene.remove(showroom.mesh.root);
  showroom.mesh = null; showroom.key = '';
  camera.clearViewOffset();
}
function renderShowroom(dt) {
  attract.t += dt;
  const w = getWorld(lobby.track), track = w.track;
  const mine = lobby.players.find(p => p.id === myId);
  const color = mine ? mine.color : '#e6372e', key = myCar + color + lobby.track;
  if (showroom.key !== key) {
    clearShowroom();
    showroom.mesh = makeCarMesh(color, null, myCar); showroom.scene = w.scene; showroom.key = key;
    w.scene.add(showroom.mesh.root);
  }
  const p = track.pts[(track.N - 4) % track.N];
  poseCar(showroom.mesh, { x: p.x, y: p.y, z: 0, a: p.ang, sp: 0, steer: Math.sin(attract.t * 0.6) * 0.7 }, dt);
  const ang = p.ang + attract.t * 0.28;
  camera.position.set(p.x + Math.cos(ang) * 95, 30, p.y + Math.sin(ang) * 95);
  camera.lookAt(p.x, 9, p.y);
  camera.fov = 42; camera.updateProjectionMatrix();
  if (W > 900) camera.setViewOffset(W, H, -W * 0.2, 0, W, H); else camera.clearViewOffset();
  w.sun.position.set(p.x + w.sunOff.x, w.sunOff.y, p.y + w.sunOff.z); w.sun.target.position.set(p.x, 0, p.y);
  w.update(dt, camera, attract.t);
  render(w.scene, 0, performance.now());
}
function renderAttract(dt) {
  if (lobby && !$('lobby').classList.contains('hidden') && lobby.phase !== 'racing') return renderShowroom(dt);
  if (showroom.mesh) clearShowroom();
  attract.t += dt;
  const idx = lobby ? lobby.track : 0, w = getWorld(idx), track = w.track;
  const k = Math.floor((attract.t * 9) % track.N), p = track.pts[k], q = track.pts[(k + 25) % track.N];
  const side = Math.sin(attract.t * 0.2) * 220;
  camera.position.lerp(new THREE.Vector3(p.x + p.nx * side, 150, p.y + p.ny * side), attract.t < 0.1 ? 1 : Math.min(1, dt * 2));
  camera.lookAt(q.x, 0, q.y);
  camera.fov = 60; camera.updateProjectionMatrix();
  w.sun.position.set(p.x + w.sunOff.x, w.sunOff.y, p.y + w.sunOff.z); w.sun.target.position.set(p.x, 0, p.y);
  w.update(dt, camera, attract.t);
  render(w.scene, 0, performance.now());
}

// ---------------- HUD ----------------
const ITEM_ICON = { boost: '⚡', rocket: '🚀', oil: '🛢️', shield: '🛡️', mine: '💣', triple: '🎆', homing: '🎯', shockwave: '💥', mega: '☄️' };
const ITEM_NAME = { boost: 'TURBO', rocket: 'ROCKET', oil: 'OIL SLICK', shield: 'SHIELD', mine: 'MINE', triple: 'TRIPLE ROCKET', homing: 'HOMING', shockwave: 'SHOCKWAVE', mega: 'MEGA TURBO' };

function drawHud(now) {
  const g = game, me = g.me, track = g.track;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
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
  // lap timer: current / last / best (timed locally for display; the server's times are official)
  const li = Math.floor(me.total / track.len);
  if (g.lapIdx === undefined || li < g.lapIdx) g.lapIdx = li;
  if (li > g.lapIdx) { g.lapIdx = li; g.lapStart = now; }
  if (!me.fin) {
    panel(16, 108, 168, 58);
    ctx.font = '600 12px Inter,sans-serif'; ctx.fillStyle = '#a8a3b5';
    ctx.fillText('LAP', 28, 116); ctx.fillText('LAST', 28, 133); ctx.fillText('BEST', 28, 150);
    ctx.font = '700 13px Inter,sans-serif'; ctx.fillStyle = '#fff';
    ctx.fillText(g.lapStart ? fmtTime(now - g.lapStart) : '-', 80, 116);
    ctx.fillText(g.lastLap ? fmtTime(g.lastLap) : '-', 80, 133);
    ctx.fillStyle = '#ffc53d'; ctx.fillText(g.bestLap ? fmtTime(g.bestLap) : '-', 80, 150);
  }

  // item slot
  const ix = W - 96, iy = 16;
  panel(ix, iy, 80, 80);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (g.item) {
    ctx.font = '38px sans-serif';
    ctx.save(); const sc = 1 + g.itemFlash * 0.6; ctx.translate(ix + 40, iy + 36); ctx.scale(sc, sc);
    ctx.fillText(ITEM_ICON[g.item], 0, 0); ctx.restore();
    ctx.font = '800 10px Inter,sans-serif'; ctx.fillStyle = '#ffc53d'; ctx.fillText(ITEM_NAME[g.item], ix + 40, iy + 68);
  } else if (g.pending) {
    ctx.font = '34px sans-serif'; ctx.fillText(Object.values(ITEM_ICON)[Math.floor(now / 80) % 4], ix + 40, iy + 40);
  } else {
    ctx.fillStyle = '#a8a3b5'; ctx.font = '600 11px Inter,sans-serif'; ctx.fillText('NO ITEM', ix + 40, iy + 40);
  }

  // speedo: speed, gear and rev bar
  const kmh = Math.round(Math.hypot(me.vx, me.vy) * 0.32);
  const sx = isTouch ? W / 2 - 75 : 16, sy = isTouch ? 16 : H - 82;
  panel(sx, sy, 150, 66);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = me.boost > 0 ? '#ffc53d' : '#fff'; ctx.font = '400 28px Bungee,Impact,sans-serif';
  ctx.fillText(kmh, sx + 12, sy + 36);
  ctx.fillStyle = '#a8a3b5'; ctx.font = '600 11px Inter,sans-serif'; ctx.fillText('KM/H', sx + 76, sy + 34);
  ctx.textAlign = 'right'; ctx.fillStyle = '#ffc53d'; ctx.font = '400 26px Bungee,Impact,sans-serif';
  ctx.fillText(me.sp < -10 && !me.inAir ? 'R' : me.gear, sx + 140, sy + 36);
  const rpmT = Math.min(1, (me.rpm - 900) / 6600);
  for (let i = 0; i < 14; i++) {
    const on = i / 14 < rpmT;
    ctx.fillStyle = on ? (i > 11 ? '#ff4d3a' : i > 8 ? '#ffc53d' : '#5ee07a') : 'rgba(255,255,255,.12)';
    ctx.fillRect(sx + 12 + i * 9.1, sy + 46, 7, 9);
  }

  // minimap
  const M = getMini(track.idx), mx = W - M.w - 28, my = isTouch ? 112 : H - M.h - 28;
  panel(mx - 12, my - 12, M.w + 24, M.h + 24);
  ctx.save(); ctx.translate(mx, my);
  ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 4; ctx.stroke(M.path);
  ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(214,170,110,.9)'; ctx.lineWidth = 3; ctx.stroke(M.shortcuts); ctx.setLineDash([]);
  ctx.fillStyle = '#ffc61a'; for (const [rx, ry] of M.ramps) { ctx.beginPath(); ctx.moveTo(rx, ry - 4); ctx.lineTo(rx + 4, ry + 3); ctx.lineTo(rx - 4, ry + 3); ctx.fill(); }
  const b = track.bounds, sc = M.sc;
  for (const c of g.cars.values()) { ctx.fillStyle = c.color; ctx.beginPath(); ctx.arc((c.x - b.minX) * sc, (c.y - b.minY) * sc, 4, 0, 6.283); ctx.fill(); }
  ctx.fillStyle = me.color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc((me.x - b.minX) * sc, (me.y - b.minY) * sc, 6, 0, 6.283); ctx.fill(); ctx.stroke();
  ctx.restore();

  // center messages
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const left = (g.goAt - now) / 1000;
  if (left > 0) bigText(Math.ceil(left), '#fff', 1 + (left % 1) * 0.4);
  else if (left > -0.9) bigText('GO!', '#ffc53d', 1 + (-left) * 0.5);
  else if (g.lapBanner > 0) bigText(lap === g.laps ? 'FINAL LAP' : 'LAP ' + lap, '#fff', 0.6);
  else if (me.fin) bigText(pos + ordinal(pos) + '!', '#ffc53d', 0.8);
  else if (g.wrongWay > 1) bigText('WRONG WAY', '#ff5a4a', 0.55);
  if (g.stuckT > 2.5 || g.wrongWay > 3) {
    const msg = isTouch ? 'Stuck? Tap ↺ to reset' : 'Stuck? Press R to reset';
    ctx.font = '800 17px Inter,sans-serif';
    const tw = ctx.measureText(msg).width + 32;
    ctx.fillStyle = 'rgba(15,13,22,.8)'; ctx.beginPath(); ctx.roundRect(W / 2 - tw / 2, H * 0.88 - 20, tw, 40, 20); ctx.fill();
    ctx.fillStyle = "#ffc53d"; ctx.fillText(msg, W / 2, H * 0.88);
  }
  if (g.warn && Math.floor(now / 220) % 2) {
    ctx.font = '800 20px Inter,sans-serif';
    const msg = '⚠ MISSILE INCOMING', tw = ctx.measureText(msg).width + 36;
    ctx.fillStyle = 'rgba(200,20,20,.85)'; ctx.beginPath(); ctx.roundRect(W / 2 - tw / 2, H * 0.14 - 20, tw, 40, 20); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText(msg, W / 2, H * 0.14);
  }
  if (g.popup) {
    const a = Math.min(1, g.popup.t * 2), sc = 1 + Math.max(0, g.popup.t - 1.2) * 0.8;
    ctx.save(); ctx.globalAlpha = a; ctx.translate(W / 2, H * 0.22); ctx.scale(sc, sc);
    ctx.font = `400 ${Math.min(56, W / 10)}px Bungee,Impact,sans-serif`; ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(0,0,0,.6)';
    ctx.strokeText(g.popup.text, 0, 0); ctx.fillStyle = g.popup.color; ctx.fillText(g.popup.text, 0, 0);
    if (g.popup.sub) { ctx.font = '800 18px Inter,sans-serif'; ctx.fillStyle = '#5ee07a'; ctx.fillText(g.popup.sub, 0, 40); }
    ctx.restore();
  }
  if (me.inAir && me.airT > 0.15 && !g.popup && !isTouch) { ctx.font = '700 14px Inter,sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.fillText('← → to spin · land straight!', W / 2, H * 0.22); }
  if (me.spin > 0) { ctx.font = '800 18px Inter,sans-serif'; ctx.fillStyle = '#ff6b6b'; ctx.fillText('SPUN OUT!', W / 2, H * 0.62); }
  if (left > 0 && left < 3.4) { ctx.font = '600 13px Inter,sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fillText(isTouch ? '' : 'Space = handbrake · E/Shift = item · R = reset · C = camera', W / 2, H * 0.62); }
}
function bigText(t, color, scale) {
  ctx.save(); ctx.translate(W / 2, H * 0.3); ctx.scale(scale, scale);
  ctx.font = `400 ${Math.min(110, W / 5)}px Bungee,Impact,sans-serif`;
  ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.strokeText(t, 0, 0);
  ctx.fillStyle = color; ctx.fillText(t, 0, 0); ctx.restore();
}
function panel(x, y, w, h) {
  ctx.fillStyle = 'rgba(15,13,22,.72)'; ctx.beginPath(); ctx.roundRect(x, y, w, h, 12); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1; ctx.stroke();
}
function ordinal(n) { return ['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4] || 'th'; }

// ---------------- main loop ----------------
let last = performance.now();
function frame(now) {
  const dt = Math.max(0, Math.min(0.1, (now - last) / 1000)); last = now;
  if (game) {
    update(dt, now);
    const me = game.me;
    me.mesh.root.visible = !(me.ghost > 0 && Math.floor(now / 90) % 2);
    poseCar(me.mesh, { x: me.x, y: me.y, z: me.z, a: me.a, sp: me.sp, steer: me.steer, roll: game.roll, pitch: game.pitch,
      braking: me.braking || inp('hand'), boost: me.boost > 0, shield: me.shield > 0, mega: me.mega > 0 }, dt);
    for (const c of game.cars.values()) {
      poseCar(c.mesh, { x: c.x, y: c.y, z: c.z, a: c.a, sp: c.sp, steer: c.st, roll: c.roll, pitch: Math.max(-0.3, Math.min(0.3, ((c.tz || 0) - c.z) * 0.05)), braking: c.f & 8, boost: c.f & 2, shield: c.f & 4, mega: c.f & 32 }, dt);
    }
    updateCamera(dt);
    game.world.update(dt, camera, now / 1000);
    const racing = now >= game.goAt;
    render(game.scene, racing ? Math.max(0, (Math.hypot(me.vx, me.vy) - 350) / 600) + (me.boost > 0 ? 0.35 : 0) : 0, now);
    drawHud(now);
  } else {
    renderAttract(dt);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, hud.width, hud.height);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// test hook (only with ?debug in the URL): lets automated tests position the car
if (new URLSearchParams(location.search).has('debug')) window.__tb = { get game() { return game; }, S };
