// Shared track + physics code, used by both the browser and the Node server.
// World units are "px" (about 15px = 1m). The car model is a bicycle model with
// slip-angle tyre forces, a friction circle on the driven rear axle, gears,
// handbrake, trackside walls, and impulse-based car-to-car collisions.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TRACKS = [
    {
      name: 'Canyon Loop', width: 180, theme: 'canyon',
      pts: [[0, 0], [1400, -200], [2400, 300], [2600, 1300], [1900, 1900], [2300, 2700],
            [1500, 3300], [400, 2900], [-200, 2000], [500, 1300], [-500, 700]],
      shortcuts: [
        { from: [2600, 1250], to: [2330, 2620], via: [[2660, 1950]] },
        { from: [-170, 1950], to: [-470, 780], via: [[-560, 1380]] },
      ],
      jumps: [2161, 6787],
    },
    {
      name: 'Harbor Hairpins', width: 170, theme: 'harbor',
      pts: [[0, 0], [1800, 0], [2600, 600], [2200, 1300], [1200, 1100], [900, 1700],
            [1900, 2300], [1500, 3000], [200, 2900], [-500, 2000], [-300, 900]],
      shortcuts: [
        { from: [1000, 1750], to: [1100, 2960], via: [[1150, 2250], [1000, 2650]], jump: 0.3 },
      ],
      jumps: [8287],
    },
    {
      name: 'Desert Dash', width: 190, theme: 'desert',
      pts: [[0, 0], [2200, -300], [3400, 400], [3000, 1500], [1800, 1300], [1300, 2200],
            [2400, 2900], [1200, 3600], [-300, 3000], [-800, 1500]],
      shortcuts: [
        { from: [2850, 1470], to: [2300, 2850], via: [[2600, 1850], [3000, 2200], [2600, 2550]], jump: 0.27 },
      ],
      jumps: [10347],
    },
  ];

  const ITEMS = ['boost', 'rocket', 'oil', 'shield'];
  const BOX_RESPAWN_MS = 4000;
  const CAR_HALF_W = 13;

  // Vehicle parameters (accelerations in px/s^2, speeds in px/s)
  const PHYS = {
    A: 15, B: 15, I: 800,            // CG to front/rear axle, yaw inertia factor
    engine: 640, vmax: 700,          // drive force, top speed
    boostV: 980, boostA: 950,
    brake: 1150, rev: 230,
    gripF: 1400, gripR: 1700,        // peak lateral grip per axle (rear-biased = stable)
    cF: 8000, cR: 11000,             // cornering stiffness
    maxSteer: 0.6,                   // full-lock angle (rad) at standstill
    steerIn: 3.8, steerOut: 8,       // steering ramp toward lock / back to centre (per s)
    steerFade: 260,                  // speed at which available lock halves
    tcUse: 0.4,                      // share of rear grip consumed by throttle
    slideGrip: 0.88,                 // grip kept once a tyre is sliding
    assist: 2.6,                     // stability assist strength (0 = off)
    roll: 45, aero: 0.00045,
    offGrip: 0.62, offV: 340, offRoll: 380,
    hand: 0.28,                      // rear grip multiplier on handbrake
    gears: [0, 160, 290, 410, 530, 640],
  };
  const GRAV = 520;                  // px/s^2 while airborne
  const RAMP = { len: 90, h: 26 };    // kicker ramp size
  const DIRT = { grip: 0.8, vmax: 540, roll: 70 };
  const LAT_G = 1080;                // cornering accel bots plan around

  function cr(a, b, c, d, t) {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  }
  function wrapAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

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
      p.ang = Math.atan2(p.dy, p.dx);
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    // signed curvature (positive = turning toward +n)
    const W = 6;
    for (let k = 0; k < N; k++) {
      const a = pts[(k - W + N) % N], b = pts[(k + W) % N];
      pts[k].curv = wrapAngle(b.ang - a.ang) / (2 * W * step);
    }
    // wall offsets: pulled in on the inside of tight corners
    const half = def.width / 2, wallBase = half + 130;
    const wp = new Array(N), wn = new Array(N);
    for (let k = 0; k < N; k++) {
      const c = pts[k].curv, R = Math.abs(c) > 1e-6 ? 1 / Math.abs(c) : 1e9;
      const inner = Math.max(half + 14, Math.min(wallBase, R * 0.8));
      wp[k] = c > 0 ? inner : wallBase;
      wn[k] = c < 0 ? inner : wallBase;
    }
    const minFilter = (arr, r) => arr.map((_, k) => {
      let m = Infinity;
      for (let o = -r; o <= r; o++) m = Math.min(m, arr[(k + o + N) % N]);
      return m;
    });
    const smooth = (arr, r) => arr.map((_, k) => {
      let s = 0;
      for (let o = -r; o <= r; o++) s += arr[(k + o + N) % N];
      return s / (2 * r + 1);
    });
    const WP = smooth(minFilter(wp, 14), 8), WN = smooth(minFilter(wn, 14), 8);
    for (let k = 0; k < N; k++) { pts[k].wp = WP[k]; pts[k].wn = WN[k]; }
    // safe cornering speed for bots
    for (let k = 0; k < N; k++) {
      let mc = 0;
      for (let o = -3; o <= 3; o++) mc = Math.max(mc, Math.abs(pts[(k + o + N) % N].curv));
      pts[k].vmax = Math.min(PHYS.vmax, Math.sqrt(LAT_G / Math.max(mc, 1e-5)));
    }
    const boxes = [];
    [0.16, 0.41, 0.66, 0.88].forEach((f, gi) => {
      const p = pts[Math.floor(f * N)];
      [-1, 0, 1].forEach((o, bi) => boxes.push({
        id: gi * 3 + bi, x: p.x + p.nx * o * def.width * 0.27, y: p.y + p.ny * o * def.width * 0.27,
      }));
    });
    const t = { idx: i, name: def.name, width: def.width, theme: def.theme,
      pts, N, len, step, boxes, bounds: { minX, minY, maxX, maxY } };
    const main = { id: 0, closed: true, pts, N, half, width: def.width, kind: 'asphalt' };
    t.roads = [main];
    (def.shortcuts || []).forEach(sc => t.roads.push(buildBranch(t, sc, t.roads.length)));
    for (const R of t.roads) for (const q of R.pts) {
      minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y);
    }
    t.bounds = { minX, minY, maxX, maxY };
    // jump ramps: on the main road at fixed distances, and part-way along some shortcuts
    t.ramps = [];
    const addRamp = (R, k) => {
      const q = R.pts[k];
      t.ramps.push({ road: R.id, k, x: q.x, y: q.y, dx: q.dx, dy: q.dy, nx: q.nx, ny: q.ny, ang: q.ang,
        len: RAMP.len, h: RAMP.h, w: R.width + 8 });
    };
    (def.jumps || []).forEach(sj => addRamp(main, Math.round(sj / step) % N));
    (def.shortcuts || []).forEach((sc, j) => { if (sc.jump) { const R = t.roads[j + 1]; addRamp(R, Math.round(sc.jump * (R.N - 1))); } });
    cache[i] = t;
    return t;
  }

  // A shortcut: an open dirt road leaving the main loop at one point and rejoining further on.
  function buildBranch(t, sc, id) {
    const M = t.pts, N = t.N;
    const k1 = nearest(t, sc.from[0], sc.from[1]).i, k2 = nearest(t, sc.to[0], sc.to[1]).i;
    const ctrl = [[M[(k1 - 4 + N) % N].x, M[(k1 - 4 + N) % N].y], [M[k1].x, M[k1].y], ...sc.via,
      [M[k2].x, M[k2].y], [M[(k2 + 4) % N].x, M[(k2 + 4) % N].y]];
    const dense = [];
    for (let j = 1; j < ctrl.length - 2; j++) for (let q = 0; q < 30; q++) {
      const u = q / 30;
      dense.push([cr(ctrl[j - 1][0], ctrl[j][0], ctrl[j + 1][0], ctrl[j + 2][0], u), cr(ctrl[j - 1][1], ctrl[j][1], ctrl[j + 1][1], ctrl[j + 2][1], u)]);
    }
    dense.push([M[k2].x, M[k2].y]);
    const cum = [0];
    for (let j = 1; j < dense.length; j++) cum.push(cum[j - 1] + Math.hypot(dense[j][0] - dense[j - 1][0], dense[j][1] - dense[j - 1][1]));
    const blen = cum[cum.length - 1], n = Math.max(4, Math.round(blen / t.step) + 1), pts = [];
    let j = 0;
    for (let k = 0; k < n; k++) {
      const d = (k / (n - 1)) * blen;
      while (j < cum.length - 2 && cum[j + 1] < d) j++;
      const a = dense[j], b = dense[j + 1], f = (d - cum[j]) / (cum[j + 1] - cum[j] || 1);
      pts.push({ x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f });
    }
    const half = 58, s1 = M[k1].s, span = (M[k2].s - s1 + t.len) % t.len;
    for (let k = 0; k < n; k++) {
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n - 1, k + 1)], q = pts[k];
      const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
      q.dx = dx / l; q.dy = dy / l; q.nx = -dy / l; q.ny = dx / l; q.ang = Math.atan2(q.dy, q.dx);
      q.s = (s1 + (span * k) / (n - 1)) % t.len;
      q.wp = q.wn = half + 42;
    }
    for (let k = 0; k < n; k++) {
      const a = pts[Math.max(0, k - 4)], b = pts[Math.min(n - 1, k + 4)];
      pts[k].curv = wrapAngle(b.ang - a.ang) / (Math.max(1, Math.min(n - 1, k + 4) - Math.max(0, k - 4)) * t.step);
    }
    for (let k = 0; k < n; k++) {
      let mc = 0;
      for (let o = -3; o <= 3; o++) mc = Math.max(mc, Math.abs(pts[clamp(k + o, 0, n - 1)].curv));
      pts[k].vmax = Math.min(DIRT.vmax, Math.sqrt((LAT_G * DIRT.grip * 0.95) / Math.max(mc, 1e-5)));
    }
    return { id, closed: false, pts, N: n, half, width: half * 2, kind: 'dirt', k1, k2, len: blen };
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

  function nearestOn(R, x, y, hint) {
    const pts = R.pts, N = R.N;
    let best = -1, bd = Infinity;
    if (hint === undefined || hint < 0 || hint >= N) {
      for (let k = 0; k < N; k++) {
        const d = (pts[k].x - x) ** 2 + (pts[k].y - y) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
    } else {
      for (let o = -40; o <= 40; o++) {
        let k = hint + o;
        if (R.closed) k = (k + N) % N; else if (k < 0 || k >= N) continue;
        const d = (pts[k].x - x) ** 2 + (pts[k].y - y) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
    }
    return { i: best, d: Math.sqrt(bd) };
  }
  // is (x,y) past the open end of a branch?
  function pastEnd(R, i, x, y) {
    if (R.closed) return false;
    const p = R.pts[i], along = (x - p.x) * p.dx + (y - p.y) * p.dy;
    return (i === 0 && along < 0) || (i === R.N - 1 && along > 0);
  }

  // Find the nearest point on every nearby road and decide which road the car is on.
  function locate(track, c) {
    const roads = track.roads, M = roads[0];
    let nm = nearestOn(M, c.x, c.y, c.mi);
    if (nm.d > M.half * 3) nm = nearestOn(M, c.x, c.y);
    c.mi = nm.i;
    const cand = [{ r: 0, i: nm.i }];
    for (let r = 1; r < roads.length; r++) {
      const R = roads[r], nb = nearestOn(R, c.x, c.y, c.road === r ? c.ni : undefined);
      if (nb.d < R.half + 260) cand.push({ r, i: nb.i });
    }
    c.cand = cand;
    let best = cand[0], bestScore = Infinity;
    for (const cd of cand) {
      const R = roads[cd.r], p = R.pts[cd.i];
      if (pastEnd(R, cd.i, c.x, c.y)) continue;
      const lat = Math.abs((c.x - p.x) * p.nx + (c.y - p.y) * p.ny) / R.half;
      const score = lat - ((c.road || 0) === cd.r ? 0.35 : 0) - (c.plan === cd.r ? 0.5 : 0);
      if (score < bestScore) { bestScore = score; best = cd; }
    }
    c.road = best.r; c.ni = best.i;
  }

  // Union of all roads' wall envelopes: are we on a road surface, and are we through a wall?
  function envelope(track, c) {
    let onRoad = false, kind = null, ratioBest = Infinity, inside = false, wall = null, violBest = Infinity;
    for (const cd of c.cand) {
      const R = track.roads[cd.r], p = R.pts[cd.i];
      if (pastEnd(R, cd.i, c.x, c.y)) continue;
      const lat = (c.x - p.x) * p.nx + (c.y - p.y) * p.ny;
      const ratio = Math.abs(lat) / R.half;
      if (ratio <= 1 && ratio < ratioBest) { ratioBest = ratio; kind = R.kind; onRoad = true; }
      const limP = p.wp - CAR_HALF_W, limN = -(p.wn - CAR_HALF_W);
      if (lat <= limP && lat >= limN) inside = true;
      else {
        const viol = lat > limP ? lat - limP : limN - lat;
        if (viol < violBest) { violBest = viol; wall = { p, side: lat > limP ? 1 : -1, pen: viol }; }
      }
    }
    return { onRoad, kind, wall: inside ? null : wall };
  }

  // Height of the ground (ramps) under a point.
  function groundAt(track, x, y) {
    for (const r of track.ramps) {
      const ox = x - r.x, oy = y - r.y, along = ox * r.dx + oy * r.dy;
      if (along < 0 || along > r.len) continue;
      if (Math.abs(ox * r.nx + oy * r.ny) > r.w / 2) continue;
      return { h: (r.h * along) / r.len, ramp: r };
    }
    return { h: 0, ramp: null };
  }

  // Clearance from the nearest road's walls (negative = inside a road corridor). For scenery/terrain.
  function clearance(track, x, y) {
    let best = Infinity;
    for (const R of track.roads) {
      const n = nearestOn(R, x, y);
      if (pastEnd(R, n.i, x, y)) continue;
      const p = R.pts[n.i];
      best = Math.min(best, n.d - Math.max(p.wp, p.wn));
    }
    return best;
  }

  const roadPoint = (track, c) => track.roads[c.road || 0].pts[c.ni];

  function makeCar(track, slot) {
    const row = Math.floor(slot / 2), col = slot % 2;
    const k = (track.N - 6 - row * 6 + track.N * 2) % track.N;
    const p = track.pts[k], lat = (col ? 1 : -1) * track.width * 0.22;
    return {
      x: p.x + p.nx * lat, y: p.y + p.ny * lat, a: p.ang,
      vx: 0, vy: 0, w: 0, sp: 0, lat: 0, steer: 0,
      spin: 0, boost: 0, shield: 0, off: false,
      gear: 1, rpm: 900, shiftT: 0, slip: 0, crash: 0, braking: false,
      ni: k, ps: p.s, total: p.s - track.len, stuck: 0, rev: 0,
      road: 0, mi: k, z: 0, vz: 0, plan: -1, planFor: -1, surf: 'asphalt',
    };
  }

  // Airborne: no tyre forces. Steering spins the car (tricks), throttle just revs the engine.
  function airStep(c, inp, h, track, steerT, thr) {
    c.airT += h;
    const target = c.spin > 0 ? c.w : steerT * 7.5;
    c.w += clamp(target - c.w, -32 * h, 32 * h);
    c.airRot += c.w * h;
    c.a = wrapAngle(c.a + c.w * h);
    c.vx *= 1 - 0.04 * h; c.vy *= 1 - 0.04 * h;
    c.vz -= GRAV * h;
    c.x += c.vx * h; c.y += c.vy * h; c.z += c.vz * h;
    c.rpm += ((thr ? 7600 : 1500) - c.rpm) * Math.min(1, h * 4);
    c.slip = 0;
    const fx = Math.cos(c.a), fy = Math.sin(c.a);
    c.sp = c.vx * fx + c.vy * fy; c.lat = -c.vx * fy + c.vy * fx;
    walls(c, track, h);
    const g = groundAt(track, c.x, c.y);
    if (c.z <= g.h) { c.z = g.h; land(c); }
  }

  function land(c) {
    const impact = -c.vz, spd = Math.hypot(c.vx, c.vy), vh = Math.atan2(c.vy, c.vx);
    const diff = Math.abs(wrapAngle(c.a - vh));
    const spins = Math.floor((Math.abs(c.airRot) + 0.7) / (Math.PI * 2));
    c.vz = 0; c.inAir = false;
    c.landImpact = impact;
    if (c.airT < 0.3) { c.w *= 0.3; return; } // small hop
    if (spd < 60 || diff < 0.6) {
      // clean landing: tyres bite, car straightens, earn turbo for air time and spins
      c.a = spd < 60 ? c.a : vh; c.w = 0;
      const bonus = (c.airT > 0.5 ? 0.5 : 0.25) + spins * 0.8;
      c.boost = Math.min(3, Math.max(0, c.boost) + bonus);
      c.stunt = { kind: 'clean', air: +c.airT.toFixed(2), spins, bonus };
    } else if (diff < 1.15) {
      c.vx *= 0.7; c.vy *= 0.7; c.a = wrapAngle(vh + Math.sign(wrapAngle(c.a - vh)) * 0.3); c.w *= 0.2;
      c.stunt = { kind: 'rough', air: +c.airT.toFixed(2), spins: 0, bonus: 0 };
    } else {
      // landed sideways or backwards: crash and spin out, ending pointed the way we're travelling
      c.vx *= 0.4; c.vy *= 0.4;
      c.spin = 1.0; c.spin0 = vh; c.spinDir = Math.sign(c.w || 1); c.spinDur = 1.0;
      c.stunt = { kind: 'crash', air: +c.airT.toFixed(2), spins: 0, bonus: 0 };
    }
  }

  // Wall response against the union of road corridors.
  function walls(c, track, h) {
    const env = envelope(track, c);
    c.off = !env.onRoad; c.surf = env.kind || 'grass';
    if (!env.wall) return;
    const { p, side, pen } = env.wall;
    c.x -= p.nx * pen * side; c.y -= p.ny * pen * side;
    const vn = (c.vx * p.nx + c.vy * p.ny) * side;
    if (c.inAir) {
      // airborne: the barrier guides the car along instead of bouncing it, and the
      // body turns with the velocity so a straight jump still lands straight
      if (vn > 0) {
        const before = Math.atan2(c.vy, c.vx);
        c.vx -= p.nx * side * vn; c.vy -= p.ny * side * vn;
        c.vx *= 0.97; c.vy *= 0.97;
        c.a = wrapAngle(c.a + wrapAngle(Math.atan2(c.vy, c.vx) - before));
        c.wallN = { nx: p.nx * side, ny: p.ny * side };
        if (vn > 150) c.crash = Math.max(c.crash, vn * 0.5);
      }
      return;
    }
    if (vn > 0) {
      c.vx -= p.nx * side * vn * 1.35; c.vy -= p.ny * side * vn * 1.35;
      const tx = p.dx, ty = p.dy, vt = c.vx * tx + c.vy * ty;
      const scrub = Math.min(1, vn / 900) * 0.5 + 0.04;
      c.vx -= tx * vt * scrub; c.vy -= ty * vt * scrub;
      c.w += -side * vn * 0.0025 * Math.sign(vt || 1);
      c.crash = Math.max(c.crash, vn);
      c.wallN = { nx: p.nx * side, ny: p.ny * side };
    }
    // scrape-and-align: if the car is pointed into the wall, swing it to run along it
    if (c.spin <= 0 && !(c.z > 0.5)) {
      const dirSign = c.sp < -5 ? -1 : 1;
      const headInto = (Math.cos(c.a) * p.nx + Math.sin(c.a) * p.ny) * side * dirSign;
      if (headInto > 0.05) {
        let dA = wrapAngle(p.ang - c.a);
        if (Math.abs(dA) > 1.75) dA = wrapAngle(dA + Math.PI);
        const rate = (2.4 + Math.abs(c.sp) / 140) * h;
        c.a = wrapAngle(c.a + clamp(dA, -rate, rate));
        c.w *= 0.85;
      }
    }
    c.wallT = 0.25;
  }

  function substep(c, inp, h, track, capMul) {
    let thr = inp.up ? 1 : 0, brk = inp.down ? 1 : 0, hand = inp.hand ? 1 : 0;
    let steerT = inp.steer !== undefined ? inp.steer : (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    let gs = 1;
    if (c.spin > 0) { thr = 0; brk = 0; hand = 0; steerT = 0; gs = 0.22; }
    const boosting = c.boost > 0;
    // turbo adds power only while you are on the gas, so you can still brake for corners

    // steering wheel: slower turn-in, quicker self-centring
    const toward = Math.abs(steerT) > Math.abs(c.steer) && Math.sign(steerT) === Math.sign(c.steer || steerT);
    const rate = (toward ? PHYS.steerIn : PHYS.steerOut) * h;
    c.steer += clamp(steerT - c.steer, -rate, rate);

    // ramps & air
    const gnd = groundAt(track, c.x, c.y);
    // just rolled off the lip of a ramp: launch
    if (c.onRamp && !gnd.ramp && !c.inAir) {
      const r = c.onRamp, vAlong = c.vx * r.dx + c.vy * r.dy;
      c.onRamp = null;
      if (vAlong > 120 && c.z > r.h * 0.6) c.vz = (vAlong * r.h) / r.len * 0.85 + 30;
      c.inAir = true; c.airT = 0; c.airRot = 0; c.stunt = null;
    }
    if (c.inAir || c.vz > 0 || c.z > gnd.h + 0.5) {
      if (!c.inAir) { c.inAir = true; c.airT = 0; c.airRot = 0; c.stunt = null; }
      airStep(c, inp, h, track, steerT, thr);
      return;
    }
    c.inAir = false;
    let slope = 0;
    if (gnd.ramp) { c.z = gnd.h; c.onRamp = gnd.ramp; slope = gnd.ramp.h / gnd.ramp.len; }
    else { c.z = 0; c.onRamp = null; }

    const fx = Math.cos(c.a), fy = Math.sin(c.a);
    let u = c.vx * fx + c.vy * fy;
    let v = -c.vx * fy + c.vy * fx;
    let w = c.w;

    if (c.off) gs *= PHYS.offGrip;
    else if (c.surf === 'dirt') gs *= DIRT.grip;

    let vmax = (boosting ? PHYS.boostV : PHYS.vmax) * capMul;
    if (c.off) vmax = Math.min(vmax, PHYS.offV * (boosting ? 1.4 : 1));
    else if (c.surf === 'dirt') vmax = Math.min(vmax, DIRT.vmax * (boosting ? 1.3 : 1));

    // gearbox (cosmetic + brief torque cut on upshift)
    const G = PHYS.gears, au = Math.abs(u);
    let g = c.gear;
    if (g < 6 && au > G[g]) { g++; if (u > 0) c.shiftT = 0.12; }
    else if (g > 1 && au < G[g - 1] - 40) g--;
    c.gear = g;
    c.shiftT = Math.max(0, c.shiftT - h);
    const lo = g > 1 ? G[g - 1] - 40 : 0, hi = G[g] || PHYS.vmax * 1.05;
    c.rpm = 1100 + 6200 * clamp((Math.abs(u) - lo) / (hi - lo + 1), 0, 1.05);

    // longitudinal force
    let drive = 0;
    if (thr) {
      if (u > -15) {
        const t = clamp(1 - Math.pow(Math.max(0, u) / vmax, 3), 0, 1);
        drive = (PHYS.engine * (1.15 - 0.05 * g) * t + (boosting ? PHYS.boostA : 0)) * (c.shiftT > 0 ? 0.35 : 1);
        if (u > vmax) drive = -PHYS.offRoll * 0.8;
      } else drive = PHYS.brake;
    }
    if (brk) {
      if (u > 15) drive -= PHYS.brake;
      else if (u > -PHYS.rev) drive -= PHYS.engine * 0.55;
    }
    c.braking = brk && u > 15;
    const resist = (c.off ? PHYS.offRoll : c.surf === 'dirt' ? DIRT.roll : PHYS.roll) + PHYS.aero * u * u;
    let lon = drive - Math.sign(u) * Math.min(Math.abs(u) / h, resist);
    if (hand && Math.abs(u) > 5) lon -= Math.sign(u) * 260;
    if (slope) lon -= GRAV * slope * 0.6; // climbing the ramp
    if (c.spin > 0) lon -= Math.sign(u) * 500;

    // tyre forces with friction circle on rear (driven) axle
    const speedSteer = PHYS.maxSteer / (1 + Math.abs(u) / PHYS.steerFade);
    const delta = c.steer * speedSteer;
    const gF = PHYS.gripF * gs;
    let gR = PHYS.gripR * gs * (hand ? PHYS.hand : 1);
    const used = Math.min(Math.abs(drive) * PHYS.tcUse, gR * 0.98);
    const gRlat = Math.sqrt(Math.max(0, gR * gR - used * used));
    const uu = Math.max(Math.abs(u), 45), su = u < 0 ? -1 : 1;
    const af = Math.atan2(v + w * PHYS.A, uu) - delta * su;
    const ar = Math.atan2(v - w * PHYS.B, uu);
    // past the peak slip angle tyres slide and lose ~25% grip (lets drifts hold)
    const sg = PHYS.slideGrip;
    const slide = x => (Math.abs(x) > 0.2 ? sg + (1 - sg) * Math.max(0, 1 - (Math.abs(x) - 0.2) * 5) : 1);
    const Ff = clamp(-PHYS.cF * af, -gF * slide(af), gF * slide(af));
    const Fr = clamp(-PHYS.cR * ar, -gRlat * slide(ar), gRlat * slide(ar));
    c.slip = Math.abs(ar) * (Math.abs(u) > 80 ? 1 : Math.abs(u) / 80);

    u += (lon - Ff * Math.sin(delta) + w * v) * h;
    v += (Ff * Math.cos(delta) + Fr - w * u) * h;
    w += ((Ff * Math.cos(delta) * PHYS.A - Fr * PHYS.B) / PHYS.I) * h;

    // stability assist: when the rear steps out (and you're not on the handbrake),
    // bleed off yaw beyond what the steering asks for, like a mild ESC
    if (PHYS.assist > 0 && !hand && c.spin <= 0 && u > 60) {
      const wk = (u * Math.tan(delta)) / (PHYS.A + PHYS.B);
      const excess = w - wk;
      const k = clamp((Math.abs(ar) - 0.05) * 10, 0, 1);
      if (k > 0 && Math.sign(excess) === Math.sign(w)) {
        w -= excess * Math.min(1, PHYS.assist * k * h * 4);
        v *= 1 - Math.min(0.5, PHYS.assist * k * h);
      }
    }

    // low speed and reversing: blend toward kinematic steering for stable handling
    const spd = Math.hypot(u, v);
    let k = spd < 70 ? 1 - spd / 70 : 0;
    if (u < -20 && brk && Math.abs(v) < Math.abs(u)) k = 1;
    if (k > 0) {
      // pressing gas/reverse at a standstill still lets you pivot slowly (wheels scrub round)
      const pivot = thr ? 60 : brk ? -60 : 0;
      const ue = Math.abs(u) < Math.abs(pivot) ? pivot : u;
      const wk = (ue * Math.tan(delta)) / (PHYS.A + PHYS.B);
      w = w * (1 - k) + wk * k;
      v *= 1 - k * 8 * h;
    }
    if (!thr && !brk && Math.abs(u) < 4) u = 0;
    if (c.spin > 0 && c.spinDur) w = (c.spinDir * Math.PI * 2) / c.spinDur;

    c.a = wrapAngle(c.a + w * h);
    c.w = w;
    c.vx = fx * u - fy * v;
    c.vy = fy * u + fx * v;
    c.x += c.vx * h;
    c.y += c.vy * h;
    c.sp = u; c.lat = v;

    walls(c, track, h);
  }

  // Advance one car. inp = {up, down, left, right, hand} or {up, down, steer:-1..1, hand}
  function stepCar(c, inp, dt, track, capMul) {
    capMul = capMul || 1;
    if (c.spin > 0 && c.spin0 === undefined) { c.spin0 = c.a; c.spinDir = Math.sign(c.w || 1); c.spinDur = c.spin; }
    if (c.spin > 0) c.spin -= dt;
    if (c.wallT > 0) c.wallT -= dt;
    if (c.ghost > 0) c.ghost -= dt;
    if (c.boost > 0) c.boost -= dt;
    if (c.shield > 0) c.shield -= dt;
    locate(track, c);
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    for (let i = 0; i < n; i++) substep(c, inp, dt / n, track, capMul);
    if (c.spin <= 0 && c.spin0 !== undefined) {
      // spin finished: settle facing the way we were going
      c.a = c.spin0; c.w = 0; c.spin0 = undefined; c.spinDur = 0;
      const sp = Math.hypot(c.vx, c.vy);
      c.vx = Math.cos(c.a) * sp; c.vy = Math.sin(c.a) * sp;
    }
    const p = roadPoint(track, c);
    let ds = p.s - c.ps;
    if (ds < -track.len / 2) ds += track.len;
    if (ds > track.len / 2) ds -= track.len;
    c.total += ds;
    c.ps = p.s;
  }

  // Put a car back on the racing line, facing the right way (the "reset" button).
  function resetCar(track, c) {
    const R = track.roads[c.road || 0];
    const k = R.closed ? (c.ni - 3 + R.N) % R.N : Math.max(0, c.ni - 3), p = R.pts[k];
    c.x = p.x; c.y = p.y; c.a = p.ang;
    c.vx = c.vy = c.w = c.sp = c.lat = c.steer = 0;
    c.spin = 0; c.spin0 = undefined; c.boost = 0; c.gear = 1;
    c.z = 0; c.vz = 0; c.onRamp = null;
    c.ni = k; c.ghost = 1.5; c.stuck = 0; c.rev = 0;
    let ds = p.s - c.ps;
    if (ds < -track.len / 2) ds += track.len;
    if (ds > track.len / 2) ds -= track.len;
    c.total += ds; c.ps = p.s;
  }

  // Car-to-car impulse. Moves only the cars flagged movable. Returns impact speed.
  function collide(a, b, moveA, moveB) {
    if (a.ghost > 0 || b.ghost > 0) return 0;
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), R = 32;
    if (d >= R || d === 0) return 0;
    const nx = dx / d, ny = dy / d, pen = R - d;
    const share = moveA && moveB ? 0.5 : 1;
    if (moveA) { a.x -= nx * pen * share; a.y -= ny * pen * share; }
    if (moveB) { b.x += nx * pen * share; b.y += ny * pen * share; }
    const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (rel >= 0) return 0;
    const j = (-(1 + 0.35) * rel) / 2;
    // contact point offset along each car's heading gives a yaw kick
    const kick = (car, sgn) => {
      const side = Math.cos(car.a) * ny - Math.sin(car.a) * nx;
      car.w = (car.w || 0) + sgn * side * j * 0.004;
    };
    if (moveA) { a.vx -= nx * j; a.vy -= ny * j; kick(a, -1); a.crash = Math.max(a.crash || 0, -rel); }
    if (moveB) { b.vx += nx * j; b.vy += ny * j; kick(b, 1); b.crash = Math.max(b.crash || 0, -rel); }
    return -rel;
  }

  // AI: pure-pursuit steering + braking for the slowest corner within braking distance.
  // Walk `dist` px ahead along the car's route (following its shortcut plan).
  function walk(track, c, dist) {
    const roads = track.roads;
    let r = c.road || 0, i = c.ni, steps = Math.max(0, Math.round(dist / track.step));
    // on a branch we didn't choose (just brushing past the fork)? keep following the main road
    if (r > 0 && c.plan !== r && c.mi !== undefined) { r = 0; i = c.mi; }
    for (let guard = 0; guard < 4; guard++) {
      const R = roads[r];
      if (R.closed) {
        if (c.plan > 0) {
          const B = roads[c.plan], to = (B.k1 - i + R.N) % R.N;
          if (to <= steps || to > R.N - 12) {
            const into = to > R.N - 12 ? R.N - to : 0; // already slightly past the fork
            steps -= to > R.N - 12 ? 0 : to; r = c.plan; i = Math.min(B.N - 1, into); continue;
          }
        }
        return R.pts[(i + steps) % R.N];
      }
      const left = R.N - 1 - i;
      if (steps <= left) return R.pts[i + steps];
      steps -= left; r = 0; i = R.k2;
    }
    return roads[r].pts[i];
  }

  // Decide (once per approach) whether to take the next shortcut.
  function botPlan(track, c) {
    if ((c.road || 0) !== 0) return;
    const M = track.roads[0];
    let next = -1, dist = Infinity;
    for (let r = 1; r < track.roads.length; r++) {
      const to = (track.roads[r].k1 - c.ni + M.N) % M.N;
      if (to < dist) { dist = to; next = r; }
    }
    if (next < 0) return;
    if (dist < 70) {
      if (c.planFor !== next) { c.planFor = next; c.plan = Math.random() < (c.scChance ?? 0.55) ? next : -1; }
    } else if (dist < M.N - 20) { c.planFor = -1; c.plan = -1; }
  }

  function botInput(track, c, lane, skill) {
    skill = skill || 1;
    const u = c.sp;
    if (c.inAir) return { up: true, down: false, steer: 0 }; // airborne: keep it straight
    if (c.rev > 0) return { up: false, down: true, steer: -Math.sign(c.revSteer || 1) };
    botPlan(track, c);
    const ld = 80 + Math.abs(u) * 0.38;
    let p = walk(track, c, ld);
    // approaching a jump: aim at where the road will be on landing, not at the ramp
    for (const r of track.ramps) {
      const ox = r.x - c.x, oy = r.y - c.y, d = Math.hypot(ox, oy);
      if (d < 260 && ox * Math.cos(c.a) + oy * Math.sin(c.a) > 0 && (r.road === 0 || r.road === c.road || r.road === c.plan)) {
        // predicted flight distance from the launch speed (same formula as the launch)
        const vz = (Math.max(200, u) * r.h) / r.len * 0.85 + 30;
        const tAir = (vz + Math.sqrt(vz * vz + 2 * GRAV * r.h)) / GRAV;
        const R = track.roads[r.road], flight = r.len + Math.max(200, u) * tAir;
        const k = R.closed ? (r.k + Math.round(flight / track.step)) % R.N : Math.min(R.N - 1, r.k + Math.round(flight / track.step));
        p = R.pts[k]; lane = 0;
        break;
      }
    }
    const ln = clamp(lane, -(p.wn - 40), p.wp - 40);
    const tx = p.x + p.nx * ln, ty = p.y + p.ny * ln;
    const alpha = wrapAngle(Math.atan2(ty - c.y, tx - c.x) - c.a);
    const need = Math.atan((2 * (PHYS.A + PHYS.B) * Math.sin(alpha)) / ld);
    const steerMax = PHYS.maxSteer / (1 + Math.abs(u) / PHYS.steerFade);
    let steer = clamp(need / steerMax, -1, 1);
    // countersteer when the rear steps out
    steer = clamp(steer - (c.lat || 0) * 0.004, -1, 1);
    const bd = (u * u) / (2 * PHYS.brake * 0.7) + 40;
    let vt = Infinity;
    for (let o = 0; o * track.step < bd + 60; o += 2) {
      const dist = o * track.step;
      const q = walk(track, c, dist);
      const qv = q.vmax * skill;
      vt = Math.min(vt, Math.sqrt(qv * qv + 2 * PHYS.brake * 0.7 * Math.max(0, dist - 40)));
    }
    const lost = Math.abs(alpha) > 1.3;
    return {
      up: u < vt - 10 && !(lost && u > 140),
      down: u > vt + 25 || (lost && u > 200),
      steer,
    };
  }

  // Call once per AI tick: detects being stuck against a wall and backs out.
  function botRecover(c, dt, track) {
    if (c.rev > 0) { c.rev -= dt; return; }
    if (Math.abs(c.sp) < 30 && c.spin <= 0) c.stuck += dt; else { c.stuck = 0; if (c.sp > 200) c.tries = 0; }
    if (c.stuck > 1.2) {
      c.tries = (c.tries || 0) + 1; c.stuck = 0;
      if (c.tries > 2 && track) { resetCar(track, c); c.tries = 0; }
      else { c.rev = 0.9; c.revSteer = c.steer || 1; }
    }
  }

  return { TRACKS, ITEMS, PHYS, BOX_RESPAWN_MS, buildTrack, nearest, nearestOn, makeCar, stepCar, collide, resetCar,
    locate, envelope, groundAt, clearance, roadPoint,
    botInput, botRecover, wrapAngle };
});
