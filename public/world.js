// Builds the 3D scene for a track: terrain, road, curbs, walls, scenery,
// cars, pickups, particles and skid marks. 2D world (x, y) maps to 3D (x, h, y).
import * as THREE from '/vendor/three.module.js';
const S = window.Shared;

export const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

const THEMES = {
  canyon: { sky: 0x9ccbf0, horizon: 0xf2dcc0, fog: 0xd9cdb8, ground: [0.42, 0.58, 0.27], rock: [0.66, 0.38, 0.22],
    verge: [0.47, 0.42, 0.3], amp: 520, sea: false, flora: 'pine', sun: [1, 0.95, 0.85] },
  harbor: { sky: 0x86c3f0, horizon: 0xdff0fa, fog: 0xc9e2f0, ground: [0.32, 0.55, 0.3], rock: [0.5, 0.5, 0.48],
    verge: [0.35, 0.45, 0.3], amp: 200, sea: true, flora: 'round', sun: [1, 1, 0.95] },
  desert: { sky: 0x8fbfe8, horizon: 0xf7e0b5, fog: 0xead7b2, ground: [0.85, 0.7, 0.47], rock: [0.75, 0.45, 0.28],
    verge: [0.72, 0.58, 0.4], amp: 300, sea: false, flora: 'cactus', sun: [1, 0.92, 0.78] },
};

// ---------- noise ----------
function hash(i, j) {
  let h = Math.imul(i, 374761393) + Math.imul(j, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, y) => vnoise(x / 900, y / 900) * 0.6 + vnoise(x / 380, y / 380) * 0.28 + vnoise(x / 140, y / 140) * 0.12;
function rng(seed) { return () => (seed = (seed * 16807) % 2147483647) / 2147483647; }
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---------- textures ----------
function canvasTex(w, h, draw, repeat = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
const TEX = {};
function textures() {
  if (TEX.road) return TEX;
  const r = rng(11);
  TEX.road = canvasTex(256, 512, (g, w, h) => {
    g.fillStyle = '#4a4a50'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 9000; i++) { const v = 60 + r() * 40 | 0; g.fillStyle = `rgba(${v},${v},${v + 4},.5)`; g.fillRect(r() * w, r() * h, 2, 2); }
    g.fillStyle = 'rgba(20,20,22,.25)'; g.fillRect(w * 0.22, 0, w * 0.12, h); g.fillRect(w * 0.66, 0, w * 0.12, h);
    g.fillStyle = '#e8e6df'; g.fillRect(8, 0, 7, h); g.fillRect(w - 15, 0, 7, h);
    g.fillStyle = '#f0eee5'; g.fillRect(w / 2 - 4, 0, 8, h * 0.45);
  });
  TEX.curb = canvasTex(32, 64, (g, w, h) => {
    g.fillStyle = '#d62d24'; g.fillRect(0, 0, w, h / 2); g.fillStyle = '#f4f1ea'; g.fillRect(0, h / 2, w, h / 2);
  });
  TEX.wall = canvasTex(128, 32, (g, w, h) => {
    g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#1f5fbf'; g.fillRect(0, 0, w / 2, h);
    g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(0, h - 4, w, 4); g.fillRect(0, 0, w, 2);
  });
  TEX.checker = canvasTex(64, 64, (g, w, h) => {
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { g.fillStyle = (i + j) % 2 ? '#111' : '#fff'; g.fillRect(i * 16, j * 16, 16, 16); }
  });
  TEX.box = canvasTex(128, 128, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#ffe066'); gr.addColorStop(1, '#ff7b1c');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#fff'; g.lineWidth = 8; g.strokeRect(4, 4, w - 8, h - 8);
    g.fillStyle = '#5a1e00'; g.font = '900 90px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('?', w / 2, h / 2 + 6);
  }, false);
  TEX.crowd = canvasTex(256, 64, (g, w, h) => {
    g.fillStyle = '#3a3a48'; g.fillRect(0, 0, w, h);
    const cols = ['#e33', '#fc3', '#39f', '#fff', '#3c6', '#f6a', '#f90'];
    for (let y = 4; y < h; y += 8) for (let x = 2; x < w; x += 6) { g.fillStyle = cols[(r() * cols.length) | 0]; g.beginPath(); g.arc(x + r() * 2, y, 2.4, 0, 7); g.fill(); }
  });
  TEX.banner = canvasTex(512, 64, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#ff8a1f'); gr.addColorStop(1, '#d6400f');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff'; g.font = '900 40px Bungee, Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('TURBO BRAWL', w / 2, h / 2 + 2);
  }, false);
  TEX.dirt = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#8a6a45'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 7000; i++) { const v = r(); g.fillStyle = v < 0.5 ? 'rgba(60,40,20,.35)' : 'rgba(190,160,110,.3)'; g.fillRect(r() * w, r() * h, 2 + r() * 3, 2 + r() * 3); }
    g.fillStyle = 'rgba(50,35,20,.35)'; g.fillRect(w * 0.25, 0, w * 0.1, h); g.fillRect(w * 0.65, 0, w * 0.1, h);
  });
  TEX.fence = canvasTex(128, 32, (g, w, h) => {
    g.fillStyle = '#7a5532'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#5b3d22'; for (let x = 0; x < w; x += 32) g.fillRect(x, 0, 5, h);
    g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(0, 9, w, 3); g.fillRect(0, 22, w, 3);
  });
  TEX.ramp = canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = '#ffc61a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#1b1b1b';
    for (let y = -h; y < h * 2; y += 40) { g.beginPath(); g.moveTo(0, y); g.lineTo(w / 2, y - 26); g.lineTo(w, y); g.lineTo(w, y + 14); g.lineTo(w / 2, y - 12); g.lineTo(0, y + 14); g.fill(); }
  }, false);
  TEX.shortcut = canvasTex(512, 96, (g, w, h) => {
    g.fillStyle = '#2f8f3a'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#fff'; g.lineWidth = 6; g.strokeRect(6, 6, w - 12, h - 12);
    g.fillStyle = '#fff'; g.font = '900 52px Bungee, Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('SHORTCUT', w / 2, h / 2 + 3);
  }, false);
  TEX.puff = canvasTex(64, 64, (g, w, h) => {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  }, false);
  return TEX;
}

// ---------- the world ----------
export function buildWorld(trackIdx, renderer) {
  const track = S.buildTrack(trackIdx), T = THEMES[track.theme], tex = textures();
  const scene = new THREE.Scene();
  const half = track.width / 2;

  scene.fog = new THREE.Fog(T.fog, 1400, 5200);
  // sky dome
  {
    const g = new THREE.SphereGeometry(8000, 32, 16), cols = [], top = new THREE.Color(T.sky), hor = new THREE.Color(T.horizon);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const t = Math.max(0, pos.getY(i) / 8000), c = hor.clone().lerp(top, Math.pow(t, 0.6));
      cols.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    const sky = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    sky.renderOrder = -1;
    scene.add(sky);
    scene.userData.sky = sky;
  }

  // environment map from the sky so paint and glass get reflections
  if (renderer) {
    const envScene = new THREE.Scene();
    envScene.add(scene.userData.sky.clone());
    const groundDisc = new THREE.Mesh(new THREE.CircleGeometry(7000, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(...T.ground).multiplyScalar(0.6) }));
    groundDisc.position.y = -50; envScene.add(groundDisc);
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(envScene, 0.02).texture;
    scene.environmentIntensity = 0.6;
    pm.dispose();
  }
  const hemi = new THREE.HemisphereLight(T.sky, 0x6b5a40, 0.8);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(new THREE.Color(...T.sun), 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(isTouch ? 1024 : 2048, isTouch ? 1024 : 2048);
  const sc = sun.shadow.camera; sc.left = -520; sc.right = 520; sc.top = 520; sc.bottom = -520; sc.near = 10; sc.far = 2500;
  sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);
  const sunOff = new THREE.Vector3(-500, 900, -350);

  // terrain height: flat near any road (main loop or shortcut), hills further out
  const heightAt = (x, z) => {
    const cl = S.clearance(track, x, z);
    const m = smooth(40, 520, cl);
    let h = -1.2 + (fbm(x, z) - 0.32) * T.amp * m;
    if (track.theme === 'canyon') h += Math.max(0, vnoise(x / 600, z / 600) - 0.55) * 900 * m; // mesas
    if (T.sea) h -= Math.max(0, cl - 780) * 0.14;
    return { h: cl < 40 ? -1.2 : h, cl };
  };

  // terrain mesh
  {
    const b = track.bounds, pad = 1500, step = isTouch ? 70 : 50;
    const x0 = b.minX - pad, z0 = b.minY - pad, nx = Math.ceil((b.maxX - b.minX + pad * 2) / step), nz = Math.ceil((b.maxY - b.minY + pad * 2) / step);
    const pos = [], col = [], idx = [];
    const ground = new THREE.Color(...T.ground), rock = new THREE.Color(...T.rock), verge = new THREE.Color(...T.verge), sand = new THREE.Color(0.86, 0.78, 0.58);
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const x = x0 + i * step, z = z0 + j * step, H = heightAt(x, z);
      pos.push(x, H.h, z);
      const c = ground.clone().multiplyScalar(0.85 + fbm(x * 3, z * 3) * 0.3);
      c.lerp(rock, smooth(40, 260, H.h));
      if (H.cl < 60) c.lerp(verge, 0.6);
      if (T.sea && H.h < 4) c.lerp(sand, smooth(4, -6, H.h));
      col.push(c.r, c.g, c.b);
    }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b2 = a + 1, c = a + nx + 1, d = c + 1;
      idx.push(a, c, b2, b2, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx); g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: false }));
    mesh.receiveShadow = true;
    scene.add(mesh);
    if (T.sea) {
      const water = new THREE.Mesh(new THREE.PlaneGeometry(30000, 30000), new THREE.MeshStandardMaterial({ color: 0x2f7fb8, roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.92 }));
      water.rotation.x = -Math.PI / 2; water.position.y = -9;
      scene.add(water);
    } else {
      const far = new THREE.Mesh(new THREE.PlaneGeometry(30000, 30000), new THREE.MeshStandardMaterial({ color: ground.clone().multiplyScalar(0.9), roughness: 1 }));
      far.rotation.x = -Math.PI / 2; far.position.y = -3;
      scene.add(far);
    }
  }

  // ---- roads ----
  const others = R => track.roads.filter(Q => Q !== R);
  const pastEnd = (Q, i, x, y) => {
    if (Q.closed) return false;
    const p = Q.pts[i], along = (x - p.x) * p.dx + (y - p.y) * p.dy;
    return (i === 0 && along < 0) || (i === Q.N - 1 && along > 0);
  };
  // lateral offset of (x,y) on road Q, or null if beyond its ends
  const latOn = (Q, x, y) => {
    const n = S.nearestOn(Q, x, y);
    if (pastEnd(Q, n.i, x, y)) return null;
    const p = Q.pts[n.i];
    return { lat: (x - p.x) * p.nx + (y - p.y) * p.ny, p };
  };
  const onOtherSurface = (R, x, y, pad = 4) => others(R).some(Q => { const l = latOn(Q, x, y); return l && Math.abs(l.lat) < Q.half + pad; });
  const inOtherEnvelope = (R, x, y) => others(R).some(Q => { const l = latOn(Q, x, y); return l && l.lat < l.p.wp - 3 && l.lat > -(l.p.wn - 3); });

  // ribbon along road R between lateral offsets fa(k)..fb(k); keep(k) can drop quads
  function ribbon(R, fa, fb, ya, yb, vScale, mat, keep) {
    const pos = [], uv = [], idx = [], N = R.N, M = R.closed ? N : N - 1;
    for (let k = 0; k <= M; k++) {
      const p = R.pts[k % N], s = R.closed ? (k === N ? track.len : p.s) : k * track.step;
      const oa = fa(k % N), ob = fb(k % N);
      pos.push(p.x + p.nx * oa, ya, p.y + p.ny * oa, p.x + p.nx * ob, yb, p.y + p.ny * ob);
      uv.push(0, s / vScale, 1, s / vScale);
      if (k < M && (!keep || keep(k))) { const i = k * 2; idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    if (g.attributes.normal.count && g.attributes.normal.getY(0) < 0) mat.side = THREE.DoubleSide;
    scene.add(m);
    return m;
  }
  // vertical barrier along road R at each side's wall offset; hidden where it would block another road
  function barrier(R, sgn, height, mat, vScale) {
    const pos = [], uv = [], idx = [], N = R.N, M = R.closed ? N : N - 1;
    const at = k => { const p = R.pts[k % N], off = sgn * (sgn > 0 ? p.wp : p.wn); return [p.x + p.nx * off, p.y + p.ny * off]; };
    const open = [];
    for (let k = 0; k <= M; k++) open.push(inOtherEnvelope(R, ...at(k)));
    for (let k = 0; k <= M; k++) {
      const [x, z] = at(k), s = R.closed ? (k === N ? track.len : R.pts[k % N].s) : k * track.step;
      pos.push(x, 0, z, x, height, z);
      uv.push(s / vScale, 0, s / vScale, 1);
      if (k < M && !open[k] && !open[k + 1]) { const i = k * 2; idx.push(i, i + 2, i + 1, i + 1, i + 2, i + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    const wall = new THREE.Mesh(g, mat); wall.castShadow = true; wall.receiveShadow = true;
    scene.add(wall);
  }

  const main = track.roads[0];
  ribbon(main, () => -half, () => half, 0, 0, 170, new THREE.MeshStandardMaterial({ map: tex.road, roughness: 0.85 }));
  const curbMat = new THREE.MeshStandardMaterial({ map: tex.curb, roughness: 0.7, side: THREE.DoubleSide });
  const vergeMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(...T.verge).multiplyScalar(0.9), roughness: 1, side: THREE.DoubleSide });
  const wallMat = new THREE.MeshStandardMaterial({ map: tex.wall, roughness: 0.6, side: THREE.DoubleSide });
  for (const sgn of [1, -1]) {
    const curbAt = k => { const p = main.pts[k]; return [p.x + p.nx * sgn * (half + 8), p.y + p.ny * sgn * (half + 8)]; };
    ribbon(main, () => sgn * half, () => sgn * (half + 16), 0.5, 0.3, 64, curbMat,
      k => !onOtherSurface(main, ...curbAt(k)) && !onOtherSurface(main, ...curbAt((k + 1) % main.N)));
    ribbon(main, () => sgn * (half + 16), k => sgn * (sgn > 0 ? main.pts[k].wp : main.pts[k].wn), 0.15, 0.15, 200, vergeMat);
    barrier(main, sgn, 18, wallMat, 90);
  }
  // shortcuts: dirt roads with wooden fences, drawn only where they leave the main road
  const dirtMat = new THREE.MeshStandardMaterial({ map: tex.dirt, roughness: 1 });
  const fenceMat = new THREE.MeshStandardMaterial({ map: tex.fence, roughness: 0.9, side: THREE.DoubleSide });
  for (const R of track.roads.slice(1)) {
    ribbon(R, () => -R.half, () => R.half, 0.2, 0.2, 140, dirtMat, k => !onOtherSurface(R, R.pts[k].x, R.pts[k].y, -6));
    for (const sgn of [1, -1]) barrier(R, sgn, 12, fenceMat, 60);
    // "SHORTCUT" arch where the branch leaves the main road
    let k = 0;
    while (k < R.N - 1 && onOtherSurface(R, R.pts[k].x, R.pts[k].y, R.half + 40)) k++;
    const p = R.pts[Math.min(R.N - 1, k + 2)], g = new THREE.Group();
    const post = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.9 });
    for (const s2 of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(6, 62, 6), post);
      m.position.set(0, 31, s2 * (R.half + 18)); m.castShadow = true; g.add(m);
    }
    const sign = new THREE.Mesh(new THREE.BoxGeometry(4, 18, R.width + 40),
      [new THREE.MeshStandardMaterial({ map: tex.shortcut }), new THREE.MeshStandardMaterial({ map: tex.shortcut }), post, post, post, post]);
    sign.position.y = 62; sign.castShadow = true; g.add(sign);
    g.position.set(p.x, 0, p.y); g.rotation.y = -p.ang;
    scene.add(g);
  }

  // jump ramps
  {
    const topMat = new THREE.MeshStandardMaterial({ map: tex.ramp, roughness: 0.6 });
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x3a3a40, roughness: 0.8 });
    for (const r of track.ramps) {
      const L = r.len, Wd = r.w / 2, Hh = r.h;
      // local frame: x along the ramp, z across, y up
      const v = [
        [0, 0.3, -Wd], [0, 0.3, Wd], [L, Hh, -Wd], [L, Hh, Wd], [L, 0, -Wd], [L, 0, Wd],
      ];
      const tri = (a, b, c, uva, uvb, uvc, arr, uvs) => { arr.push(...v[a], ...v[b], ...v[c]); uvs.push(...uva, ...uvb, ...uvc); };
      const top = [], topUv = [], side = [], sideUv = [];
      tri(0, 2, 1, [0, 0], [0, 1], [1, 0], top, topUv); tri(1, 2, 3, [1, 0], [0, 1], [1, 1], top, topUv);
      tri(2, 4, 3, [0, 0], [0, 0], [0, 0], side, sideUv); tri(3, 4, 5, [0, 0], [0, 0], [0, 0], side, sideUv);
      tri(0, 4, 2, [0, 0], [0, 0], [0, 0], side, sideUv); tri(1, 3, 5, [0, 0], [0, 0], [0, 0], side, sideUv);
      const mk = (arr, uvs, mat) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        g.computeVertexNormals();
        mat.side = THREE.DoubleSide;
        const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true;
        return m;
      };
      const grp = new THREE.Group();
      grp.add(mk(top, topUv, topMat), mk(side, sideUv, sideMat));
      grp.position.set(r.x, 0, r.y); grp.rotation.y = -r.ang;
      scene.add(grp);
    }
  }

  // start line + gantry
  {
    const p = track.pts[0], ang = p.ang;
    const line = new THREE.Mesh(new THREE.PlaneGeometry(20, track.width), new THREE.MeshStandardMaterial({ map: tex.checker, roughness: 0.8 }));
    tex.checker.repeat.set(1, track.width / 20);
    line.rotation.x = -Math.PI / 2; line.rotation.z = -ang;
    line.position.set(p.x, 0.25, p.y); line.receiveShadow = true;
    scene.add(line);
    const g = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0xb4bac2, metalness: 0.3, roughness: 0.45 });
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(8, 90, 8), metal);
      post.position.set(0, 45, s * (half + 34)); post.castShadow = true; g.add(post);
    }
    const banner = new THREE.Mesh(new THREE.BoxGeometry(6, 22, track.width + 76),
      [new THREE.MeshStandardMaterial({ map: tex.banner }), new THREE.MeshStandardMaterial({ map: tex.banner }), metal, metal, metal, metal]);
    banner.position.y = 88; banner.castShadow = true; g.add(banner);
    g.position.set(p.x, 0, p.y); g.rotation.y = -ang;
    scene.add(g);
  }

  // grandstands near the start, on whichever side has room
  const stands = [];
  {
    const mat = [new THREE.MeshStandardMaterial({ color: 0x8a8f99 }), new THREE.MeshStandardMaterial({ color: 0x8a8f99 }),
      new THREE.MeshStandardMaterial({ map: tex.crowd }), new THREE.MeshStandardMaterial({ color: 0x8a8f99 }),
      new THREE.MeshStandardMaterial({ color: 0x8a8f99 }), new THREE.MeshStandardMaterial({ color: 0x8a8f99 })];
    for (const k of [track.N - 22, 18]) {
      const p = track.pts[k];
      for (const sgn of [1, -1]) {
        const off = sgn * ((sgn > 0 ? p.wp : p.wn) + 55);
        const x = p.x + p.nx * off, z = p.y + p.ny * off;
        if (S.clearance(track, x, z) < -60 || track.roads.slice(1).some(R => S.nearestOn(R, x, z).d < R.half + 200)) continue;
        const n = S.nearest(track, x, z);
        if (n.d < Math.abs(off) - 5) continue;
        const g = new THREE.Group();
        for (let r = 0; r < 4; r++) {
          const step = new THREE.Mesh(new THREE.BoxGeometry(240, 12 + r * 12, 18), mat);
          step.position.set(0, (12 + r * 12) / 2, sgn * r * 16); step.castShadow = true; step.receiveShadow = true;
          g.add(step);
        }
        const roof = new THREE.Mesh(new THREE.BoxGeometry(250, 3, 80), new THREE.MeshStandardMaterial({ color: 0xd6402a }));
        roof.position.set(0, 82, sgn * 26); roof.castShadow = true; g.add(roof);
        g.position.set(x, 0, z); g.rotation.y = -p.ang;
        scene.add(g); stands.push({ x, y: z });
        break;
      }
    }
  }

  // scenery (instanced)
  {
    const r = rng(track.idx * 977 + 13), b = track.bounds, pad = 1300, want = isTouch ? 260 : 480;
    const spots = [];
    for (let tries = 0; tries < 6000 && spots.length < want; tries++) {
      const x = b.minX - pad + r() * (b.maxX - b.minX + pad * 2), z = b.minY - pad + r() * (b.maxY - b.minY + pad * 2);
      const H = heightAt(x, z);
      if (H.cl < 50) continue;
      if (T.sea && H.h < 2) continue;
      if (stands.some(s => Math.hypot(s.x - x, s.y - z) < 180)) continue;
      spots.push({ x, z, h: H.h, s: 0.7 + r() * 0.8, rot: r() * 6.28, rock: r() < 0.18 });
    }
    const dummy = new THREE.Object3D();
    const inst = (geo, mat, list, place) => {
      const m = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((sp, i) => { place(dummy, sp); dummy.updateMatrix(); m.setMatrixAt(i, dummy.matrix); });
      m.castShadow = true; m.receiveShadow = true; scene.add(m);
    };
    const plants = spots.filter(s => !s.rock), rocks = spots.filter(s => s.rock);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1 });
    const leafMat = new THREE.MeshStandardMaterial({ color: track.theme === 'harbor' ? 0x3f8a3a : 0x2f6b34, roughness: 0.9, flatShading: true });
    if (T.flora === 'pine') {
      inst(new THREE.CylinderGeometry(3, 4, 24, 6), trunkMat, plants, (d, s) => { d.position.set(s.x, s.h + 12 * s.s, s.z); d.scale.setScalar(s.s); d.rotation.set(0, s.rot, 0); });
      inst(new THREE.ConeGeometry(22, 60, 7), leafMat, plants, (d, s) => { d.position.set(s.x, s.h + (24 + 30) * s.s, s.z); d.scale.setScalar(s.s); });
      inst(new THREE.ConeGeometry(16, 40, 7), leafMat, plants, (d, s) => { d.position.set(s.x, s.h + (24 + 58) * s.s, s.z); d.scale.setScalar(s.s); });
    } else if (T.flora === 'round') {
      inst(new THREE.CylinderGeometry(3, 4, 26, 6), trunkMat, plants, (d, s) => { d.position.set(s.x, s.h + 13 * s.s, s.z); d.scale.setScalar(s.s); });
      inst(new THREE.IcosahedronGeometry(24, 1), leafMat, plants, (d, s) => { d.position.set(s.x, s.h + 42 * s.s, s.z); d.scale.set(s.s, s.s * 0.9, s.s); d.rotation.y = s.rot; });
    } else {
      const cactus = new THREE.MeshStandardMaterial({ color: 0x4f8a3c, roughness: 0.9, flatShading: true });
      inst(new THREE.CylinderGeometry(5, 6, 46, 8), cactus, plants, (d, s) => { d.position.set(s.x, s.h + 23 * s.s, s.z); d.scale.setScalar(s.s); d.rotation.y = s.rot; });
      inst(new THREE.CylinderGeometry(3.5, 3.5, 18, 6), cactus, plants, (d, s) => {
        d.position.set(s.x + Math.cos(s.rot) * 8 * s.s, s.h + 30 * s.s, s.z + Math.sin(s.rot) * 8 * s.s); d.scale.setScalar(s.s); d.rotation.set(0, 0, 0);
      });
    }
    const rockMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(...T.rock), roughness: 1, flatShading: true });
    inst(new THREE.DodecahedronGeometry(18, 0), rockMat, rocks, (d, s) => { d.position.set(s.x, s.h + 6, s.z); d.scale.set(s.s * 1.4, s.s, s.s * 1.1); d.rotation.set(s.rot, s.rot * 2, 0); });
  }

  // crowd position for audio
  const crowdAt = stands.length ? stands : [{ x: track.pts[0].x, y: track.pts[0].y }];

  return { scene, track, sun, sunOff, heightAt, crowdAt, theme: T };
}

// ---------- cars ----------
const wheelGeo = new THREE.CylinderGeometry(5.2, 5.2, 4.5, 16).rotateX(Math.PI / 2);
const rimGeo = new THREE.CylinderGeometry(3, 3, 4.7, 8).rotateX(Math.PI / 2);
const tyreMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
const rimMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, metalness: 0.8, roughness: 0.3 });
const glassMat = new THREE.MeshStandardMaterial({ color: 0x1a2533, metalness: 0.9, roughness: 0.08 });
const darkMat = new THREE.MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.6 });

function nameSprite(text) {
  const t = canvasTex(256, 64, (g, w, h) => {
    g.font = '700 30px Inter, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const tw = g.measureText(text).width + 24;
    g.fillStyle = 'rgba(0,0,0,.55)'; g.beginPath(); g.roundRect((w - tw) / 2, 10, tw, 44, 12); g.fill();
    g.fillStyle = '#fff'; g.fillText(text, w / 2, h / 2 + 1);
  }, false);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, sizeAttenuation: false, depthWrite: false }));
  s.scale.set(0.16, 0.04, 1); s.position.y = 40; s.renderOrder = 10;
  return s;
}

export function makeCarMesh(color, name) {
  const root = new THREE.Group(), body = new THREE.Group();
  root.add(body);
  const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.3 });
  const add = (geo, mat, x, y, z, parent = body) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m; };
  add(new THREE.BoxGeometry(46, 8, 24), paint, 0, 8.5, 0);              // chassis
  add(new THREE.BoxGeometry(14, 4, 23), paint, 15, 13.5, 0);           // hood
  add(new THREE.BoxGeometry(20, 8, 20), glassMat, -3, 16, 0);          // cabin glass
  add(new THREE.BoxGeometry(16, 1.6, 19), paint, -4, 20.6, 0);         // roof
  add(new THREE.BoxGeometry(46.5, 2.5, 24.5), darkMat, 0, 4.5, 0);     // skirt
  add(new THREE.BoxGeometry(4, 1.4, 25), darkMat, -21, 19, 0);         // spoiler
  add(new THREE.BoxGeometry(2, 5, 1.5), darkMat, -21, 15, 8); add(new THREE.BoxGeometry(2, 5, 1.5), darkMat, -21, 15, -8);
  const stripe = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.3, roughness: 0.4 });
  add(new THREE.BoxGeometry(30, 0.4, 4), stripe, 6, 15.7, 0);
  const headMat = new THREE.MeshStandardMaterial({ color: 0xfff6d0, emissive: 0xfff2b0, emissiveIntensity: 0.8 });
  add(new THREE.BoxGeometry(1, 3, 6), headMat, 23.2, 10, 7.5); add(new THREE.BoxGeometry(1, 3, 6), headMat, 23.2, 10, -7.5);
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1a1a, emissiveIntensity: 0.3 });
  add(new THREE.BoxGeometry(1, 3, 7), tailMat, -23.2, 10, 7.5); add(new THREE.BoxGeometry(1, 3, 7), tailMat, -23.2, 10, -7.5);

  const wheels = [];
  for (const [x, z, front] of [[14, 12.5, 1], [14, -12.5, 1], [-14, 12.5, 0], [-14, -12.5, 0]]) {
    const steerG = new THREE.Group(); steerG.position.set(x, 5.2, z); root.add(steerG);
    const spinG = new THREE.Group(); steerG.add(spinG);
    const tyre = new THREE.Mesh(wheelGeo, tyreMat); tyre.castShadow = true; spinG.add(tyre);
    const rim = new THREE.Mesh(rimGeo, rimMat); spinG.add(rim);
    wheels.push({ steerG, spinG, front });
  }

  const shield = new THREE.Mesh(new THREE.SphereGeometry(34, 20, 14),
    new THREE.MeshStandardMaterial({ color: 0x5ac8ff, emissive: 0x2a88cc, emissiveIntensity: 0.8, transparent: true, opacity: 0.25, depthWrite: false }));
  shield.position.y = 10; shield.visible = false; root.add(shield);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(5, 22, 10).rotateZ(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffa020, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
  flame.position.set(-33, 8, 0); flame.visible = false; root.add(flame);

  if (name) root.add(nameSprite(name));
  return { root, body, wheels, tailMat, shield, flame, spin: 0 };
}

export function poseCar(m, s, dt) {
  // s: {x, y, a, sp, steer, roll, pitch, braking, boost, shield}
  m.root.position.set(s.x, s.z || 0, s.y);
  m.root.rotation.y = -s.a;
  m.body.rotation.x = s.roll || 0;
  m.body.rotation.z = s.pitch || 0;
  m.spin -= (s.sp * dt) / 5.2;
  for (const w of m.wheels) {
    w.spinG.rotation.z = m.spin;
    if (w.front) w.steerG.rotation.y = -(s.steer || 0) * 0.45;
  }
  m.tailMat.emissiveIntensity = s.braking ? 2.2 : 0.3;
  m.shield.visible = !!s.shield;
  m.flame.visible = !!s.boost;
  if (s.boost) m.flame.scale.set(0.8 + Math.random() * 0.5, 1, 1);
}

// ---------- pickups / projectiles ----------
export function makeBoxMesh() {
  const t = textures();
  const m = new THREE.Mesh(new THREE.BoxGeometry(22, 22, 22),
    new THREE.MeshStandardMaterial({ map: t.box, emissive: 0xff8a1f, emissiveIntensity: 0.35, transparent: true, opacity: 0.92 }));
  m.castShadow = true;
  return m;
}
export function makeRocketMesh() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 20, 10).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.6, roughness: 0.3 }));
  const nose = new THREE.Mesh(new THREE.ConeGeometry(3, 8, 10).rotateZ(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xdd2222 }));
  nose.position.x = 14;
  const fire = new THREE.Mesh(new THREE.ConeGeometry(3.5, 14, 8).rotateZ(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffb030, blending: THREE.AdditiveBlending, transparent: true }));
  fire.position.x = -17;
  g.add(body, nose, fire);
  body.castShadow = true;
  return g;
}
export function makeOilMesh() {
  const m = new THREE.Mesh(new THREE.CircleGeometry(30, 24), new THREE.MeshStandardMaterial({ color: 0x0b0812, roughness: 0.05, metalness: 0.4, transparent: true, opacity: 0.9 }));
  m.rotation.x = -Math.PI / 2; m.scale.set(1, 0.75, 1);
  return m;
}

// ---------- particles ----------
export class Particles {
  constructor(scene, max = isTouch ? 220 : 420) {
    const t = textures();
    this.pool = [];
    for (let i = 0; i < max; i++) {
      const mat = new THREE.SpriteMaterial({ map: t.puff, transparent: true, depthWrite: false, opacity: 0 });
      const s = new THREE.Sprite(mat); s.visible = false; scene.add(s);
      this.pool.push({ s, life: 0 });
    }
    this.i = 0;
  }
  emit(x, y, z, o) {
    const p = this.pool[this.i]; this.i = (this.i + 1) % this.pool.length;
    p.x = x; p.y = y; p.z = z;
    p.vx = o.vx || 0; p.vy = o.vy || 0; p.vz = o.vz || 0;
    p.life = p.max = o.life || 1; p.size = o.size || 10; p.grow = o.grow || 0; p.g = o.g || 0;
    p.alpha = o.alpha ?? 0.6; p.drag = o.drag ?? 1.5;
    p.s.material.color.set(o.color || 0xffffff);
    p.s.material.blending = o.add ? THREE.AdditiveBlending : THREE.NormalBlending;
    p.s.visible = true;
  }
  update(dt) {
    for (const p of this.pool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.s.visible = false; continue; }
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vz *= k; p.vy = p.vy * k - p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < 0.5) { p.y = 0.5; p.vy = Math.abs(p.vy) * 0.3; }
      const t = p.life / p.max, sz = p.size + p.grow * (1 - t);
      p.s.position.set(p.x, p.y, p.z); p.s.scale.set(sz, sz, 1);
      p.s.material.opacity = p.alpha * Math.min(1, t * 2);
    }
  }
}

// ---------- skid marks ----------
export class Skids {
  constructor(scene, max = isTouch ? 1500 : 3000) {
    this.max = max;
    this.pos = new Float32Array(max * 6 * 3);
    this.alpha = new Float32Array(max * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setDrawRange(0, 0);
    this.geo = g;
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.45, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    m.frustumCulled = false; m.renderOrder = 1;
    scene.add(m); this.mesh = m;
    this.i = 0; this.count = 0;
  }
  // segment from (x0,z0) to (x1,z1), width w
  add(x0, z0, x1, z1, w = 4.5) {
    const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz);
    if (l < 0.5 || l > 60) return;
    const nx = -dz / l * w / 2, nz = dx / l * w / 2, y = 0.3;
    const v = [x0 + nx, y, z0 + nz, x0 - nx, y, z0 - nz, x1 + nx, y, z1 + nz, x0 - nx, y, z0 - nz, x1 - nx, y, z1 - nz, x1 + nx, y, z1 + nz];
    this.pos.set(v, this.i * 18);
    this.i = (this.i + 1) % this.max;
    this.count = Math.min(this.max, this.count + 1);
    this.geo.setDrawRange(0, this.count * 6);
    this.geo.attributes.position.needsUpdate = true;
  }
}
