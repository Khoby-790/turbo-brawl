const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const S = require('./public/shared.js');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const THREE_PATH = path.join(__dirname, 'node_modules', 'three', 'build', 'three.module.min.js');
const MAX_CARS = 8;
const COLORS = ['#e6372e', '#2f7de1', '#f2c12e', '#35b04a', '#a24de0', '#ff8a1f', '#1fc8c8', '#ff4fa3'];
const BOT_NAMES = ['Blaze', 'Nitro', 'Dusty', 'Vroom', 'Sparky', 'Crusher', 'Zippy', 'Torque'];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// ---------- static file server ----------
const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  if (url === '/vendor/three.module.js') {
    return fs.readFile(THREE_PATH, (err, data) => {
      if (err) { res.writeHead(500); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    });
  }
  const file = path.normalize(path.join(PUBLIC, url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- rooms ----------
const rooms = new Map();
let nextId = 1;

function code() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => L[Math.floor(Math.random() * L.length)]).join(''); } while (rooms.has(c));
  return c;
}
function send(ws, m) { if (ws.readyState === 1) ws.send(JSON.stringify(m)); }
function broadcast(room, m) {
  const s = JSON.stringify(m);
  for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(s);
}
function lobbyMsg(room) {
  return {
    t: 'lobby', code: room.code, hostId: room.hostId, phase: room.phase,
    track: room.trackIdx, laps: room.laps, bots: room.bots,
    tracks: S.TRACKS.map(t => t.name),
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color })),
  };
}
function freeColor(room) {
  const used = new Set([...room.players.values()].map(p => p.color));
  return COLORS.find(c => !used.has(c)) || COLORS[Math.floor(Math.random() * COLORS.length)];
}
function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }

function startRace(room) {
  const track = S.buildTrack(room.trackIdx);
  const humans = [...room.players.values()];
  const botCount = Math.max(0, Math.min(room.bots, MAX_CARS - humans.length));
  const usedColors = new Set(humans.map(h => h.color));
  const botColors = COLORS.filter(c => !usedColors.has(c));
  const entrants = [];
  for (let i = 0; i < botCount; i++) {
    entrants.push({ id: 'b' + i, name: BOT_NAMES[i], color: botColors[i % botColors.length], bot: true });
  }
  for (const h of humans) entrants.push({ id: h.id, name: h.name, color: h.color, bot: false });

  room.cars = new Map();
  entrants.forEach((e, slot) => {
    const car = Object.assign(S.makeCar(track, slot), e, {
      finished: false, ft: 0, item: null, itemAt: 0,
      lane: (Math.random() - 0.5) * track.width * 0.5, laneT: 0,
      skill: 0.86 + Math.random() * 0.1,
    });
    room.cars.set(e.id, car);
  });
  room.track = track;
  room.phase = 'racing';
  room.boxTaken = {};
  room.objs = new Map();
  room.nextObj = 1;
  room.startAt = Date.now() + 3500;
  room.firstFinish = 0;
  room.ending = false;
  room.tickN = 0;
  broadcast(room, lobbyMsg(room));
  broadcast(room, {
    t: 'start', track: room.trackIdx, laps: room.laps, delay: 3500,
    cars: [...room.cars.values()].map(c => ({ id: c.id, name: c.name, color: c.color, bot: c.bot, x: c.x, y: c.y, a: c.a })),
  });
}

function spawnObj(room, owner, kind, x, y, a, sp) {
  const id = room.nextObj++;
  const cx = Math.cos(a), cy = Math.sin(a);
  let o;
  if (kind === 'rocket') {
    const v = 1150 + Math.max(0, sp);
    o = { id, kind, owner, x: x + cx * 40, y: y + cy * 40, vx: cx * v, vy: cy * v, life: 2.2 };
  } else {
    o = { id, kind, owner, x: x - cx * 42, y: y - cy * 42, vx: 0, vy: 0, life: 20 };
  }
  o.born = Date.now();
  room.objs.set(id, o);
  broadcast(room, { t: 'spawn', o });
}

function useItem(room, car, kind) {
  if (kind === 'boost') car.boost = 1.8;
  else if (kind === 'shield') car.shield = 6;
  else if (kind === 'rocket' || kind === 'oil') spawnObj(room, car.id, kind, car.x, car.y, car.a, car.sp);
}

function endRace(room) {
  if (room.phase !== 'racing') return;
  room.phase = 'results';
  const cars = [...room.cars.values()];
  const fin = cars.filter(c => c.finished).sort((a, b) => a.ft - b.ft);
  const dnf = cars.filter(c => !c.finished).sort((a, b) => b.total - a.total);
  broadcast(room, {
    t: 'results',
    list: [...fin, ...dnf].map(c => ({ id: c.id, name: c.name, color: c.color, bot: c.bot, time: c.finished ? c.ft : null })),
  });
  broadcast(room, lobbyMsg(room));
}

function finishCar(room, car) {
  if (car.finished) return;
  car.finished = true;
  car.ft = Date.now() - room.startAt;
  if (!room.firstFinish) room.firstFinish = Date.now();
  broadcast(room, { t: 'finished', id: car.id, ft: car.ft });
}

function tickRoom(room) {
  if (room.phase !== 'racing') return;
  const now = Date.now(), dt = 1 / 30, track = room.track;
  room.tickN++;
  const cars = [...room.cars.values()];

  if (now >= room.startAt) {
    // leader among humans, for gentle rubber-banding
    let humanBest = -Infinity;
    for (const c of cars) if (!c.bot) humanBest = Math.max(humanBest, c.total);

    for (const c of cars) {
      if (!c.bot) continue;
      c.laneT -= dt;
      if (c.laneT <= 0) { c.lane = (Math.random() - 0.5) * track.width * 0.55; c.laneT = 2 + Math.random() * 3; }
      const gap = c.total - humanBest;
      const band = gap > 1200 ? 0.88 : gap < -1500 ? 1.08 : 1;
      S.botRecover(c, dt, track);
      const inp = S.botInput(track, c, c.lane, c.skill * band);
      S.stepCar(c, inp, dt, track, c.skill * band);
      c.st = c.steer;
      if (!c.finished && c.total >= room.laps * track.len) finishCar(room, c);

      // pick up boxes
      if (!c.item) {
        for (const b of track.boxes) {
          if ((room.boxTaken[b.id] || 0) > now) continue;
          if (Math.hypot(b.x - c.x, b.y - c.y) < 36) {
            room.boxTaken[b.id] = now + S.BOX_RESPAWN_MS;
            broadcast(room, { t: 'box', id: b.id, ms: S.BOX_RESPAWN_MS });
            c.item = S.ITEMS[Math.floor(Math.random() * S.ITEMS.length)];
            c.itemAt = now + 600 + Math.random() * 2500;
            break;
          }
        }
      } else if (now >= c.itemAt && c.spin <= 0) {
        useItem(room, c, c.item);
        c.item = null;
      }
    }

    // bots get bumped by everyone
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i], b = cars[j];
        if (!a.bot && !b.bot) continue;
        S.collide(a, b, a.bot, b.bot);
      }
    }

    // projectiles / hazards vs bots
    for (const o of room.objs.values()) {
      const age = (now - o.born) / 1000;
      if (age > o.life) { room.objs.delete(o.id); continue; }
      o.x += o.vx * dt; o.y += o.vy * dt;
      for (const c of cars) {
        if (!c.bot || c.spin > 0) continue;
        if (o.owner === c.id && (o.kind === 'rocket' || age < 1)) continue;
        if (Math.hypot(o.x - c.x, o.y - c.y) < 30) {
          if (c.shield > 0) c.shield = 0;
          else { c.spin = 1.2; c.vx *= 0.45; c.vy *= 0.45; c.w = (Math.random() < 0.5 ? -1 : 1) * 8; }
          room.objs.delete(o.id);
          broadcast(room, { t: 'despawn', oid: o.id, hit: true, x: o.x, y: o.y });
          break;
        }
      }
    }
  }

  {
    broadcast(room, {
      t: 'snap',
      cars: cars.map(c => ({
        id: c.id, x: Math.round(c.x), y: Math.round(c.y), a: +c.a.toFixed(3), sp: Math.round(c.sp),
        total: Math.round(c.total), st: +(c.st || 0).toFixed(2),
        f: (c.spin > 0 ? 1 : 0) | (c.boost > 0 ? 2 : 0) | (c.shield > 0 ? 4 : 0) | (c.braking ? 8 : 0) | (c.ghost > 0 ? 16 : 0),
        fin: c.finished ? c.ft : 0,
      })),
    });
  }

  const humans = cars.filter(c => !c.bot);
  if (humans.length === 0) return endRace(room);
  if (humans.every(c => c.finished)) {
    if (!room.ending) { room.ending = true; setTimeout(() => endRace(room), 1500); }
    return;
  }
  if (room.firstFinish && now - room.firstFinish > 45000) return endRace(room);
  if (now - room.startAt > 15 * 60 * 1000) return endRace(room);
}

setInterval(() => {
  for (const room of rooms.values()) tickRoom(room);
}, 1000 / 30);

// ---------- websockets ----------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', ws => {
  let me = null, room = null;

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'join' && !me) {
      const name = String(m.name || 'Racer').replace(/[<>]/g, '').trim().slice(0, 14) || 'Racer';
      let c = String(m.room || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      if (c && !rooms.has(c)) c = '';
      if (!c) {
        c = code();
        rooms.set(c, { code: c, players: new Map(), hostId: null, phase: 'lobby', trackIdx: 0, laps: 3, bots: 3 });
      }
      room = rooms.get(c);
      if (room.players.size >= MAX_CARS) { send(ws, { t: 'error', msg: 'That room is full.' }); room = null; return; }
      me = { id: 'p' + nextId++, ws, name, color: freeColor(room) };
      room.players.set(me.id, me);
      if (!room.hostId) room.hostId = me.id;
      send(ws, { t: 'welcome', id: me.id, code: room.code });
      broadcast(room, lobbyMsg(room));
      return;
    }
    if (!me || !room) return;
    const isHost = room.hostId === me.id;
    const car = room.cars && room.cars.get(me.id);

    switch (m.t) {
      case 'settings':
        if (!isHost || room.phase !== 'lobby') return;
        if (Number.isInteger(m.track) && m.track >= 0 && m.track < S.TRACKS.length) room.trackIdx = m.track;
        if (Number.isInteger(m.laps)) room.laps = Math.max(1, Math.min(9, m.laps));
        if (Number.isInteger(m.bots)) room.bots = Math.max(0, Math.min(7, m.bots));
        broadcast(room, lobbyMsg(room));
        break;
      case 'start':
        if (isHost && room.phase === 'lobby') startRace(room);
        break;
      case 'lobby':
        if (isHost && room.phase === 'results') { room.phase = 'lobby'; room.cars = null; broadcast(room, lobbyMsg(room)); }
        break;
      case 'state':
        if (!car || room.phase === 'lobby') return;
        car.x = num(m.x, car.x); car.y = num(m.y, car.y); car.a = num(m.a, car.a);
        car.sp = num(m.sp, car.sp); car.spin = num(m.spin, 0); car.boost = num(m.boost, 0); car.shield = num(m.shield, 0);
        car.vx = num(m.vx, Math.cos(car.a) * car.sp); car.vy = num(m.vy, Math.sin(car.a) * car.sp);
        car.st = num(m.st, 0); car.braking = !!m.br; car.ghost = m.gh ? 1 : 0;
        // progress can't jump more than a boosted car could plausibly travel
        const nt = num(m.total, car.total);
        if (Math.abs(nt - car.total) < 400) car.total = nt;
        break;
      case 'pickup': {
        if (!car || room.phase !== 'racing') return;
        const b = room.track.boxes.find(x => x.id === m.box);
        const now = Date.now();
        if (b && (room.boxTaken[b.id] || 0) <= now && Math.hypot(b.x - car.x, b.y - car.y) < 140) {
          room.boxTaken[b.id] = now + S.BOX_RESPAWN_MS;
          broadcast(room, { t: 'box', id: b.id, ms: S.BOX_RESPAWN_MS });
          send(ws, { t: 'item', kind: S.ITEMS[Math.floor(Math.random() * S.ITEMS.length)] });
        } else send(ws, { t: 'item', kind: null });
        break;
      }
      case 'use':
        if (!car || room.phase !== 'racing') return;
        if (m.kind === 'rocket' || m.kind === 'oil') spawnObj(room, me.id, m.kind, car.x, car.y, car.a, car.sp);
        break;
      case 'hit':
        if (!room.objs || !room.objs.has(m.oid)) return;
        room.objs.delete(m.oid);
        broadcast(room, { t: 'despawn', oid: m.oid, hit: true, x: num(m.x, 0), y: num(m.y, 0) });
        break;
      case 'finish':
        if (car && room.phase === 'racing' && car.total >= room.laps * room.track.len - 300) finishCar(room, car);
        break;
      case 'chat': {
        const text = String(m.text || '').replace(/[<>]/g, '').slice(0, 120).trim();
        if (text) broadcast(room, { t: 'chat', name: me.name, color: me.color, text });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!me || !room) return;
    room.players.delete(me.id);
    if (room.cars) room.cars.delete(me.id);
    if (room.players.size === 0) { rooms.delete(room.code); return; }
    if (room.hostId === me.id) room.hostId = room.players.keys().next().value;
    broadcast(room, { t: 'left', id: me.id });
    broadcast(room, lobbyMsg(room));
  });
});

server.listen(PORT, () => console.log(`Turbo Brawl running on http://localhost:${PORT}`));
