// Car models. Each type is built from extruded side profiles (rounded with bevels) plus
// shared parts: lathe-turned tyres, spoked rims with brake discs, lights, glass, paint.
import * as THREE from 'three';
import { Q } from './gfx.js';

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
// path: ['m',x,y] | ['l',x,y] | ['q',cx,cy,x,y]
function shape(path) {
  const s = new THREE.Shape();
  for (const p of path) {
    if (p[0] === 'm') s.moveTo(p[1], p[2]);
    else if (p[0] === 'l') s.lineTo(p[1], p[2]);
    else s.quadraticCurveTo(p[1], p[2], p[3], p[4]);
  }
  return s;
}
const geoCache = {};
function ext(key, path, depth, bevel, segs = 4) {
  if (geoCache[key]) return geoCache[key];
  const g = new THREE.ExtrudeGeometry(shape(path), { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.9, bevelSegments: segs, curveSegments: 18 });
  g.translate(0, 0, -depth / 2); g.computeVertexNormals();
  return (geoCache[key] = g);
}
const tyreGeo = (r, w) => geoCache['t' + r + w] || (geoCache['t' + r + w] = new THREE.LatheGeometry(
  [[r * 0.64, -w / 2], [r * 0.9, -w / 2], [r * 0.975, -w * 0.41], [r, 0], [r * 0.975, w * 0.41], [r * 0.9, w / 2], [r * 0.64, w / 2]].map(([x, y]) => new THREE.Vector2(x, y)), 28).rotateX(Math.PI / 2));

const MAT = {
  tyre: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.85 }),
  rim: new THREE.MeshStandardMaterial({ color: 0xc8ccd2, metalness: 0.9, roughness: 0.22 }),
  rimDark: new THREE.MeshStandardMaterial({ color: 0x2a2b30, metalness: 0.8, roughness: 0.35 }),
  disc: new THREE.MeshStandardMaterial({ color: 0x55575c, metalness: 0.7, roughness: 0.45 }),
  caliper: new THREE.MeshStandardMaterial({ color: 0xd4201b, roughness: 0.4 }),
  glass: new THREE.MeshPhysicalMaterial({ color: 0x0c1218, metalness: 0.1, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.6 }),
  trim: new THREE.MeshStandardMaterial({ color: 0x17171a, roughness: 0.55, metalness: 0.2 }),
  carbon: new THREE.MeshStandardMaterial({ color: 0x1c1c20, roughness: 0.3, metalness: 0.5 }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 1, roughness: 0.12 }),
  white: new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.35 }),
  head: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 0.55, roughness: 0.1 }),
  seat: new THREE.MeshStandardMaterial({ color: 0x222226, roughness: 0.8 }),
  engine: new THREE.MeshStandardMaterial({ color: 0x8a8d94, metalness: 0.8, roughness: 0.35 }),
};
let shadowTex = null;
const contactShadowTex = () => shadowTex || (shadowTex = canvasTex(128, 128, (g, w, h) => {
  const gr = g.createRadialGradient(64, 64, 8, 64, 64, 64);
  gr.addColorStop(0, 'rgba(0,0,0,.75)'); gr.addColorStop(0.55, 'rgba(0,0,0,.35)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
}));
const numberTex = num => canvasTex(128, 128, (g) => {
  g.fillStyle = '#f4f4f0'; g.beginPath(); g.arc(64, 64, 58, 0, 7); g.fill();
  g.lineWidth = 6; g.strokeStyle = '#111'; g.stroke();
  g.fillStyle = '#111'; g.font = '900 70px Inter, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(num, 64, 68);
});
function nameSprite(text, y) {
  const t = canvasTex(256, 64, (g, w, h) => {
    g.font = '700 30px Inter, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const tw = g.measureText(text).width + 24;
    g.fillStyle = 'rgba(0,0,0,.55)'; g.beginPath(); g.roundRect((w - tw) / 2, 10, tw, 44, 12); g.fill();
    g.fillStyle = '#fff'; g.fillText(text, w / 2, h / 2 + 1);
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, sizeAttenuation: false, depthWrite: false }));
  s.scale.set(0.16, 0.04, 1); s.position.y = y; s.renderOrder = 10;
  return s;
}
// a tube between two points (roll cages, bull bars)
function tube(a, b, r, mat) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), len = A.distanceTo(B);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), mat);
  m.position.copy(A).add(B).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  m.castShadow = true;
  return m;
}

// ---------- per-type designs ----------
// Each returns { wheels: [...], numberAt, nameY, shadowLen, exhaust: [[x,y,z]...] } after adding body parts.
const DESIGNS = {
  gt(add, paint) {
    add(ext('gt.body', [['m', -27.2, 3], ['l', 24.5, 3], ['q', 28.4, 3.2, 28.4, 6], ['q', 28.2, 8.6, 22.5, 9.6], ['q', 14, 11, 7, 11.4], ['l', -14, 11.9], ['q', -23.5, 12.1, -27.2, 11.2], ['q', -28.3, 8.4, -27.6, 4.6], ['l', -27.2, 3]], 21, 1.6, 5), paint);
    add(ext('gt.cab', [['m', 8, 11.1], ['q', 2, 16.4, -3, 17.1], ['l', -11, 16.9], ['q', -17.5, 16.2, -21, 11.8], ['l', 8, 11.1]], 15.4, 1.5), MAT.glass);
    add(ext('gt.roof', [['m', -1.6, 16.8], ['q', -2.8, 17.5, -4, 17.5], ['l', -11, 17.35], ['l', -12, 16.85], ['l', -1.6, 16.8]], 14, 1.1, 3), paint);
    add(new THREE.BoxGeometry(5.5, 0.7, 24), MAT.carbon, -24.8, 16.4, 0);
    for (const z of [7, -7]) add(new THREE.BoxGeometry(1.6, 4.6, 0.8), MAT.carbon, -24.3, 13.9, z);
    add(new THREE.BoxGeometry(2.4, 2.4, 17), MAT.carbon, -28.8, 3.9, 0);
    for (const z of [-5, -1.7, 1.7, 5]) add(new THREE.BoxGeometry(2.6, 2.4, 0.5), MAT.trim, -29.2, 3.9, z);
    add(new THREE.BoxGeometry(1.2, 1.5, 16), MAT.carbon, 29.6, 4.7, 0);
    add(new THREE.BoxGeometry(3, 0.8, 23), MAT.carbon, 28, 2.9, 0);
    add(new THREE.BoxGeometry(36, 1.5, 24.8), MAT.trim, 0, 3.4, 0);
    for (const z of [11.6, -11.6]) add(new THREE.BoxGeometry(2.4, 1.5, 2.2), paint, 6.5, 12.9, z);
    return { wheels: { fx: 17.5, rx: -17.5, z: 11.6, fr: 4.98, rr: 4.98, fw: 4.6, rw: 4.6, arch: 12.2 },
      head: [25.6, 9.9, 7.6, -0.24], tail: [-29, 9.2, 8.2, 11], tailPanel: [-28.75, 7.6, 5.4],
      numberAt: [-1, 7.3, 12.15], nameY: 34, shadowLen: 74, exhaust: [[-29.8, 4.2, 3], [-29.8, 4.2, -3]] };
  },
  muscle(add, paint) {
    add(ext('mu.body', [['m', -27, 3.4], ['l', 25.5, 3.4], ['q', 28.6, 3.6, 28.6, 6.4], ['l', 28.4, 10.2], ['q', 27.5, 11, 24, 11.2], ['l', 4, 11.8], ['l', -16, 12], ['l', -26.5, 12.6], ['q', -28.4, 12.7, -28.2, 9], ['l', -27.6, 4.6], ['l', -27, 3.4]], 22, 1.3, 4), paint);
    add(ext('mu.cab', [['m', 4, 11.6], ['q', -1, 16.8, -5, 17.3], ['l', -12, 17.1], ['q', -16, 16.6, -19.5, 11.9], ['l', 4, 11.6]], 16.4, 1.4), MAT.glass);
    add(ext('mu.roof', [['m', -4, 17], ['l', -12.4, 16.9], ['l', -13, 16.6], ['l', -3.4, 16.7], ['l', -4, 17]], 15.4, 1, 3), paint);
    add(new THREE.BoxGeometry(9, 2, 6.5), MAT.trim, 13, 12.7, 0); // hood scoop
    add(new THREE.BoxGeometry(0.6, 1.2, 5.5), MAT.carbon, 17.6, 12.9, 0);
    for (const z of [2.3, -2.3]) {
      add(new THREE.BoxGeometry(23, 0.25, 2.4), MAT.white, 15, 12.15, z);
      add(new THREE.BoxGeometry(7.6, 0.25, 2.4), MAT.white, -8.2, 18.15, z);
      add(new THREE.BoxGeometry(9, 0.25, 2.4), MAT.white, -21.5, 13.45, z);
    }
    add(new THREE.BoxGeometry(1.4, 2, 25), MAT.chrome, 29.6, 5.2, 0);
    add(new THREE.BoxGeometry(1.4, 2, 25), MAT.chrome, -28.9, 5.4, 0);
    add(new THREE.BoxGeometry(1.2, 3.2, 14), MAT.trim, 29.3, 8.2, 0); // grille
    add(new THREE.BoxGeometry(3, 0.8, 23), paint, -26, 13.4, 0); // ducktail lip
    for (const z of [11.8, -11.8]) add(new THREE.BoxGeometry(2.4, 1.6, 2.2), MAT.chrome, 3, 13, z);
    return { wheels: { fx: 17.5, rx: -17, z: 11.8, fr: 4.95, rr: 5.4, fw: 4.6, rw: 6.2, arch: 12.4, rim: 'dark' },
      head: [28.6, 8.4, 8.6, 0, 'round'], tail: [-29.2, 9.3, 7.8, 0], tailPanel: null,
      numberAt: [-2, 7.6, 12.6], nameY: 34, shadowLen: 74, exhaust: [[-29, 3.6, 7], [-29, 3.6, -7]] };
  },
  rally(add, paint) {
    add(ext('ra.body', [['m', -22, 4.2], ['l', 20, 4.2], ['q', 23.6, 4.4, 23.6, 7.2], ['q', 23.4, 10.2, 18, 11.2], ['l', 6, 12], ['l', -20, 12.4], ['q', -22.6, 12.4, -22.6, 9.2], ['l', -22.4, 5.4], ['l', -22, 4.2]], 21, 1.6, 4), paint);
    add(ext('ra.cab', [['m', 6, 11.8], ['q', 1, 17.8, -3, 18.8], ['l', -18.2, 18.8], ['q', -21.2, 18.6, -21.6, 12.2], ['l', 6, 11.8]], 17, 1.4), MAT.glass);
    add(ext('ra.roof', [['m', -2.2, 18.6], ['q', -3, 19.4, -4, 19.4], ['l', -18.6, 19.4], ['l', -19.6, 18.9], ['l', -2.2, 18.6]], 16, 1, 3), paint);
    add(new THREE.BoxGeometry(5, 1.5, 5), MAT.trim, -8, 20.6, 0); // roof vent
    add(new THREE.BoxGeometry(5, 0.7, 20), paint, -21.5, 20.4, 0); // hatch spoiler
    add(new THREE.BoxGeometry(1.6, 3, 20), MAT.white, -23.4, 7.4, 0); // rear bumper (white livery)
    add(new THREE.BoxGeometry(2.4, 1.2, 14), MAT.trim, 22.5, 12.3, 0); // light pod bar
    for (const z of [-5.4, -1.8, 1.8, 5.4]) {
      const l = add(new THREE.CylinderGeometry(1.5, 1.5, 1.1, 16).rotateZ(Math.PI / 2), MAT.head, 23.9, 12.6, z); l.castShadow = false;
    }
    for (const x of [11.5, -18.5]) for (const z of [11.6, -11.6]) add(new THREE.BoxGeometry(0.5, 4.4, 4.4), MAT.trim, x, 3.6, z); // mud flaps
    add(new THREE.BoxGeometry(22, 2.4, 0.3), MAT.white, 0, 8.6, 12.2); add(new THREE.BoxGeometry(22, 2.4, 0.3), MAT.white, 0, 8.6, -12.2);
    return { wheels: { fx: 14.5, rx: -14.5, z: 11.4, fr: 5.0, rr: 5.0, fw: 4.4, rw: 4.4, arch: 12.2, lift: 1.2, rim: 'white' },
      head: [21.4, 9.8, 7.4, -0.2], tail: [-23.7, 11, 8.4, 0], tailPanel: null,
      numberAt: [-3, 12.6, 12.25], nameY: 36, shadowLen: 62, exhaust: [[-23.4, 4.4, 6]] };
  },
  truck(add, paint) {
    add(ext('tr.body', [['m', -28, 6.4], ['l', 26, 6.4], ['q', 29.6, 6.6, 29.6, 9.4], ['l', 29.4, 14.2], ['q', 29, 15.4, 26, 15.6], ['l', 9, 16.2], ['l', 9, 11.4], ['l', -28, 11.4], ['l', -28, 6.4]], 23, 1.4, 3), paint);
    add(ext('tr.cab', [['m', 9, 15.8], ['q', 6.5, 23.2, 3.5, 23.8], ['l', -10, 23.8], ['l', -11, 15.6], ['l', 9, 15.8]], 19, 1.3), MAT.glass);
    add(ext('tr.roof', [['m', 3, 23.6], ['l', -10.3, 23.6], ['l', -10.4, 24.4], ['l', 2.6, 24.4], ['l', 3, 23.6]], 18.4, 1, 3), paint);
    add(new THREE.BoxGeometry(19, 1, 21), MAT.trim, -18.5, 11.8, 0); // bed floor
    for (const z of [11.3, -11.3]) add(new THREE.BoxGeometry(19, 5.6, 1.4), paint, -18.5, 14.3, z); // bed walls
    add(new THREE.BoxGeometry(1.4, 5.6, 23.8), paint, -28.2, 14.3, 0); // tailgate
    add(new THREE.BoxGeometry(1.4, 5.6, 23.8), paint, -9.6, 14.3, 0);
    for (const z of [10.6, -10.6]) {
      add(tube([-12, 17, z], [-12, 26, z * 0.9], 0.7, MAT.carbon));
    }
    add(tube([-12, 26, -9.5], [-12, 26, 9.5], 0.7, MAT.carbon));
    for (const z of [-6, -2, 2, 6]) { const l = add(new THREE.CylinderGeometry(1.2, 1.2, 1, 14).rotateZ(Math.PI / 2), MAT.head, -11.2, 27.2, z); l.castShadow = false; }
    // bull bar
    for (const z of [8, -8]) add(tube([31, 4, z], [31, 13, z], 0.8, MAT.chrome));
    add(tube([31, 13, -9], [31, 13, 9], 0.8, MAT.chrome)); add(tube([31.5, 7, -9], [31.5, 7, 9], 0.8, MAT.chrome));
    add(new THREE.BoxGeometry(1.2, 4.4, 16), MAT.trim, 29.9, 11.6, 0); // grille
    add(new THREE.BoxGeometry(44, 1.8, 24), MAT.trim, -2, 6.2, 0); // chassis rail
    for (const z of [12.2, -12.2]) add(new THREE.BoxGeometry(2.6, 2, 2.4), MAT.trim, 7, 18, z);
    return { wheels: { fx: 18.5, rx: -18.5, z: 12.4, fr: 7.0, rr: 7.0, fw: 6, rw: 6, arch: 13.4, archR: 8.2, rim: 'dark', lift: 0 },
      head: [29.2, 12.8, 8.4, 0], tail: [-29, 13.6, 10.4, 0, 'vertical'], tailPanel: null,
      numberAt: [-1, 11.6, 12.85], nameY: 44, shadowLen: 80, exhaust: [[-28.6, 5.2, 7]] };
  },
  proto(add, paint) {
    add(ext('pr.body', [['m', -30, 2.6], ['l', 27, 2.6], ['q', 31, 2.8, 31, 5], ['q', 30.5, 7, 24, 7.6], ['l', 10, 8.4], ['l', -14, 9.6], ['q', -26, 10, -30, 9], ['l', -30, 2.6]], 22, 1.4, 5), paint);
    for (const z of [8.6, -8.6]) add(ext('pr.fender', [['m', 12, 6], ['q', 18.5, 12.4, 25, 6], ['l', 12, 6]], 4.6, 1.2, 4), paint, 0, 0, z); // front wheel humps
    add(ext('pr.cano', [['m', 10, 8.2], ['q', 4, 14.2, -2, 14.6], ['l', -8, 14.4], ['q', -14, 13.6, -16, 9.4], ['l', 10, 8.2]], 10.4, 1.4), MAT.glass);
    add(ext('pr.fin', [['m', -6, 14.6], ['l', -28, 15.4], ['l', -29, 9.2], ['l', -14, 9.6], ['l', -6, 14.6]], 0.6, 0.3, 2), paint);
    add(new THREE.BoxGeometry(6, 0.8, 26), MAT.carbon, -28, 16.6, 0); // big wing
    for (const z of [12.6, -12.6]) add(new THREE.BoxGeometry(7, 5, 0.6), MAT.carbon, -28, 14.6, z); // endplates
    for (const z of [4, -4]) add(new THREE.BoxGeometry(2, 6, 0.7), MAT.carbon, -27, 12.6, z);
    add(new THREE.BoxGeometry(4, 0.6, 26), MAT.carbon, 30, 2.4, 0); // splitter
    add(new THREE.BoxGeometry(3, 2.6, 18), MAT.carbon, -30.6, 4, 0);
    for (const z of [-5, -1.7, 1.7, 5]) add(new THREE.BoxGeometry(3, 2.6, 0.5), MAT.trim, -31, 4, z);
    return { wheels: { fx: 18.5, rx: -19, z: 11.2, fr: 4.6, rr: 4.8, fw: 4.4, rw: 5.2, arch: 0, rim: 'dark' },
      head: [26.8, 6.8, 7.6, -0.35], tail: [-30.6, 8.2, 0, 22], tailPanel: null,
      numberAt: [-4, 6.2, 12.3], nameY: 30, shadowLen: 80, exhaust: [[-31.2, 7.4, 0]] };
  },
  buggy(add, paint) {
    add(new THREE.BoxGeometry(36, 2, 16), MAT.trim, -2, 6, 0); // pan
    add(ext('bu.nose', [['m', 4, 5], ['l', 22, 5], ['q', 25, 5.4, 25, 8], ['l', 24, 9.4], ['l', 4, 11.6], ['l', 4, 5]], 15, 1.4, 4), paint);
    add(new THREE.BoxGeometry(6, 7, 8), MAT.seat, -4, 10, 0); // seat
    add(new THREE.SphereGeometry(3.4, 18, 12), paint, -3.2, 17.4, 0); // helmet
    add(new THREE.BoxGeometry(1.2, 2, 4.8), MAT.glass, -0.2, 17.6, 0); // visor
    add(new THREE.CylinderGeometry(2.4, 3, 4, 12), MAT.white, -3.4, 13.6, 0); // driver body
    add(new THREE.BoxGeometry(9, 7, 11), MAT.engine, -16, 10, 0); // engine
    for (const z of [3, -3]) add(new THREE.CylinderGeometry(0.9, 0.9, 7, 10), MAT.chrome, -20, 15, z);
    // roll cage
    const T = (a, b) => add(tube(a, b, 0.65, MAT.carbon));
    for (const z of [7.4, -7.4]) {
      T([6, 7, z], [1, 20, z * 0.8]); T([1, 20, z * 0.8], [-10, 20, z * 0.8]); T([-10, 20, z * 0.8], [-20, 7, z]);
      T([6, 7, z], [-20, 7, z]);
    }
    T([1, 20, -5.9], [1, 20, 5.9]); T([-10, 20, -5.9], [-10, 20, 5.9]);
    add(new THREE.BoxGeometry(2, 1.6, 12), MAT.trim, 1.6, 21.2, 0);
    for (const z of [-4, 0, 4]) { const l = add(new THREE.CylinderGeometry(1.1, 1.1, 1, 14).rotateZ(Math.PI / 2), MAT.head, 2.8, 21.6, z); l.castShadow = false; }
    add(new THREE.BoxGeometry(4, 0.6, 22), paint, -21, 19, 0); // small wing
    return { wheels: { fx: 17, rx: -16, z: 11.4, fr: 5.4, rr: 6.6, fw: 3.6, rw: 6.4, arch: 0, rim: 'white', lift: 0.4 },
      head: [24.4, 8.2, 4.6, 0, 'round'], tail: [-22, 8.6, 6.4, 0], tailPanel: null,
      numberAt: [12, 8.2, 8.95], nameY: 38, shadowLen: 70, exhaust: [[-20, 18.6, 3], [-20, 18.6, -3]] };
  },
};

export const CAR_TYPES = Object.keys(DESIGNS);

export function makeCarMesh(color, name, type = 'gt') {
  const design = DESIGNS[type] || DESIGNS.gt;
  const root = new THREE.Group(), body = new THREE.Group();
  root.add(body);
  const paint = Q.post
    ? new THREE.MeshPhysicalMaterial({ color, metalness: 0.45, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.05 })
    : new THREE.MeshStandardMaterial({ color, metalness: 0.5, roughness: 0.3 });
  const add = (geoOrMesh, mat, x = 0, y = 0, z = 0) => {
    const m = geoOrMesh.isMesh ? geoOrMesh : new THREE.Mesh(geoOrMesh, mat);
    if (!geoOrMesh.isMesh) m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true; body.add(m); return m;
  };
  const d = design(add, paint);
  const W = d.wheels;

  // lights
  const [hx, hy, hz, hr, hstyle] = d.head;
  for (const z of [hz, -hz]) {
    const h = hstyle === 'round'
      ? add(new THREE.CylinderGeometry(1.5, 1.5, 1, 16).rotateZ(Math.PI / 2), MAT.head, hx, hy, z)
      : add(new THREE.BoxGeometry(5, 1.2, 5.6), MAT.head, hx, hy, z);
    h.rotation.z += hr || 0; h.castShadow = false;
  }
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1810, emissiveIntensity: 0.5, roughness: 0.2 });
  const [tx, ty, tz, tbar, tstyle] = d.tail;
  if (d.tailPanel) add(new THREE.BoxGeometry(0.9, d.tailPanel[2], 22), MAT.trim, d.tailPanel[0], d.tailPanel[1], 0).castShadow = false;
  if (tz) for (const z of [tz, -tz]) add(tstyle === 'vertical' ? new THREE.BoxGeometry(1, 4.4, 2.2) : new THREE.BoxGeometry(1, 1.6, 5.4), tailMat, tx, ty, z);
  if (tbar) add(new THREE.BoxGeometry(1, tz ? 0.45 : 1, tbar), tailMat, tx, ty + (tz ? 0.4 : 0), 0);
  for (const [x, y, z] of d.exhaust) add(new THREE.CylinderGeometry(1, 1, 2.6, 14).rotateZ(Math.PI / 2), MAT.chrome, x, y, z);

  // wheel arches
  if (W.arch) {
    const ar = W.archR || W.fr + 0.9;
    const ARCH = new THREE.TorusGeometry(ar, 1.15, 8, 18, Math.PI);
    for (const [x, r] of [[W.fx, W.fr], [W.rx, W.rr]]) for (const s of [1, -1]) add(ARCH, paint, x, r + (W.lift || 0), s * W.arch);
  }
  // race number
  let h = 0; for (const ch of String(name || color)) h = (h * 31 + ch.charCodeAt(0)) % 97;
  const numMat = new THREE.MeshStandardMaterial({ map: numberTex(String(h + 2)), roughness: 0.4, transparent: true, polygonOffset: true, polygonOffsetFactor: -2 });
  for (const s of [1, -1]) {
    const n = add(new THREE.PlaneGeometry(6.4, 6.4), numMat, d.numberAt[0], d.numberAt[1], s * d.numberAt[2]);
    n.rotation.y = s > 0 ? 0 : Math.PI; n.castShadow = false;
  }

  // wheels
  const rimMat = W.rim === 'dark' ? MAT.rimDark : W.rim === 'white' ? MAT.white : MAT.rim;
  const wheels = [];
  for (const [x, front] of [[W.fx, 1], [W.rx, 0]]) for (const s of [1, -1]) {
    const r = front ? W.fr : W.rr, w = front ? W.fw : W.rw;
    const steerG = new THREE.Group(); steerG.position.set(x, r + (W.lift || 0), s * W.z); root.add(steerG);
    const spinG = new THREE.Group(); steerG.add(spinG);
    const t = new THREE.Mesh(tyreGeo(r, w), MAT.tyre); t.castShadow = true; spinG.add(t);
    spinG.add(new THREE.Mesh(new THREE.CylinderGeometry(r * 0.65, r * 0.65, w * 0.88, 24, 1, true).rotateX(Math.PI / 2), rimMat));
    spinG.add(new THREE.Mesh(new THREE.CylinderGeometry(r * 0.19, r * 0.19, w * 0.94, 12).rotateX(Math.PI / 2), rimMat));
    const spoke = new THREE.BoxGeometry(r * 0.15, r * 0.56, 0.6);
    for (let i = 0; i < 5; i++) for (const face of [w * 0.38, -w * 0.38]) {
      const sp = new THREE.Mesh(spoke, rimMat); sp.position.set(Math.sin(i * 1.2566) * r * 0.33, Math.cos(i * 1.2566) * r * 0.33, face); sp.rotation.z = -i * 1.2566; spinG.add(sp);
    }
    steerG.add(new THREE.Mesh(new THREE.CylinderGeometry(r * 0.54, r * 0.54, 0.7, 20).rotateX(Math.PI / 2), MAT.disc));
    const cal = new THREE.Mesh(new THREE.BoxGeometry(r * 0.44, r * 0.32, 1.6), MAT.caliper); cal.position.set(-r * 0.38, r * 0.24, s > 0 ? -0.6 : 0.6); steerG.add(cal);
    wheels.push({ steerG, spinG, front, r });
  }

  // soft contact shadow that stays on the ground
  const cs = new THREE.Mesh(new THREE.PlaneGeometry(d.shadowLen, 38).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: contactShadowTex(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, opacity: 0.85 }));
  cs.position.y = 0.4; cs.renderOrder = 2; root.add(cs);

  const shield = new THREE.Mesh(new THREE.SphereGeometry(36, 24, 16),
    new THREE.MeshStandardMaterial({ color: 0x5ac8ff, emissive: 0x2a88cc, emissiveIntensity: 1.2, transparent: true, opacity: 0.22, depthWrite: false }));
  shield.position.y = 12; shield.visible = false; root.add(shield);
  const flame = new THREE.Group();
  for (const [x, y, z] of d.exhaust) {
    const f = new THREE.Mesh(new THREE.ConeGeometry(2.2, 14, 10).rotateZ(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xff9a2a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    f.position.set(x - 7.5, y, z); flame.add(f);
  }
  flame.visible = false; root.add(flame);

  if (name) root.add(nameSprite(name, d.nameY));
  return { root, body, wheels, tailMat, shield, flame, shadow: cs, spin: 0, type };
}

export function poseCar(m, s, dt) {
  // s: {x, y, z, a, sp, steer, roll, pitch, braking, boost, shield}
  const z = s.z || 0;
  m.root.position.set(s.x, z, s.y);
  m.root.rotation.y = -s.a;
  m.body.rotation.x = s.roll || 0;
  m.body.rotation.z = s.pitch || 0;
  for (const w of m.wheels) {
    w.spinG.rotation.z -= (s.sp * dt) / w.r;
    if (w.front) w.steerG.rotation.y = -(s.steer || 0) * 0.45;
  }
  m.shadow.position.y = -z + 0.4;
  m.shadow.material.opacity = 0.85 * Math.max(0, 1 - z / 70);
  m.shadow.scale.setScalar(1 + z / 90);
  m.tailMat.emissiveIntensity = s.braking ? 3.2 : 0.5;
  // shield bubble (blue), or a fiery aura during Mega Turbo
  m.shield.visible = !!s.shield || !!s.mega;
  if (m.shield.visible) {
    const mat = m.shield.material;
    mat.color.set(s.mega ? 0xff8a2a : 0x5ac8ff); mat.emissive.set(s.mega ? 0xff5a10 : 0x2a88cc);
    mat.opacity = s.mega ? 0.1 + Math.random() * 0.06 : 0.22;
  }
  m.flame.visible = !!s.boost;
  if (s.boost) { const k = s.mega ? 1.25 : 1; m.flame.scale.set((0.7 + Math.random() * 0.6) * k, k, k); }
}
