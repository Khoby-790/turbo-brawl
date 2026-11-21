// Shared track + physics code, used by both the browser and the Node server.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TRACKS = [
    {
      name: 'Canyon Loop', width: 180, grass: '#5a8f3c', accent: '#c7854a',
      pts: [[0, 0], [1400, -200], [2400, 300], [2600, 1300], [1900, 1900], [2300, 2700],
            [1500, 3300], [400, 2900], [-200, 2000], [500, 1300], [-500, 700]],
    },
    {
      name: 'Harbor Hairpins', width: 170, grass: '#3f8a5c', accent: '#4aa3c7',
      pts: [[0, 0], [1800, 0], [2600, 600], [2200, 1300], [1200, 1100], [900, 1700],
            [1900, 2300], [1500, 3000], [200, 2900], [-500, 2000], [-300, 900]],
    },
    {
      name: 'Desert Dash', width: 190, grass: '#b89a5a', accent: '#e0b050',
      pts: [[0, 0], [2200, -300], [3400, 400], [3000, 1500], [1800, 1300], [1300, 2200],
            [2400, 2900], [1200, 3600], [-300, 3000], [-800, 1500]],
    },
  ];

  const ITEMS = ['boost', 'rocket', 'oil', 'shield'];
  const PHYS = { max: 640, accel: 560, brake: 1100, rev: 220, turn: 2.8, grip: 9, offMax: 300, boostMax: 980 };
  const BOX_RESPAWN_MS = 4000;

  function cr(a, b, c, d, t) {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  }

  const cache = {};
  function buildTrack(i) {
    if (cache[i]) return cache[i];
    const def = TRACKS[i];
    const P = def.pts, n = P.length, dense = [];
    for (let k = 0; k < n; k++) {
      const p0 = P[(k - 1 + n) % n], p1 = P[k], p2 = P[(k + 1) % n], p3 = P[(k + 2) % n];
      for (let s = 0; s < 60; s++) {
        const t = s / 60;
        dense.push([cr(p0[0], p1[0], p2[0], p3[0], t), cr(p0[1], p1[1], p2[1], p3[1], t)]);
      }
    }
    const D = dense.length, cum = [0];
    for (let k = 1; k <= D; k++) {
      const a = dense[k - 1], b = dense[k % D];
      cum.push(cum[k - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const len = cum[D], N = Math.round(len / 16), step = len / N, pts = [];
    let j = 0;
    for (let k = 0; k < N; k++) {
      const d = k * step;
      while (cum[j + 1] < d) j++;
      const a = dense[j], b = dense[(j + 1) % D];
      const f = (d - cum[j]) / (cum[j + 1] - cum[j] || 1);
      pts.push({ x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, s: d });
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < N; k++) {
      const a = pts[(k - 1 + N) % N], b = pts[(k + 1) % N], p = pts[k];
      const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
      p.dx = dx / l; p.dy = dy / l; p.nx = -dy / l; p.ny = dx / l;
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    const boxes = [];
    [0.16, 0.41, 0.66, 0.88].forEach((f, gi) => {
      const p = pts[Math.floor(f * N)];
      [-1, 0, 1].forEach((o, bi) => boxes.push({
        id: gi * 3 + bi, x: p.x + p.nx * o * def.width * 0.27, y: p.y + p.ny * o * def.width * 0.27,
      }));
    });
    const t = { idx: i, name: def.name, width: def.width, grass: def.grass, accent: def.accent,
      pts, N, len, step, boxes, bounds: { minX, minY, maxX, maxY } };
    cache[i] = t;
    return t;
  }

  function nearest(track, x, y, hint) {
    const pts = track.pts, N = track.N;
    let best = -1, bd = Infinity;
    if (hint === undefined || hint < 0) {
      for (let k = 0; k < N; k++) {
        const d = (pts[k].x - x) ** 2 + (pts[k].y - y) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
    } else {
      for (let o = -40; o <= 40; o++) {
        const k = (hint + o + N) % N;
        const d = (pts[k].x - x) ** 2 + (pts[k].y - y) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
    }
    return { i: best, d: Math.sqrt(bd) };
  }

  function makeCar(track, slot) {
    const row = Math.floor(slot / 2), col = slot % 2;
    const k = (track.N - 6 - row * 6 + track.N * 2) % track.N;
    const p = track.pts[k], lat = (col ? 1 : -1) * track.width * 0.22;
    return {
      x: p.x + p.nx * lat, y: p.y + p.ny * lat, a: Math.atan2(p.dy, p.dx),
      vx: 0, vy: 0, sp: 0, spin: 0, boost: 0, shield: 0, off: false,
      ni: k, ps: p.s, total: p.s - track.len,
    };
  }

  function wrapAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  // Advance one car. inp = {up, down, left, right} or {up, down, steer:-1..1}
  function stepCar(c, inp, dt, track, capMul) {
    capMul = capMul || 1;
    const nr = nearest(track, c.x, c.y, c.ni);
    c.ni = nr.i;
    const p = track.pts[nr.i];
    c.off = nr.d > track.width / 2;

    let thr = inp.up ? 1 : 0, brk = inp.down ? 1 : 0;
    let st = inp.steer !== undefined ? inp.steer : (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    if (c.spin > 0) {
      c.spin -= dt; thr = 0; brk = 0; st = 0;
      c.a += 11 * dt * Math.min(1, c.spin + 0.3);
    }
    if (c.boost > 0) { c.boost -= dt; thr = 1; }
    if (c.shield > 0) c.shield -= dt;

    const fx = Math.cos(c.a), fy = Math.sin(c.a);
    let fwd = c.vx * fx + c.vy * fy;
    let lat = -c.vx * fy + c.vy * fx;
    let max = (c.boost > 0 ? PHYS.boostMax : PHYS.max) * capMul;
    if (c.off) max = Math.min(max, PHYS.offMax * (c.boost > 0 ? 1.5 : 1));

    if (thr) fwd += PHYS.accel * (c.boost > 0 ? 2 : 1) * dt;
    if (brk) fwd -= (fwd > 0 ? PHYS.brake : PHYS.accel * 0.6) * dt;
    if (!thr && !brk) fwd *= Math.exp(-0.9 * dt);
    if (c.spin > 0) fwd *= Math.exp(-2.5 * dt);
    if (fwd > max) fwd = Math.max(max, fwd - 1000 * dt);
    if (fwd < -PHYS.rev) fwd = -PHYS.rev;
    lat *= Math.exp(-PHYS.grip * dt);

    const sf = Math.min(1, Math.abs(fwd) / 180) * (fwd < 0 ? -1 : 1);
    c.a = wrapAngle(c.a + st * PHYS.turn * sf * dt);
    c.vx = fx * fwd - fy * lat;
    c.vy = fy * fwd + fx * lat;
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    c.sp = fwd;

    // Soft outer barrier so nobody drives off into the void
    const lim = track.width / 2 + 240;
    const ox = c.x - p.x, oy = c.y - p.y, od = Math.hypot(ox, oy);
    if (od > lim) {
      c.x = p.x + (ox / od) * lim; c.y = p.y + (oy / od) * lim;
      c.vx *= 0.4; c.vy *= 0.4;
    }

    let ds = p.s - c.ps;
    if (ds < -track.len / 2) ds += track.len;
    if (ds > track.len / 2) ds -= track.len;
    c.total += ds;
    c.ps = p.s;
  }

  function botInput(track, c, lane) {
    const look = Math.round(9 + Math.abs(c.sp) / 45);
    const p = track.pts[(c.ni + look) % track.N];
    const q = track.pts[(c.ni + look + 18) % track.N];
    const tx = p.x + p.nx * lane, ty = p.y + p.ny * lane;
    const d = wrapAngle(Math.atan2(ty - c.y, tx - c.x) - c.a);
    const bend = Math.abs(wrapAngle(Math.atan2(q.dy, q.dx) - Math.atan2(p.dy, p.dx)));
    const tooFast = c.sp > Math.max(230, 660 - bend * 420);
    return {
      up: !(tooFast || (Math.abs(d) > 0.8 && c.sp > 260)),
      down: (tooFast && c.sp > 380) || (Math.abs(d) > 1.3 && c.sp > 300),
      steer: Math.max(-1, Math.min(1, d * 3)),
    };
  }

  return { TRACKS, ITEMS, PHYS, BOX_RESPAWN_MS, buildTrack, nearest, makeCar, stepCar, botInput, wrapAngle };
});
