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
    },
    {
      name: 'Harbor Hairpins', width: 170, theme: 'harbor',
      pts: [[0, 0], [1800, 0], [2600, 600], [2200, 1300], [1200, 1100], [900, 1700],
            [1900, 2300], [1500, 3000], [200, 2900], [-500, 2000], [-300, 900]],
    },
    {
      name: 'Desert Dash', width: 190, theme: 'desert',
      pts: [[0, 0], [2200, -300], [3400, 400], [3000, 1500], [1800, 1300], [1300, 2200],
            [2400, 2900], [1200, 3600], [-300, 3000], [-800, 1500]],
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
      x: p.x + p.nx * lat, y: p.y + p.ny * lat, a: p.ang,
      vx: 0, vy: 0, w: 0, sp: 0, lat: 0, steer: 0,
      spin: 0, boost: 0, shield: 0, off: false,
      gear: 1, rpm: 900, shiftT: 0, slip: 0, crash: 0, braking: false,
      ni: k, ps: p.s, total: p.s - track.len, stuck: 0, rev: 0,
    };
  }

  function substep(c, inp, h, track, capMul) {
    const p = track.pts[c.ni];
    let thr = inp.up ? 1 : 0, brk = inp.down ? 1 : 0, hand = inp.hand ? 1 : 0;
    let steerT = inp.steer !== undefined ? inp.steer : (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    let gs = 1;
    if (c.spin > 0) { thr = 0; brk = 0; hand = 0; steerT = 0; gs = 0.22; }
    const boosting = c.boost > 0;
    if (boosting) thr = 1;

    // steering wheel: slower turn-in, quicker self-centring
    const toward = Math.abs(steerT) > Math.abs(c.steer) && Math.sign(steerT) === Math.sign(c.steer || steerT);
    const rate = (toward ? PHYS.steerIn : PHYS.steerOut) * h;
    c.steer += clamp(steerT - c.steer, -rate, rate);

    const fx = Math.cos(c.a), fy = Math.sin(c.a);
    let u = c.vx * fx + c.vy * fy;
    let v = -c.vx * fy + c.vy * fx;
    let w = c.w;

    const latOff = (c.x - p.x) * p.nx + (c.y - p.y) * p.ny;
    c.off = Math.abs(latOff) > track.width / 2;
    if (c.off) gs *= PHYS.offGrip;

    let vmax = (boosting ? PHYS.boostV : PHYS.vmax) * capMul;
    if (c.off) vmax = Math.min(vmax, PHYS.offV * (boosting ? 1.4 : 1));

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
    const resist = (c.off ? PHYS.offRoll : PHYS.roll) + PHYS.aero * u * u;
    let lon = drive - Math.sign(u) * Math.min(Math.abs(u) / h, resist);
    if (hand && Math.abs(u) > 5) lon -= Math.sign(u) * 260;
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

    // trackside walls
    const off2 = (c.x - p.x) * p.nx + (c.y - p.y) * p.ny;
    const limP = p.wp - CAR_HALF_W, limN = -(p.wn - CAR_HALF_W);
    if (off2 > limP || off2 < limN) {
      const side = off2 > limP ? 1 : -1;
      const pen = side > 0 ? off2 - limP : limN - off2;
      c.x -= p.nx * pen * side; c.y -= p.ny * pen * side;
      const vn = (c.vx * p.nx + c.vy * p.ny) * side;
      if (vn > 0) {
        c.vx -= p.nx * side * vn * 1.35; c.vy -= p.ny * side * vn * 1.35;
        const tx = p.dx, ty = p.dy, vt = c.vx * tx + c.vy * ty;
        const scrub = Math.min(1, vn / 900) * 0.5 + 0.04;
        c.vx -= tx * vt * scrub; c.vy -= ty * vt * scrub;
        c.w += -side * vn * 0.0025 * Math.sign(vt || 1);
        c.crash = Math.max(c.crash, vn);
      }
      // scrape-and-align: if the car is pointed into the wall, swing it to run along it
      if (c.spin <= 0) {
        const dirSign = c.sp < -5 ? -1 : 1;
        const headInto = (Math.cos(c.a) * p.nx + Math.sin(c.a) * p.ny) * side * dirSign;
        if (headInto > 0.05) {
          let dA = wrapAngle(p.ang - c.a);
          if (Math.abs(dA) > 1.75) dA = wrapAngle(dA + Math.PI); // align with whichever direction is closer
          const rate = (2.4 + Math.abs(c.sp) / 140) * h;
          c.a = wrapAngle(c.a + clamp(dA, -rate, rate));
          c.w *= 0.85;
        }
      }
      c.wallT = 0.25;
    }
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
    const nr = nearest(track, c.x, c.y, c.ni);
    c.ni = nr.i;
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    for (let i = 0; i < n; i++) substep(c, inp, dt / n, track, capMul);
    if (c.spin <= 0 && c.spin0 !== undefined) {
      // spin finished: settle facing the way we were going
      c.a = c.spin0; c.w = 0; c.spin0 = undefined; c.spinDur = 0;
      const sp = Math.hypot(c.vx, c.vy);
      c.vx = Math.cos(c.a) * sp; c.vy = Math.sin(c.a) * sp;
    }
    const p = track.pts[c.ni];
    let ds = p.s - c.ps;
    if (ds < -track.len / 2) ds += track.len;
    if (ds > track.len / 2) ds -= track.len;
    c.total += ds;
    c.ps = p.s;
  }

  // Put a car back on the racing line, facing the right way (the "reset" button).
  function resetCar(track, c) {
    const k = (c.ni - 3 + track.N) % track.N, p = track.pts[k];
    c.x = p.x; c.y = p.y; c.a = p.ang;
    c.vx = c.vy = c.w = c.sp = c.lat = c.steer = 0;
    c.spin = 0; c.spin0 = undefined; c.boost = 0; c.gear = 1;
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
  function botInput(track, c, lane, skill) {
    skill = skill || 1;
    const pts = track.pts, N = track.N, u = c.sp;
    if (c.rev > 0) return { up: false, down: true, steer: -Math.sign(c.revSteer || 1) };
    const ld = 80 + Math.abs(u) * 0.38;
    const k = (c.ni + Math.round(ld / track.step)) % N;
    const p = pts[k];
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
      const q = pts[(c.ni + o) % N];
      const dist = o * track.step;
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

  return { TRACKS, ITEMS, PHYS, BOX_RESPAWN_MS, buildTrack, nearest, makeCar, stepCar, collide, resetCar,
    botInput, botRecover, wrapAngle };
});
