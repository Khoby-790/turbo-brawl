// Rendering quality presets, the post-processing chain and the physically based sky.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';

export const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

export const PRESETS = {
  low:    { pr: 1,   shadow: 1024, post: false, bloom: false, ao: false, aa: 'none', grass: 0,     trees: 0.55, water: false, flare: false, clouds: false, sky: false },
  medium: { pr: 1.25, shadow: 2048, post: true,  bloom: true,  ao: false, aa: 'fxaa', grass: 5000,  trees: 0.8,  water: false, flare: false, clouds: true,  sky: true },
  high:   { pr: 1.5, shadow: 2048, post: true,  bloom: true,  ao: false, aa: 'smaa', grass: 16000, trees: 1,    water: true,  flare: true,  clouds: true,  sky: true },
  ultra:  { pr: 2,   shadow: 4096, post: true,  bloom: true,  ao: true,  aa: 'smaa', grass: 32000, trees: 1.25, water: true,  flare: true,  clouds: true,  sky: true },
};

export function loadQuality() {
  let q = null;
  try { q = localStorage.getItem('tb_gfx'); } catch {}
  if (!PRESETS[q]) q = isTouch ? 'low' : 'high';
  return q;
}
export function saveQuality(q) { try { localStorage.setItem('tb_gfx', q); } catch {} }

export const Q = PRESETS[loadQuality()];
export const QNAME = loadQuality();

// Final grading pass: contrast/saturation/warmth, vignette, speed blur, slight lens fringe, grain.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, time: { value: 0 }, speed: { value: 0 },
    tint: { value: new THREE.Vector3(1.03, 1.0, 0.96) }, contrast: { value: 1.08 }, saturation: { value: 1.1 },
    vignette: { value: 0.3 }, grain: { value: 0.018 },
  },
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float time, speed, contrast, saturation, vignette, grain; uniform vec3 tint;
    varying vec2 vUv;
    float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 c = vUv - 0.5; float r = length(c);
      // radial speed blur, stronger toward the edges
      vec3 col = vec3(0.0); float amt = speed * 0.035 * smoothstep(0.15, 0.75, r);
      for (int i = 0; i < 8; i++) { float t = float(i) / 7.0; col += texture2D(tDiffuse, vUv - c * amt * t).rgb; }
      col /= 8.0;
      // lens fringe at the edges
      float ca = 0.0025 * r * r * (1.0 + speed);
      col.r = mix(col.r, texture2D(tDiffuse, vUv - c * ca).r, 0.6);
      col.b = mix(col.b, texture2D(tDiffuse, vUv + c * ca).b, 0.6);
      col *= tint;
      col = (col - 0.5) * contrast + 0.5;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, saturation);
      col *= 1.0 - vignette * smoothstep(0.35, 0.85, r);
      col += (rand(vUv * 913.0 + time) - 0.5) * grain;
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
};

export function makeComposer(renderer, scene, camera, W, H) {
  if (!Q.post) return null;
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 0 }));
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  let ao = null;
  if (Q.ao) {
    ao = new GTAOPass(scene, camera, W, H);
    ao.output = GTAOPass.OUTPUT.Default;
    ao.blendIntensity = 0.9;
    ao.updateGtaoMaterial({ radius: 6, distanceExponent: 1.5, thickness: 2, scale: 1.2, samples: 12 });
    composer.addPass(ao);
  }
  let bloom = null;
  if (Q.bloom) { bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.32, 0.55, 0.88); composer.addPass(bloom); }
  composer.addPass(new OutputPass());
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  let fxaa = null;
  if (Q.aa === 'smaa') composer.addPass(new SMAAPass(W * renderer.getPixelRatio(), H * renderer.getPixelRatio()));
  else if (Q.aa === 'fxaa') { fxaa = new ShaderPass(FXAAShader); composer.addPass(fxaa); }
  const setSize = (w, h) => {
    composer.setSize(w, h);
    if (fxaa) fxaa.material.uniforms.resolution.value.set(1 / (w * renderer.getPixelRatio()), 1 / (h * renderer.getPixelRatio()));
  };
  setSize(W, H);
  return {
    composer, grade, renderPass, ao, setSize,
    setScene(s) { renderPass.scene = s; if (ao) ao.scene = s; },
  };
}

// ---------- sky ----------
const SKY = {
  canyon: { elev: 14, azim: 205, turbidity: 6, rayleigh: 1.6, mie: 0.006, g: 0.8, exposure: 0.55, fog: 0xe2c9a6, tint: [1.06, 1.0, 0.93] },
  harbor: { elev: 30, azim: 320, turbidity: 2.2, rayleigh: 2.4, mie: 0.003, g: 0.8, exposure: 0.3, fog: 0x9dbdd6, tint: [1.02, 1.0, 0.98], fogNear: 3600 },
  alpine: { elev: 24, azim: 'auto', turbidity: 1.8, rayleigh: 1.6, mie: 0.003, g: 0.8, exposure: 0.36, fog: 0xc5d3e4, tint: [0.97, 1.0, 1.05], fogNear: 3200 },
  beach: { elev: 26, azim: 'auto', turbidity: 2.4, rayleigh: 2.2, mie: 0.004, g: 0.8, exposure: 0.33, fog: 0xa6cbe0, tint: [1.04, 1.0, 0.96], fogNear: 3400 },
  city: { elev: 2.5, azim: 'auto', turbidity: 7, rayleigh: 3, mie: 0.012, g: 0.92, exposure: 0.85, fog: 0x6f5a6e, tint: [1.06, 0.96, 1.04], fogNear: 1800 },
  desert: { elev: 9, azim: 250, turbidity: 9, rayleigh: 2.2, mie: 0.008, g: 0.85, exposure: 0.55, fog: 0xe9c79a, tint: [1.08, 0.99, 0.9] },
};
export const skyInfo = theme => SKY[theme];

// Adds a scattering sky (or a simple gradient on Low), returns the sun direction.
export function addSky(scene, theme, renderer, startAng = 0) {
  const cfg = SKY[theme];
  // 'auto': put the sun behind (and a little to the side of) the starting straight
  const back = startAng + Math.PI + 0.5;
  const th = cfg.azim === 'auto' ? Math.atan2(Math.cos(back), Math.sin(back)) : THREE.MathUtils.degToRad(cfg.azim);
  const phi = THREE.MathUtils.degToRad(90 - cfg.elev);
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, th);
  let sky;
  if (Q.sky) {
    sky = new Sky();
    sky.scale.setScalar(9000);
    const u = sky.material.uniforms;
    u.turbidity.value = cfg.turbidity; u.rayleigh.value = cfg.rayleigh;
    u.mieCoefficient.value = cfg.mie; u.mieDirectionalG.value = cfg.g;
    u.sunPosition.value.copy(sunDir);
    sky.material.depthWrite = false;
    sky.renderOrder = -1;
    scene.add(sky);
    // image-based lighting from the same sky
    const pm = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const s2 = new Sky(); s2.scale.setScalar(9000); s2.material.uniforms = THREE.UniformsUtils.clone(u);
    s2.material.uniforms.sunPosition.value.copy(sunDir);
    envScene.add(s2);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(8000, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x4a4436 }));
    ground.position.y = -40; envScene.add(ground);
    scene.environment = pm.fromScene(envScene, 0.02).texture;
    scene.environmentIntensity = 0.85;
    pm.dispose();
  }
  scene.fog = new THREE.Fog(cfg.fog, cfg.fogNear || 2600, 9500);
  scene.userData.exposure = Q.sky ? cfg.exposure * 1.9 : 1.4;
  scene.userData.tint = cfg.tint;
  return { sky, sunDir, cfg };
}

export function addClouds(scene, theme) {
  if (!Q.clouds) return null;
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  const r = (() => { let s = 99; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  for (let i = 0; i < 160; i++) {
    const x = r() * 512, y = r() * 512, rad = 20 + r() * 70;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, `rgba(255,255,255,${0.12 + r() * 0.2})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    for (const ox of [-512, 0, 512]) for (const oy of [-512, 0, 512]) { g.save(); g.translate(ox, oy); g.beginPath(); g.arc(x, y, rad, 0, 7); g.fill(); g.restore(); }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(5, 5);
  const warm = theme === 'harbor' ? 0xffffff : 0xffe6cc;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(26000, 26000), new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false, fog: false, color: warm, opacity: theme === 'desert' ? 0.5 : 0.85 }));
  m.rotation.x = Math.PI / 2; m.position.y = 2200; m.renderOrder = -1;
  scene.add(m);
  return m;
}

export function addFlare(scene) {
  if (!Q.flare) return null;
  const tex = (draw) => { const c = document.createElement('canvas'); c.width = c.height = 128; draw(c.getContext('2d')); return new THREE.CanvasTexture(c); };
  const glow = tex(g => { const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,250,235,1)'); gr.addColorStop(0.2, 'rgba(255,230,180,.6)'); gr.addColorStop(1, 'rgba(255,200,120,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); });
  const ring = tex(g => { g.strokeStyle = 'rgba(255,220,160,.35)'; g.lineWidth = 6; g.beginPath(); g.arc(64, 64, 50, 0, 7); g.stroke(); });
  const dot = tex(g => { const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(160,200,255,.35)'); gr.addColorStop(1, 'rgba(160,200,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); });
  const lf = new Lensflare();
  lf.addElement(new LensflareElement(glow, 500, 0, new THREE.Color(1, 0.95, 0.85)));
  lf.addElement(new LensflareElement(dot, 60, 0.4));
  lf.addElement(new LensflareElement(ring, 120, 0.6));
  lf.addElement(new LensflareElement(dot, 90, 0.8));
  lf.addElement(new LensflareElement(dot, 40, 1.0));
  scene.add(lf);
  return lf; // caller keeps it at camera + sunDir * distance
}
