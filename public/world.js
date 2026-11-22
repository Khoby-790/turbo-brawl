// Builds the 3D scene for a track: terrain, road, curbs, walls, scenery,
// cars, pickups, particles and skid marks. 2D world (x, y) maps to 3D (x, h, y).
import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';
import { Q, isTouch, addSky, addClouds, addFlare } from './gfx.js';
const S = window.Shared;
export { isTouch };

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
// Turn a greyscale height canvas into a tangent-space normal map (Sobel filter, wraps at edges).
function normalMap(src, strength = 2) {
  const w = src.width, h = src.height, sd = src.getContext('2d').getImageData(0, 0, w, h).data;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), out = g.createImageData(w, h), od = out.data;
  const H = (x, y) => sd[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
    const dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1));
    let nx = -dx * strength, ny = -dy * strength, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * w + x) * 4;
    od[i] = (nx * 0.5 + 0.5) * 255; od[i + 1] = (ny * 0.5 + 0.5) * 255; od[i + 2] = (nz * 0.5 + 0.5) * 255; od[i + 3] = 255;
  }
  g.putImageData(out, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}
function heightCanvas(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.fillStyle = '#808080'; g.fillRect(0, 0, w, h); draw(g, w, h);
  return c;
}
// value noise rendered into a canvas (tileable by wrapping the lattice)
function noiseCanvas(w, h, cell, seed, lo, hi) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), img = g.createImageData(w, h), d = img.data;
  const nx = Math.round(w / cell), ny = Math.round(h / cell);
  const lat = (i, j) => hash(((i % nx) + nx) % nx + seed * 131, ((j % ny) + ny) % ny + seed * 71);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const fx = x / cell, fy = y / cell, i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
    const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
    const a = lat(i, j), b = lat(i + 1, j), cc = lat(i, j + 1), dd = lat(i + 1, j + 1);
    const n = a + (b - a) * su + (cc - a) * sv + (a - b - cc + dd) * su * sv;
    const val = (lo + (hi - lo) * n) | 0, k = (y * w + x) * 4;
    d[k] = d[k + 1] = d[k + 2] = val; d[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

const TEX = {};
function textures() {
  if (TEX.road) return TEX;
  const r = rng(11);
  const HQ = Q.post; // bigger textures when post-processing is on
  // asphalt: aggregate speckle, soft patches, darker polished racing lines, worn paint
  {
    const w = HQ ? 512 : 256, h = HQ ? 1024 : 512;
    const hc = heightCanvas(w, h, (g) => {
      for (let i = 0; i < w * h * 0.12; i++) { const v = (90 + r() * 80) | 0; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(r() * w, r() * h, 1, 1); }
      g.strokeStyle = 'rgba(30,30,30,.8)'; g.lineWidth = 1.2;
      for (let i = 0; i < 6; i++) { let x = r() * w, y = r() * h; g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 8; k++) { x += (r() - 0.5) * 30; y += r() * 26; g.lineTo(x, y); } g.stroke(); }
    });
    TEX.roadN = normalMap(hc, 0.9);
    TEX.road = canvasTex(w, h, (g) => {
      g.fillStyle = '#47474c'; g.fillRect(0, 0, w, h);
      g.globalAlpha = 0.35; g.drawImage(noiseCanvas(w, h, 64, 3, 40, 110), 0, 0); g.globalAlpha = 1;
      for (let i = 0; i < w * h * 0.06; i++) { const v = 62 + r() * 34 | 0; g.fillStyle = `rgba(${v},${v},${v + 3},.35)`; g.fillRect(r() * w, r() * h, 1, 1); }
      const lg = (x0, x1) => { const gr = g.createLinearGradient(x0, 0, x1, 0); gr.addColorStop(0, 'rgba(15,15,18,0)'); gr.addColorStop(0.5, 'rgba(15,15,18,.32)'); gr.addColorStop(1, 'rgba(15,15,18,0)'); g.fillStyle = gr; g.fillRect(x0, 0, x1 - x0, h); };
      lg(w * 0.18, w * 0.38); lg(w * 0.62, w * 0.82);
      const paint = (x, y, ww, hh) => { g.fillStyle = '#ecebe4'; g.fillRect(x, y, ww, hh); for (let i = 0; i < ww * hh * 0.12; i++) { g.fillStyle = 'rgba(70,70,75,.6)'; g.fillRect(x + r() * ww, y + r() * hh, 1.5, 1.5); } };
      paint(w * 0.03, 0, w * 0.028, h); paint(w * 0.942, 0, w * 0.028, h); paint(w / 2 - w * 0.016, 0, w * 0.032, h * 0.45);
      g.strokeStyle = 'rgba(25,25,28,.5)'; g.lineWidth = 1.3;
      for (let i = 0; i < 6; i++) { let x = r() * w, y = r() * h; g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 8; k++) { x += (r() - 0.5) * 30; y += r() * 26; g.lineTo(x, y); } g.stroke(); }
    });
  }
  TEX.curb = canvasTex(64, 128, (g, w, h) => {
    g.fillStyle = '#c92a22'; g.fillRect(0, 0, w, h / 2); g.fillStyle = '#efece4'; g.fillRect(0, h / 2, w, h / 2);
    for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(0,0,0,${r() * 0.12})`; g.fillRect(r() * w, r() * h, 2, 2); }
  });
  TEX.curbN = normalMap(heightCanvas(64, 128, (g, w, h) => { const gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, '#404040'); gr.addColorStop(0.5, '#c0c0c0'); gr.addColorStop(1, '#404040'); g.fillStyle = gr; g.fillRect(0, 0, w, h); }), 2);
  // concrete barrier with painted stripes, grime at the base
  TEX.wall = canvasTex(256, 64, (g, w, h) => {
    g.fillStyle = '#d9d9d6'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#1f55ad'; g.fillRect(0, 0, w / 2, h);
    g.globalAlpha = 0.25; g.drawImage(noiseCanvas(w, h, 8, 5, 60, 200), 0, 0); g.globalAlpha = 1;
    const gr = g.createLinearGradient(0, h, 0, h * 0.55); gr.addColorStop(0, 'rgba(40,32,24,.55)'); gr.addColorStop(1, 'rgba(40,32,24,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, 0, w, 3); g.fillRect(w / 2 - 1, 0, 2, h); g.fillRect(w - 2, 0, 2, h);
  });
  TEX.wallN = normalMap(noiseCanvas(256, 64, 3, 7, 90, 170), 1.2);
  TEX.waterN = normalMap(noiseCanvas(256, 256, 16, 9, 0, 255), 3);
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
  TEX.dirtN = normalMap(noiseCanvas(256, 256, 6, 11, 40, 220), 2.2);
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

// Greyscale ground detail per theme (multiplied with the terrain's vertex colours) + its normal map.
const DETAIL = {};
function groundDetail(theme) {
  if (DETAIL[theme]) return DETAIL[theme];
  const r = rng(theme.length * 31 + 5), N = Q.post ? 512 : 256;
  const hc = heightCanvas(N, N, (g, w, h) => {
    if (theme === 'desert') {
      for (let y = 0; y < h; y += 2) { const v = 128 + Math.sin(y * 0.19 + Math.sin(y * 0.05) * 3) * 70; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(0, y, w, 2); }
      g.globalAlpha = 0.4; g.drawImage(noiseCanvas(w, h, 4, 2, 60, 200), 0, 0); g.globalAlpha = 1;
    } else {
      for (let i = 0; i < w * h * 0.06; i++) { const x = r() * w, y = r() * h, v = 90 + r() * 160 | 0; g.strokeStyle = `rgb(${v},${v},${v})`; g.lineWidth = 1; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 3, y - 3 - r() * 5); g.stroke(); }
    }
  });
  const map = canvasTex(N, N, (g, w, h) => {
    g.drawImage(noiseCanvas(w, h, 48, 13, 170, 255), 0, 0);
    g.globalCompositeOperation = 'multiply'; g.globalAlpha = 0.5; g.drawImage(hc, 0, 0);
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  });
  return DETAIL[theme] = { map, normal: normalMap(hc, theme === 'desert' ? 1.5 : 2.5) };
}

// ---------- geometry helpers ----------
function mergeGeos(list) {
  // minimal merge: convert to non-indexed and concatenate position/normal/uv
  const parts = list.map(g => (g.index ? g.toNonIndexed() : g));
  const cat = (name, size) => {
    const total = parts.reduce((n, g) => n + (g.attributes[name] ? g.attributes[name].count : 0), 0);
    const out = new Float32Array(total * size); let o = 0;
    for (const g of parts) { const a = g.attributes[name]; if (!a) continue; out.set(a.array, o); o += a.array.length; }
    return new THREE.BufferAttribute(out, size);
  };
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', cat('position', 3)); g.setAttribute('normal', cat('normal', 3)); g.setAttribute('uv', cat('uv', 2));
  return g;
}
// displace vertices by a position-keyed hash so the same point always moves the same way (no cracks)
function jitter(geo, amt, seed) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = Math.round(x * 10) * 73856093 ^ Math.round(y * 10) * 19349663 ^ Math.round(z * 10) * 83492791 ^ seed;
    const h1 = hash(k, 1) - 0.5, h2 = hash(k, 2) - 0.5, h3 = hash(k, 3) - 0.5;
    pos.setXYZ(i, x + h1 * amt, y + h2 * amt * 0.7, z + h3 * amt);
  }
  geo.computeVertexNormals();
  return geo;
}

// Instanced grass clumps near the track that sway in the wind.
function addGrass(scene, track, heightAt) {
  const count = Math.round(Q.grass * (track.theme === 'desert' ? 0.35 : 1));
  if (!count) return null;
  const blades = 7, pos = [], col = [], nor = [];
  const r = rng(77);
  const base = track.theme === 'desert' ? [0.42, 0.38, 0.2] : [0.12, 0.22, 0.06], tip = track.theme === 'desert' ? [0.86, 0.78, 0.5] : [0.48, 0.66, 0.24];
  for (let i = 0; i < blades; i++) {
    const a = r() * Math.PI * 2, d = r() * 4, hgt = 7 + r() * 7, w = 0.9 + r() * 0.6, lean = (r() - 0.5) * 3;
    const cx = Math.cos(a) * d, cz = Math.sin(a) * d, px = -Math.sin(a) * w, pz = Math.cos(a) * w;
    const tx = cx + Math.cos(a) * lean, tz = cz + Math.sin(a) * lean;
    pos.push(cx - px, 0, cz - pz, cx + px, 0, cz + pz, tx, hgt, tz);
    col.push(...base, ...base, ...tip);
    nor.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      float hgt = clamp(position.y / 12.0, 0.0, 1.0);
      vec4 ip = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      float wv = sin(uTime * 1.8 + ip.x * 0.013 + ip.z * 0.011) + 0.5 * sin(uTime * 3.1 + ip.z * 0.03);
      transformed.x += wv * hgt * hgt * 2.2;
      transformed.z += cos(uTime * 1.3 + ip.x * 0.017) * hgt * hgt * 1.4;`);
    mat.userData.shader = shader;
  };
  const m = new THREE.InstancedMesh(g, mat, count);
  const b = track.bounds, pad = 900, d = new THREE.Object3D(), c = new THREE.Color();
  let n = 0;
  for (let tries = 0; tries < count * 6 && n < count; tries++) {
    const x = b.minX - pad + r() * (b.maxX - b.minX + pad * 2), z = b.minY - pad + r() * (b.maxY - b.minY + pad * 2);
    const cl = S.clearance(track, x, z);
    if (cl < 12 || cl > 650 || r() < cl / 900) continue; // denser close to the track
    const H = heightAt(x, z);
    if (H.h < 1 && track.theme === 'harbor') continue;
    if (H.h > 140) continue; // not on rock faces
    const sc = 0.7 + r() * 0.9;
    d.position.set(x, H.h - 0.5, z); d.rotation.set(0, r() * 6.28, 0); d.scale.set(sc, sc * (0.8 + r() * 0.5), sc); d.updateMatrix();
    m.setMatrixAt(n, d.matrix);
    m.setColorAt(n, c.setScalar(0.75 + r() * 0.45));
    n++;
  }
  m.count = n;
  m.receiveShadow = true;
  m.frustumCulled = false;
  scene.add(m);
  return m;
}

// ---------- the world ----------
export function buildWorld(trackIdx, renderer) {
  const track = S.buildTrack(trackIdx), T = THEMES[track.theme], tex = textures();
  const scene = new THREE.Scene();
  const half = track.width / 2;

  // physically based sky, image-based lighting, clouds, sun
  const SK = addSky(scene, track.theme, renderer);
  if (!Q.sky) {
    // Low quality: cheap gradient dome
    const g = new THREE.SphereGeometry(8000, 32, 16), cols = [], top = new THREE.Color(T.sky), hor = new THREE.Color(T.horizon);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) { const t = Math.max(0, pos.getY(i) / 8000); const c = hor.clone().lerp(top, Math.pow(t, 0.6)); cols.push(c.r, c.g, c.b); }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    const dome = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    dome.renderOrder = -1; scene.add(dome); SK.sky = dome;
    // cheap one-off reflection map from the gradient dome so paint and metal aren't black
    if (renderer) {
      const envScene = new THREE.Scene(); envScene.add(dome.clone());
      const gd = new THREE.Mesh(new THREE.CircleGeometry(7000, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(...T.ground).multiplyScalar(0.6) }));
      gd.position.y = -50; envScene.add(gd);
      const pm = new THREE.PMREMGenerator(renderer);
      scene.environment = pm.fromScene(envScene, 0.02).texture; scene.environmentIntensity = 0.7;
      pm.dispose();
    }
  }
  scene.userData.sky = SK.sky;
  const clouds = addClouds(scene, track.theme);
  const flare = addFlare(scene);
  const hemi = new THREE.HemisphereLight(T.sky, 0x5b4a35, Q.sky ? 0.35 : 1.5);
  scene.add(hemi);
  const warm = SK.cfg.elev < 20;
  const sun = new THREE.DirectionalLight(warm ? 0xffd9a8 : 0xfff4e6, Q.sky ? 3.2 : 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(Q.shadow, Q.shadow);
  const shadowR = Q.shadow >= 4096 ? 700 : 520;
  const sc = sun.shadow.camera; sc.left = -shadowR; sc.right = shadowR; sc.top = shadowR; sc.bottom = -shadowR; sc.near = 10; sc.far = 4000;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.8;
  scene.add(sun, sun.target);
  const sunOff = SK.sunDir.clone().multiplyScalar(1800);

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
    const pos = [], col = [], idx = [], uvs = [];
    const ground = new THREE.Color(...T.ground), rock = new THREE.Color(...T.rock), verge = new THREE.Color(...T.verge), sand = new THREE.Color(0.86, 0.78, 0.58);
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const x = x0 + i * step, z = z0 + j * step, H = heightAt(x, z);
      pos.push(x, H.h, z); uvs.push(x / 160, z / 160);
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
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx); g.computeVertexNormals();
    const det = groundDetail(track.theme);
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, map: det.map,
      normalMap: det.normal, normalScale: new THREE.Vector2(0.8, 0.8) }));
    mesh.receiveShadow = true;
    scene.add(mesh);
    if (T.sea) {
      let water;
      if (Q.water) {
        tex.waterN.repeat.set(1, 1);
        water = new Water(new THREE.PlaneGeometry(30000, 30000), {
          textureWidth: 512, textureHeight: 512, waterNormals: tex.waterN, sunDirection: SK.sunDir.clone(),
          sunColor: 0xfff2dd, waterColor: 0x0f4a63, distortionScale: 2.2, fog: true, alpha: 1,
        });
        water.material.uniforms.size.value = 0.6;
      } else {
        water = new THREE.Mesh(new THREE.PlaneGeometry(30000, 30000), new THREE.MeshStandardMaterial({ color: 0x1f6a90, roughness: 0.08, metalness: 0.3,
          normalMap: tex.waterN, normalScale: new THREE.Vector2(0.4, 0.4) }));
        tex.waterN.repeat.set(200, 200);
      }
      water.rotation.x = -Math.PI / 2; water.position.y = -9;
      scene.add(water); scene.userData.water = water;
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
  function ribbon(R, fa, fb, ya, yb, vScale, mat, keep, worldU) {
    const pos = [], uv = [], idx = [], N = R.N, M = R.closed ? N : N - 1;
    for (let k = 0; k <= M; k++) {
      const p = R.pts[k % N], s = R.closed ? (k === N ? track.len : p.s) : k * track.step;
      const oa = fa(k % N), ob = fb(k % N);
      pos.push(p.x + p.nx * oa, ya, p.y + p.ny * oa, p.x + p.nx * ob, yb, p.y + p.ny * ob);
      if (worldU) uv.push(oa / vScale, s / vScale, ob / vScale, s / vScale); else uv.push(0, s / vScale, 1, s / vScale);
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
  ribbon(main, () => -half, () => half, 0, 0, 170, new THREE.MeshStandardMaterial({ map: tex.road, roughness: 0.82,
    normalMap: tex.roadN, normalScale: new THREE.Vector2(0.45, 0.45) }));
  const curbMat = new THREE.MeshStandardMaterial({ map: tex.curb, roughness: 0.55, normalMap: tex.curbN, side: THREE.DoubleSide });
  const gd = groundDetail(track.theme);
  const vergeMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(...T.verge).multiplyScalar(0.95), roughness: 1, side: THREE.DoubleSide,
    map: gd.map, normalMap: gd.normal, normalScale: new THREE.Vector2(0.7, 0.7) });
  const wallMat = new THREE.MeshStandardMaterial({ map: tex.wall, roughness: 0.8, normalMap: tex.wallN, side: THREE.DoubleSide });
  for (const sgn of [1, -1]) {
    const curbAt = k => { const p = main.pts[k]; return [p.x + p.nx * sgn * (half + 8), p.y + p.ny * sgn * (half + 8)]; };
    ribbon(main, () => sgn * half, () => sgn * (half + 16), 0.5, 0.3, 64, curbMat,
      k => !onOtherSurface(main, ...curbAt(k)) && !onOtherSurface(main, ...curbAt((k + 1) % main.N)));
    ribbon(main, () => sgn * (half + 16), k => sgn * (sgn > 0 ? main.pts[k].wp : main.pts[k].wn), 0.15, 0.15, 160, vergeMat, null, true);
    barrier(main, sgn, 18, wallMat, 90);
  }
  // shortcuts: dirt roads with wooden fences, drawn only where they leave the main road
  const dirtMat = new THREE.MeshStandardMaterial({ map: tex.dirt, roughness: 1, normalMap: tex.dirtN });
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

  // scenery (instanced): irregular trees with colour variation, bushes, rocks
  {
    const r = rng(track.idx * 977 + 13), b = track.bounds, pad = 1300, want = Math.round((isTouch ? 260 : 520) * Q.trees);
    const spots = [];
    for (let tries = 0; tries < 9000 && spots.length < want; tries++) {
      const x = b.minX - pad + r() * (b.maxX - b.minX + pad * 2), z = b.minY - pad + r() * (b.maxY - b.minY + pad * 2);
      const H = heightAt(x, z);
      if (H.cl < 50) continue;
      if (T.sea && H.h < 2) continue;
      if (stands.some(s => Math.hypot(s.x - x, s.y - z) < 180)) continue;
      spots.push({ x, z, h: H.h, s: 0.7 + r() * 0.8, rot: r() * 6.28, rock: r() < 0.16, v: r() });
    }
    const bushes = [];
    for (let tries = 0; tries < 4000 && bushes.length < want * 0.5; tries++) {
      const x = b.minX - pad + r() * (b.maxX - b.minX + pad * 2), z = b.minY - pad + r() * (b.maxY - b.minY + pad * 2);
      const H = heightAt(x, z);
      if (H.cl < 25 || H.cl > 350 || (T.sea && H.h < 2)) continue;
      bushes.push({ x, z, h: H.h, s: 0.5 + r() * 0.7, rot: r() * 6.28, v: r() });
    }
    const dummy = new THREE.Object3D();
    const inst = (geo, mat, list, place, tint) => {
      if (!list.length) return;
      const m = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((sp, i) => { place(dummy, sp); dummy.updateMatrix(); m.setMatrixAt(i, dummy.matrix); if (tint) m.setColorAt(i, tint(sp)); });
      m.castShadow = true; m.receiveShadow = true; scene.add(m);
    };
    const shade = (hex, sp, amt = 0.35) => new THREE.Color(hex).multiplyScalar(1 - amt / 2 + sp.v * amt);
    const plants = spots.filter(s => !s.rock), rocks = spots.filter(s => s.rock);
    const bark = new THREE.MeshStandardMaterial({ color: 0x5a3d26, roughness: 1 });
    const leaf = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
    if (T.flora === 'pine') {
      const tiers = [];
      for (let i = 0; i < 5; i++) { const rad = 24 - i * 4.2, hh = 34 - i * 3; tiers.push(new THREE.ConeGeometry(rad, hh, 9, 2).translate(0, 22 + i * 15 + hh / 2, 0)); }
      const crown = jitter(mergeGeos(tiers), 3.2, 4);
      inst(new THREE.CylinderGeometry(2, 3.6, 40, 7).translate(0, 20, 0), bark, plants, (d, s) => { d.position.set(s.x, s.h, s.z); d.scale.setScalar(s.s); d.rotation.set(0, s.rot, 0); });
      inst(crown, leaf, plants, (d, s) => { d.position.set(s.x, s.h, s.z); d.scale.set(s.s, s.s * (0.9 + s.v * 0.3), s.s); d.rotation.set(0, s.rot, 0); }, sp => shade(0x2c5e30, sp));
    } else if (T.flora === 'round') {
      const blobs = [[0, 46, 0, 20], [11, 40, 5, 15], [-10, 41, -4, 16], [3, 56, -6, 14], [-4, 38, 11, 13]].map(([x, y, z, rad]) => new THREE.IcosahedronGeometry(rad, 2).translate(x, y, z));
      const crown = jitter(mergeGeos(blobs), 2.6, 6);
      inst(new THREE.CylinderGeometry(2.4, 4, 40, 7).translate(0, 20, 0), bark, plants, (d, s) => { d.position.set(s.x, s.h, s.z); d.scale.setScalar(s.s); });
      inst(crown, leaf, plants, (d, s) => { d.position.set(s.x, s.h, s.z); d.scale.set(s.s, s.s * (0.85 + s.v * 0.3), s.s); d.rotation.y = s.rot; }, sp => shade(0x3c7a35, sp));
    } else {
      const parts = [new THREE.CylinderGeometry(5, 6, 58, 12).translate(0, 29, 0), new THREE.SphereGeometry(5, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 58, 0)];
      for (const [side, hy, len] of [[1, 24, 20], [-1, 32, 16]]) {
        parts.push(new THREE.CylinderGeometry(3.4, 3.4, 10, 10).rotateZ(Math.PI / 2).translate(side * 9, hy, 0));
        parts.push(new THREE.CylinderGeometry(3.4, 3.4, len, 10).translate(side * 13, hy + len / 2, 0));
        parts.push(new THREE.SphereGeometry(3.4, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2).translate(side * 13, hy + len, 0));
      }
      const cactus = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75 });
      inst(mergeGeos(parts), cactus, plants, (d, s) => { d.position.set(s.x, s.h, s.z); d.scale.setScalar(s.s); d.rotation.y = s.rot; }, sp => shade(0x4b7f3a, sp, 0.3));
    }
    const bushGeo = jitter(mergeGeos([[0, 6, 0, 9], [7, 5, 3, 7], [-6, 5, -2, 7]].map(([x, y, z, rad]) => new THREE.IcosahedronGeometry(rad, 1).translate(x, y, z))), 1.6, 8);
    const bushCol = track.theme === 'desert' ? 0x8a8a4a : track.theme === 'canyon' ? 0x4f6b2e : 0x3f7a35;
    inst(bushGeo, leaf, bushes, (d, s) => { d.position.set(s.x, s.h - 1, s.z); d.scale.set(s.s, s.s * 0.8, s.s); d.rotation.y = s.rot; }, sp => shade(bushCol, sp));
    const rockGeo = jitter(new THREE.IcosahedronGeometry(18, 1), 5, 10);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, normalMap: tex.wallN, normalScale: new THREE.Vector2(2, 2) });
    inst(rockGeo, rockMat, rocks, (d, s) => { d.position.set(s.x, s.h + 4, s.z); d.scale.set(s.s * 1.5, s.s * 0.9, s.s * 1.2); d.rotation.set(s.rot * 0.3, s.rot, 0); }, sp => shade(new THREE.Color(...T.rock), sp, 0.4));
  }

  // crowd position for audio
  const crowdAt = stands.length ? stands : [{ x: track.pts[0].x, y: track.pts[0].y }];

  // distant mountain ring so the horizon isn't empty
  {
    const b = track.bounds, cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2, r0 = Math.max(b.maxX - b.minX, b.maxY - b.minY) / 2 + 4200;
    const fogC = new THREE.Color(SK.cfg.fog), rockC = new THREE.Color(...T.rock);
    const rr = rng(trackIdx * 7 + 3), geo = jitter(new THREE.IcosahedronGeometry(1, 2), 0.25, 12);
    const n = 46, inst = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ fog: false }), n), d = new THREE.Object3D();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rr() * 0.1, rad = r0 + rr() * 1500, hgt = 500 + rr() * (track.theme === 'harbor' ? 500 : 1300), wid = 900 + rr() * 1400;
      d.position.set(cx + Math.cos(a) * rad, -60, cz + Math.sin(a) * rad); d.scale.set(wid, hgt, wid * 0.8); d.rotation.y = rr() * 3; d.updateMatrix();
      inst.setMatrixAt(i, d.matrix);
      inst.setColorAt(i, rockC.clone().lerp(fogC, 0.55 + rr() * 0.25));
    }
    inst.renderOrder = -1;
    scene.add(inst);
  }

  const grass = addGrass(scene, track, heightAt);
  const update = (dt, camera, t) => {
    if (SK.sky) SK.sky.position.copy(camera.position);
    if (clouds) { clouds.position.x = camera.position.x; clouds.position.z = camera.position.z; clouds.material.map.offset.x = t * 0.004; clouds.material.map.offset.y = t * 0.0015 - camera.position.z / 26000 * 5; clouds.material.map.offset.x += camera.position.x / 26000 * 5; }
    if (flare) flare.position.copy(camera.position).addScaledVector(SK.sunDir, 6000);
    const w = scene.userData.water;
    if (w && w.material.uniforms && w.material.uniforms.time) w.material.uniforms.time.value = t * 0.6;
    if (grass) grass.material.userData.shader && (grass.material.userData.shader.uniforms.uTime.value = t);
  };
  return { scene, track, sun, sunOff, heightAt, crowdAt, theme: T, update, sunDir: SK.sunDir };
}

// ---------- cars ----------
// Sports-car body from extruded side profiles with rounded (bevelled) edges.
const ext = (shape, depth, bevel, segs = 4) => {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.9, bevelSegments: segs, curveSegments: 18 });
  g.translate(0, 0, -depth / 2); g.computeVertexNormals();
  return g;
};
const BODY = (() => {
  const s = new THREE.Shape();
  s.moveTo(-27.2, 3); s.lineTo(24.5, 3);
  s.quadraticCurveTo(28.4, 3.2, 28.4, 6);
  s.quadraticCurveTo(28.2, 8.6, 22.5, 9.6);
  s.quadraticCurveTo(14, 11, 7, 11.4);
  s.lineTo(-14, 11.9);
  s.quadraticCurveTo(-23.5, 12.1, -27.2, 11.2);
  s.quadraticCurveTo(-28.3, 8.4, -27.6, 4.6);
  s.lineTo(-27.2, 3);
  return ext(s, 21, 1.6, 5);
})();
const CABIN = (() => {
  const s = new THREE.Shape();
  s.moveTo(8, 11.1); s.quadraticCurveTo(2, 16.4, -3, 17.1);
  s.lineTo(-11, 16.9); s.quadraticCurveTo(-17.5, 16.2, -21, 11.8);
  s.lineTo(8, 11.1);
  return ext(s, 15.4, 1.5, 4);
})();
const ROOF = (() => {
  const s = new THREE.Shape();
  s.moveTo(-1.6, 16.8); s.quadraticCurveTo(-2.8, 17.5, -4, 17.5); s.lineTo(-11, 17.35); s.lineTo(-12, 16.85); s.lineTo(-1.6, 16.8);
  return ext(s, 14, 1.1, 3);
})();
const ARCH = new THREE.TorusGeometry(5.9, 1.15, 8, 18, Math.PI);
const TYRE = new THREE.LatheGeometry([[3.2, -2.3], [4.45, -2.3], [4.85, -1.9], [4.98, 0], [4.85, 1.9], [4.45, 2.3], [3.2, 2.3]].map(([x, y]) => new THREE.Vector2(x, y)), 28).rotateX(Math.PI / 2);
const RIM = new THREE.CylinderGeometry(3.25, 3.25, 4.0, 24, 1, true).rotateX(Math.PI / 2);
const HUB = new THREE.CylinderGeometry(0.95, 0.95, 4.3, 12).rotateX(Math.PI / 2);
const DISC = new THREE.CylinderGeometry(2.7, 2.7, 0.7, 20).rotateX(Math.PI / 2);
const SPOKE = new THREE.BoxGeometry(0.75, 2.8, 0.6);

const MAT = {
  tyre: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.85 }),
  rim: new THREE.MeshStandardMaterial({ color: 0xc8ccd2, metalness: 0.9, roughness: 0.22 }),
  disc: new THREE.MeshStandardMaterial({ color: 0x55575c, metalness: 0.7, roughness: 0.45 }),
  caliper: new THREE.MeshStandardMaterial({ color: 0xd4201b, roughness: 0.4 }),
  glass: new THREE.MeshPhysicalMaterial({ color: 0x0c1218, metalness: 0.1, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.6 }),
  trim: new THREE.MeshStandardMaterial({ color: 0x17171a, roughness: 0.55, metalness: 0.2 }),
  carbon: new THREE.MeshStandardMaterial({ color: 0x1c1c20, roughness: 0.3, metalness: 0.5 }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 1, roughness: 0.15 }),
  head: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 1.4, roughness: 0.1 }),
};
let shadowTex = null;
function contactShadowTex() {
  if (shadowTex) return shadowTex;
  return shadowTex = canvasTex(128, 128, (g, w, h) => {
    const gr = g.createRadialGradient(64, 64, 8, 64, 64, 64);
    gr.addColorStop(0, 'rgba(0,0,0,.75)'); gr.addColorStop(0.55, 'rgba(0,0,0,.35)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  }, false);
}
function numberTex(num, color) {
  return canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = '#f4f4f0'; g.beginPath(); g.arc(64, 64, 58, 0, 7); g.fill();
    g.lineWidth = 6; g.strokeStyle = '#111'; g.stroke();
    g.fillStyle = '#111'; g.font = '900 70px Inter, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(num, 64, 68);
  }, false);
}

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
  const paint = Q.post
    ? new THREE.MeshPhysicalMaterial({ color, metalness: 0.45, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.05 })
    : new THREE.MeshStandardMaterial({ color, metalness: 0.5, roughness: 0.3 });
  const add = (geo, mat, x = 0, y = 0, z = 0, parent = body) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  };
  add(BODY, paint);
  add(CABIN, MAT.glass);
  add(ROOF, paint);
  // wheel-arch lips
  for (const [x, z] of [[17.5, 12.2], [17.5, -12.2], [-17.5, 12.2], [-17.5, -12.2]]) add(ARCH, paint, x, 4.95, z);
  // lower trim: skirts, splitter, diffuser, grille
  add(new THREE.BoxGeometry(36, 1.5, 24.8), MAT.trim, 0, 3.4, 0);
  add(new THREE.BoxGeometry(3, 0.8, 23), MAT.carbon, 28, 2.9, 0);
  // rear diffuser with fins, front grille
  add(new THREE.BoxGeometry(2.4, 2.4, 17), MAT.carbon, -28.8, 3.9, 0);
  for (const z of [-5, -1.7, 1.7, 5]) add(new THREE.BoxGeometry(2.6, 2.4, 0.5), MAT.trim, -29.2, 3.9, z);
  add(new THREE.BoxGeometry(1.2, 1.5, 16), MAT.carbon, 29.6, 4.7, 0);
  // lights
  for (const z of [7.6, -7.6]) { const h = add(new THREE.BoxGeometry(5, 1.2, 5.8), MAT.head, 25.6, 9.9, z); h.rotation.z = -0.24; h.castShadow = false; }
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1810, emissiveIntensity: 0.5, roughness: 0.2 });
  // tail-light clusters joined by a thin light bar, plus a dark rear panel
  add(new THREE.BoxGeometry(0.9, 5.4, 22), MAT.trim, -28.75, 7.6, 0).castShadow = false;
  for (const z of [8.2, -8.2]) add(new THREE.BoxGeometry(1, 1.6, 5.4), tailMat, -29.0, 9.2, z);
  add(new THREE.BoxGeometry(1, 0.45, 11), tailMat, -29.0, 9.6, 0);
  // mirrors, wing, exhausts
  for (const z of [11.6, -11.6]) add(new THREE.BoxGeometry(2.4, 1.5, 2.2), paint, 6.5, 12.9, z);
  add(new THREE.BoxGeometry(5.5, 0.7, 24), MAT.carbon, -24.8, 16.4, 0);
  for (const z of [7, -7]) add(new THREE.BoxGeometry(1.6, 4.6, 0.8), MAT.carbon, -24.3, 13.9, z);
  for (const z of [3, -3]) add(new THREE.CylinderGeometry(1, 1, 2.6, 14).rotateZ(Math.PI / 2), MAT.chrome, -29.8, 4.2, z);
  // race number on both doors
  let h = 0; for (const ch of String(name || color)) h = (h * 31 + ch.charCodeAt(0)) % 97;
  const numMat = new THREE.MeshStandardMaterial({ map: numberTex(String(h + 2), color), roughness: 0.4, transparent: true, polygonOffset: true, polygonOffsetFactor: -2 });
  for (const z of [1, -1]) { const d = add(new THREE.PlaneGeometry(6.4, 6.4), numMat, -1, 7.3, z * 12.15); d.rotation.y = z > 0 ? 0 : Math.PI; d.castShadow = false; }

  // wheels: lathe-turned tyre, spoked rim, brake disc and caliper
  const wheels = [];
  for (const [x, z, front] of [[17.5, 11.6, 1], [17.5, -11.6, 1], [-17.5, 11.6, 0], [-17.5, -11.6, 0]]) {
    const steerG = new THREE.Group(); steerG.position.set(x, 4.98, z); root.add(steerG);
    const spinG = new THREE.Group(); steerG.add(spinG);
    const t = new THREE.Mesh(TYRE, MAT.tyre); t.castShadow = true; spinG.add(t);
    spinG.add(new THREE.Mesh(RIM, MAT.rim), new THREE.Mesh(HUB, MAT.rim));
    for (let i = 0; i < 5; i++) {
      for (const face of [1.75, -1.75]) {
        const sp = new THREE.Mesh(SPOKE, MAT.rim); sp.position.set(Math.sin(i * 1.2566) * 1.65, Math.cos(i * 1.2566) * 1.65, face); sp.rotation.z = -i * 1.2566; spinG.add(sp);
      }
    }
    steerG.add(new THREE.Mesh(DISC, MAT.disc));
    const cal = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.6, 1.6), MAT.caliper); cal.position.set(-1.9, 1.2, z > 0 ? -0.6 : 0.6); steerG.add(cal);
    wheels.push({ steerG, spinG, front });
  }

  // soft contact shadow that stays on the ground
  const cs = new THREE.Mesh(new THREE.PlaneGeometry(74, 38).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: contactShadowTex(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, opacity: 0.85 }));
  cs.position.y = 0.4; cs.renderOrder = 2; root.add(cs);

  const shield = new THREE.Mesh(new THREE.SphereGeometry(34, 24, 16),
    new THREE.MeshStandardMaterial({ color: 0x5ac8ff, emissive: 0x2a88cc, emissiveIntensity: 1.2, transparent: true, opacity: 0.22, depthWrite: false }));
  shield.position.y = 10; shield.visible = false; root.add(shield);
  const flame = new THREE.Group();
  for (const z of [3, -3]) {
    const f = new THREE.Mesh(new THREE.ConeGeometry(2.2, 14, 10).rotateZ(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xff9a2a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    f.position.set(-37, 4.2, z); flame.add(f);
  }
  flame.visible = false; root.add(flame);

  if (name) root.add(nameSprite(name));
  return { root, body, wheels, tailMat, shield, flame, shadow: cs, spin: 0 };
}

export function poseCar(m, s, dt) {
  // s: {x, y, z, a, sp, steer, roll, pitch, braking, boost, shield}
  const z = s.z || 0;
  m.root.position.set(s.x, z, s.y);
  m.root.rotation.y = -s.a;
  m.body.rotation.x = s.roll || 0;
  m.body.rotation.z = s.pitch || 0;
  m.spin -= (s.sp * dt) / 4.98;
  for (const w of m.wheels) {
    w.spinG.rotation.z = m.spin;
    if (w.front) w.steerG.rotation.y = -(s.steer || 0) * 0.45;
  }
  m.shadow.position.y = -z + 0.4;
  m.shadow.material.opacity = 0.85 * Math.max(0, 1 - z / 70);
  m.shadow.scale.setScalar(1 + z / 90);
  m.tailMat.emissiveIntensity = s.braking ? 3.2 : 0.5;
  m.shield.visible = !!s.shield;
  m.flame.visible = !!s.boost;
  if (s.boost) m.flame.scale.set(0.7 + Math.random() * 0.6, 1, 1);
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
