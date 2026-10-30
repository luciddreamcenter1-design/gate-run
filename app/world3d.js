/* Gate Run 3D renderer (three.js / WebGL 2).
   Draws the world the 2D game simulates: game logic stays in index.html and works in
   screen pixels; this maps pixels to world units (K px = 1 unit) on the ground plane.
   If WebGL is unavailable, window.R3 is never set and the 2D canvas renderer runs. */
import * as THREE from './vendor/three.min.js';
const { EffectComposer, RenderPass, UnrealBloomPass, OutputPass } = THREE;

const K = 40;                                   // pixels per world unit
const wx = x => (x - W / 2) / K, wz = y => (y - H / 2) / K;
const hdr = (hex, k) => new THREE.Color(hex).multiplyScalar(k);
const CYAN = 0x38d6ff, VIOLET = 0x7c5cff, RED = 0xff4d6d, GOLD = 0xffd84a;

let renderer;
const canvas = document.createElement('canvas');
canvas.id = 'gl';
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  if (!renderer.capabilities.isWebGL2) throw new Error('WebGL 2 required');
} catch (e) {
  console.warn('3D off, using 2D renderer:', e.message);
  renderer = null;
}

if (renderer) {
  document.body.prepend(canvas);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.toneMapping = THREE.NeutralToneMapping;   // keeps the player's face colors true
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07060d);
  scene.fog = new THREE.FogExp2(0x0b0818, 0.028);
  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 250);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.45, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  scene.add(new THREE.HemisphereLight(0x6a5ad0, 0x07040f, 0.9));
  const moon = new THREE.DirectionalLight(0x9fb4ff, 0.7); moon.position.set(-6, 14, 8); scene.add(moon);
  const gateLight = new THREE.PointLight(VIOLET, 28, 26, 1.6); scene.add(gateLight);
  const heroLight = new THREE.PointLight(CYAN, 5, 6, 2); scene.add(heroLight);

  /* ---------- ground: grid, arena border, gate glow + ripples ---------- */
  const groundMat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: { uTime: { value: 0 }, uGate: { value: new THREE.Vector2() }, uArena: { value: new THREE.Vector2(5, 10) }, uOpen: { value: 1 }, uTint: { value: new THREE.Color(0x221a4a) }, uBack: { value: 0 } },
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      varying vec3 vW; uniform float uTime, uOpen, uBack; uniform vec2 uGate, uArena; uniform vec3 uTint;
      float grid(vec2 p, float w){ vec2 g = abs(fract(p - .5) - .5) / fwidth(p); return 1. - min(min(g.x, g.y) / w, 1.); }
      void main(){
        vec2 p = vW.xz;
        float dg = length((p - uGate) * vec2(1., 1.3));
        float glow = exp(-dg * .22) * uOpen;
        vec2 q = abs(p) - uArena; float box = max(q.x, q.y);
        float inside = 1. - smoothstep(-.2, .2, box);
        float border = 1. - smoothstep(0., .07, abs(box));
        vec3 col = vec3(.018, .014, .04) + uTint * .06;
        col += mix(vec3(.16, .11, .45), uTint * .9, .45) * grid(p, 1.2) * (.18 + .82 * glow) * (.3 + .7 * inside);
        col += vec3(.20, .15, .60) * grid(p / 4., 1.4) * .22;
        col += vec3(.30, .20, .95) * glow * .55;
        col += vec3(.35, .28, 1.2) * glow * .5 * smoothstep(.55, 1., sin(dg * 1.7 - uTime * 3.2));
        col += vec3(.5, 2.1, 2.8) * border * .55;
        float fade = exp(-length(p - cameraPosition.xz) * .03);
        float keep = 1. - uBack * smoothstep(1.5, 9., box);   // with an arena backdrop, the floor ends a little past the arena
        gl_FragColor = vec4(col * fade, keep);
      }`,
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(260, 260), groundMat);
  ground.rotation.x = -Math.PI / 2; scene.add(ground);

  /* ---------- night city skyline (instanced, emissive windows) ---------- */
  {
    const tc = document.createElement('canvas'); tc.width = 64; tc.height = 128; const x = tc.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, 64, 128);
    for (let r = 0; r < 32; r++) for (let c = 0; c < 8; c++) if (Math.random() < .32) {
      x.fillStyle = Math.random() < .7 ? `rgba(255,${190 + Math.random() * 40 | 0},130,${.5 + Math.random() * .5})` : 'rgba(120,220,255,.9)';
      x.fillRect(c * 8 + 2, r * 4 + 1, 4, 2);
    }
    const tex = new THREE.CanvasTexture(tc); tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = THREE.NearestFilter;
    const mat = new THREE.MeshStandardMaterial({ color: 0x0a0816, roughness: .9, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: .9 });
    const N = 90, city = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, N), m = new THREE.Matrix4();
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + Math.random() * .05, r = 34 + Math.random() * 40, w = 3 + Math.random() * 5, h = 8 + Math.random() * 30;
      m.compose(new THREE.Vector3(Math.cos(a) * r, h / 2, Math.sin(a) * r), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a), new THREE.Vector3(w, h, w));
      city.setMatrixAt(i, m);
    }
    scene.add(city); window.__city = city;
  }

  /* ---------- arena backdrop: a FLUX/LTX-made place (image, then its living LTX loop), cover-fit behind everything ---------- */
  let backTex = null, backVideo = null, backSize = [16, 9];
  const fitBack = () => {
    if (!backTex) return;
    const ia = backSize[0] / backSize[1], sa = W / H;
    backTex.repeat.set(sa < ia ? sa / ia : 1, sa < ia ? 1 : ia / sa);
    backTex.offset.set((1 - backTex.repeat.x) / 2, (1 - backTex.repeat.y) * .35);
  };
  const useBack = (t, w, h) => {
    t.colorSpace = THREE.SRGBColorSpace; backTex = t; backSize = [w, h]; fitBack();
    scene.background = t; groundMat.uniforms.uBack.value = 1; if (window.__city) window.__city.visible = false;
  };
  addEventListener('resize', () => setTimeout(fitBack, 0));
  window.setArena = ({ image, video, tint }) => {
    if (tint) { groundMat.uniforms.uTint.value.set(tint); scene.fog.color.set(tint).multiplyScalar(.22); }
    if (backVideo) { backVideo.pause(); backVideo.removeAttribute('src'); backVideo.load(); backVideo = null; }
    if (image) new THREE.TextureLoader().load(image, t => { if (!backVideo || !(backTex instanceof THREE.VideoTexture)) useBack(t, t.image.width, t.image.height); });
    if (video) {
      const v = document.createElement('video'); v.src = video; v.muted = true; v.loop = true; v.playsInline = true; v.crossOrigin = 'anonymous'; v.preload = 'auto';
      v.addEventListener('playing', () => { if (backVideo === v) useBack(new THREE.VideoTexture(v), v.videoWidth || 16, v.videoHeight || 9); }, { once: true });
      v.play().catch(() => {}); backVideo = v;
    }
  };

  /* ---------- the Gate: swirl shader portal, rim, debris, inflow sparks ---------- */
  const gate = new THREE.Group(); scene.add(gate);
  const portalMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uOpen: { value: 1 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: `
      varying vec2 vUv; uniform float uTime, uOpen;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
      float fbm(vec2 p){ float v = 0., a = .5; for (int i = 0; i < 5; i++){ v += a * n(p); p = p * 2.03 + 7.1; a *= .5; } return v; }
      void main(){
        vec2 p = (vUv - .5) * 2.;
        float r = length(p), a = atan(p.y, p.x);
        float sw = a + 2.2 / (r + .3) - uTime * 1.3;
        float f = fbm(vec2(cos(sw), sin(sw)) * (1.2 + r * 2.5) + vec2(r * 3. - uTime * .7, uTime * .2));
        float f2 = fbm(p * 3. + vec2(uTime * .4, -uTime * .3));
        vec3 col = mix(vec3(.04, .01, .18), vec3(.42, .26, 1.05), f * f * 1.4);
        col += vec3(.25, 1.3, 2.) * pow(f * f2 * 1.6, 3.);
        col += vec3(1.5, 1.7, 2.2) * pow(max(0., 1. - r), 7.) * .9;
        float rim = smoothstep(.78, .97, r) * smoothstep(1.02, .95, r);
        col += vec3(.4, 1.8, 2.6) * rim * (1.2 + .6 * sin(a * 9. + uTime * 5.));
        float alpha = smoothstep(1., .9, r + (f2 - .5) * .12) * uOpen;
        gl_FragColor = vec4(col * alpha, alpha);
      }`,
  });
  const portal = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), portalMat); gate.add(portal);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1, .035, 8, 96), new THREE.MeshBasicMaterial({ color: hdr(CYAN, 2.6) })); gate.add(rim);
  const debrisMat = new THREE.MeshStandardMaterial({ color: 0x1b1238, roughness: .85, flatShading: true, emissive: 0x150a3a });
  const debris = Array.from({ length: 14 }, (_, i) => {
    const d = new THREE.Mesh(new THREE.IcosahedronGeometry(.12 + Math.random() * .22, 0), debrisMat);
    d.userData = { a: i / 14 * Math.PI * 2, r: 1.25 + Math.random() * .5, s: .3 + Math.random() * .5, y: Math.random() * 6 };
    gate.add(d); return d;
  });

  /* ---------- soft additive point sprites (game particles + gate inflow) ---------- */
  const pointMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uScale: { value: 300 } },
    vertexShader: `attribute float size; attribute vec3 color; varying vec3 vC; uniform float uScale;
      void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position, 1.); gl_PointSize = size * uScale / -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying vec3 vC; void main(){ float d = length(gl_PointCoord - .5); float a = smoothstep(.5, 0., d); gl_FragColor = vec4(vC * a * a, a); }`,
  });
  function pointCloud(max) {
    const geo = new THREE.BufferGeometry();
    for (const [n, k] of [['position', 3], ['color', 3], ['size', 1]]) geo.setAttribute(n, new THREE.BufferAttribute(new Float32Array(max * k), k).setUsage(THREE.DynamicDrawUsage));
    const pts = new THREE.Points(geo, pointMat); pts.frustumCulled = false; scene.add(pts); return { pts, geo, max };
  }
  const sparks = pointCloud(4000), inflow = pointCloud(320);
  const inflowState = Array.from({ length: inflow.max }, () => ({ a: Math.random() * 6.283, r: Math.random(), v: .25 + Math.random() * .5 }));
  const colorCache = {};
  const col = c => colorCache[c] || (colorCache[c] = hdr(c, 2.4));

  /* ---------- hunter: coat, trims, legs, blade, and the player's face as the head ---------- */
  const hero = new THREE.Group(); hero.scale.setScalar(1.35); scene.add(hero);
  const coatMat = new THREE.MeshStandardMaterial({ color: 0x4a3aa8, roughness: .5, metalness: .15, emissive: 0x1a0f48 });
  const trim = new THREE.MeshBasicMaterial({ color: hdr(CYAN, 2.2) });
  const coat = new THREE.Mesh(new THREE.CylinderGeometry(.24, .44, .95, 12), coatMat); coat.position.y = .62; hero.add(coat);
  for (const [y, r] of [[.15, .44], [1.08, .245]]) { const t = new THREE.Mesh(new THREE.TorusGeometry(r, .025, 6, 24), trim); t.rotation.x = Math.PI / 2; t.position.y = y; hero.add(t); }
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(.04, .9, .02), trim); stripe.position.set(0, .62, .35); stripe.rotation.x = -.2; hero.add(stripe);
  const legs = [-.12, .12].map(x => { const l = new THREE.Mesh(new THREE.CylinderGeometry(.06, .06, .34, 6), new THREE.MeshStandardMaterial({ color: 0x15102e })); l.position.set(x, .12, 0); hero.add(l); return l; });
  const blade = new THREE.Mesh(new THREE.BoxGeometry(.05, 1.25, .02), new THREE.MeshBasicMaterial({ color: hdr(0x9fe8ff, 2.8) }));
  blade.position.set(0, 1.0, -.3); blade.rotation.z = .65; hero.add(blade);
  const headMat = new THREE.SpriteMaterial({ color: new THREE.Color(.86, .86, .86) });
  const head = new THREE.Sprite(headMat); head.scale.set(1.05, 1.05, 1); head.position.y = 1.62; hero.add(head);
  const shadowTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(0,0,0,.75)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = gr; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
  const blob = (s) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })); m.rotation.x = -Math.PI / 2; m.position.y = .01; return m; };
  hero.add(blob(1.3));
  const introHead = new THREE.Sprite(new THREE.SpriteMaterial({ color: new THREE.Color(.9, .9, .9) })); scene.add(introHead);

  let lastPortrait = null, faceTex = null;
  function syncFace() {
    if (portrait === lastPortrait) return;
    lastPortrait = portrait;
    const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
    x.save(); x.beginPath(); x.arc(128, 128, 118, 0, 6.283); x.clip(); if (portrait) x.drawImage(portrait, 10, 10, 236, 236); x.restore();
    x.lineWidth = 10; x.strokeStyle = '#38d6ff'; x.beginPath(); x.arc(128, 128, 120, 0, 6.283); x.stroke();
    faceTex?.dispose(); faceTex = new THREE.CanvasTexture(c); faceTex.colorSpace = THREE.SRGBColorSpace;
    headMat.map = faceTex; headMat.needsUpdate = true; introHead.material.map = faceTex; introHead.material.needsUpdate = true;
  }

  /* ---------- shadow monsters ---------- */
  const GEO = { imp: new THREE.IcosahedronGeometry(1, 0), brute: new THREE.DodecahedronGeometry(1, 0), boss: new THREE.IcosahedronGeometry(1, 1) };
  const eyeGeo = new THREE.SphereGeometry(.13, 8, 6), hornGeo = new THREE.ConeGeometry(.16, .7, 6);
  const eyeMat = new THREE.MeshBasicMaterial({ color: hdr(RED, 3) });
  const auraMat = new THREE.MeshBasicMaterial({ color: hdr(VIOLET, .7), transparent: true, opacity: .35, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false });
  const BODY = { imp: 0x5a2aa0, brute: 0x6a2a9a, boss: 0x2a1660 };
  const live = new Map();
  function enemyMesh(e) {
    const g = new THREE.Group(), body = new THREE.Mesh(GEO[e.type], new THREE.MeshStandardMaterial({ color: BODY[e.type], roughness: .5, flatShading: true, emissive: 0x2a0f5a }));
    g.add(body);
    for (const s of [-1, 1]) { const eye = new THREE.Mesh(eyeGeo, eyeMat); eye.position.set(s * .36, .18, .84); g.add(eye); }
    if (e.type !== 'imp') for (const s of [-1, 1]) { const h = new THREE.Mesh(hornGeo, body.material); h.position.set(s * .5, .85, .1); h.rotation.z = -s * .5; g.add(h); }
    if (e.type === 'boss') {
      g.add(new THREE.Mesh(new THREE.SphereGeometry(1.6, 24, 16), auraMat));
      const crown = new THREE.Group(); g.userData.crown = crown; g.add(crown);
      for (let i = 0; i < 10; i++) { const s = new THREE.Mesh(hornGeo, new THREE.MeshBasicMaterial({ color: hdr(GOLD, 1.15) })); const a = i / 10 * 6.283; s.position.set(Math.cos(a) * 1.15, .5, Math.sin(a) * 1.15); s.rotation.set(Math.sin(a) * .9, 0, -Math.cos(a) * .9); crown.add(s); }
      shock.push({ x: wx(e.x), z: wz(e.y), t: 0 });
    }
    g.add(blob(2.2));
    g.userData.body = body; g.userData.born = T; scene.add(g); return g;
  }

  /* ---------- shards, slashes, shockwaves ---------- */
  const shardMesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(.13), new THREE.MeshBasicMaterial({ color: hdr(CYAN, 2.4) }), 600);
  shardMesh.frustumCulled = false; scene.add(shardMesh);
  const slashGeo = new THREE.RingGeometry(1.55, 2.0, 48, 1, -1.15, 2.3);
  const slashPool = new Map();
  const shock = [], shockGeo = new THREE.RingGeometry(.9, 1, 64);
  const shockMeshes = [];

  /* ---------- HD-2D sprite actors (LTX-animated manhwa characters, see tools/bake_sprites.py) ---------- */
  const SPR = { chars: {}, ready: false, frame: [192, 288], fps: 12 };
  const texLoader = new THREE.TextureLoader();
  const prepTex = t => { t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; return t; };
  fetch('sprites/manifest.json').then(r => r.json()).then(m => {
    SPR.frame = m.frame; SPR.fps = m.fps;
    for (const [c, d] of Object.entries(m.chars)) {
      SPR.chars[c] = { anchor: d.anchor, anims: {} };
      for (const [a, A] of Object.entries(d.anims)) SPR.chars[c].anims[a] = { ...A, tex: prepTex(texLoader.load('sprites/' + A.img)) };
    }
    SPR.defaultHunter = SPR.chars.hunter; SPR.ready = true;
    if (window.personalSprites) window.setHunterSprites(window.personalSprites);
  }).catch(e => console.warn('no sprites, using 3D stand-ins', e));
  window.resetHunterSprites = () => { if (SPR.defaultHunter) { SPR.chars.hunter = SPR.defaultHunter; if (heroActor) heroActor.clones = {}; } };
  // the player's own hunter, baked in the browser from their LTX moves (index.html: bakeHunterSprites)
  window.setHunterSprites = set => {
    SPR.chars.hunter = { anchor: set.anchor, anims: Object.fromEntries(Object.entries(set.anims).map(([a, A]) => [a, { ...A, tex: prepTex(new THREE.CanvasTexture(A.canvas)) }])) };
    for (const a of actors.values()) if (a.char === 'hunter') a.clones = {};
    if (heroActor) heroActor.clones = {};
  };
  const HEIGHT = { hunter: 2.3, imp: 1.35, brute: 2.7, boss: 4.4 };
  const quad = new THREE.PlaneGeometry(1, 1);
  function makeActor(char, aura) {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: .3, side: THREE.DoubleSide, fog: false });
    const body = new THREE.Mesh(quad, mat); g.add(body);
    let glow = null;
    if (aura) { glow = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: hdr(aura, .9), opacity: .35, side: THREE.DoubleSide, fog: false })); glow.renderOrder = -1; g.add(glow); }
    const shadow = blob(1.6); g.add(shadow);
    scene.add(g);
    return { g, body, glow, shadow, char, clones: {}, dead: 0 };
  }
  function pickAnim(char, want) {
    const A = SPR.chars[char] && SPR.chars[char].anims;
    if (!A) return null;
    return A[want] || A[{ run: 'idle', combo: 'idle', dash: 'run', special: 'combo', move: 'idle', idle: 'move', attack: 'move' }[want]] || Object.values(A)[0];
  }
  // anim: { name, p } (0..1 progress) or { name, t } (seconds, loops)
  function poseActor(a, anim, face, x, z, y = 0) {
    const C = SPR.chars[a.char], A = pickAnim(a.char, anim.name);
    if (!C || !A) return false;
    const n = A.n, i = anim.p !== undefined ? Math.min(n - 1, Math.floor(anim.p * n)) : (A.loop ? Math.floor(anim.t * SPR.fps) % n : Math.min(n - 1, Math.floor(anim.t * SPR.fps)));
    let tex = a.clones[A.img]; if (!tex) { tex = a.clones[A.img] = A.tex.clone(); tex.needsUpdate = true; }
    const col = i % A.cols, row = Math.floor(i / A.cols);
    tex.repeat.set((face < 0 ? -1 : 1) / A.cols, 1 / A.rows);
    tex.offset.set((face < 0 ? col + 1 : col) / A.cols, 1 - (row + 1) / A.rows);
    for (const m of [a.body, a.glow]) if (m && m.material.map !== tex) { m.material.map = tex; m.material.needsUpdate = true; }
    const an = C.anchor, ph = HEIGHT[a.char] / Math.max(.2, an.foot - an.top), pw = ph * SPR.frame[0] / SPR.frame[1];
    const ox = (.5 - an.cx) * pw * (face < 0 ? -1 : 1);
    a.body.scale.set(pw, ph, 1); a.body.position.set(ox, an.foot * ph - ph / 2, 0);   // frame foot line on the ground
    if (a.glow) { a.glow.scale.set(pw * 1.07, ph * 1.04, 1); a.glow.position.set(ox, a.body.position.y + ph * .01, -.03); }
    a.shadow.scale.setScalar(HEIGHT[a.char] * .55);
    a.g.position.set(x, y, z);
    a.g.rotation.y = Math.atan2(camera.position.x - x, camera.position.z - z);
    a.shadow.rotation.set(-Math.PI / 2, 0, -a.g.rotation.y); a.shadow.position.y = -y + .02;
    return true;
  }
  const actors = new Map();           // enemy -> actor
  const heroPool = new THREE.Mesh(new THREE.CircleGeometry(1, 40), new THREE.MeshBasicMaterial({ map: shadowTex, color: hdr(CYAN, .9), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  heroPool.rotation.x = -Math.PI / 2; heroPool.scale.setScalar(2.2); scene.add(heroPool);
  let heroActor = null;
  const WCOL = { none: hdr(CYAN, .9), flame: hdr(0xff7a45, 1.3), thunder: hdr(0xffe66a, 1.3), twin: hdr(0xb18cff, 1.3), cleaver: hdr(0xffd84a, 1.3) };
  const teleMeshes = new Map(), pickMeshes = new Map(), pickGeo = new THREE.OctahedronGeometry(.32), ringGeo = new THREE.RingGeometry(.55, .7, 40);
  const teleMat = () => new THREE.MeshBasicMaterial({ color: hdr(RED, 1.6), transparent: true, opacity: .35, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });

  /* ---------- per-frame ---------- */
  const eul = new THREE.Euler(), seen = new Set(), ss = new Set(), tl = new Set();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v3 = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), camT = new THREE.Vector3(), camP = new THREE.Vector3();
  let heroYaw = 0, lastHX = null, lastHZ = null, lastT = 0, inited = false, lastMode = null;

  function resize() {
    renderer.setSize(W, H, false); composer.setSize(W, H);
    bloom.resolution.set(W / 2, H / 2);
    camera.aspect = W / H; camera.updateProjectionMatrix();
    pointMat.uniforms.uScale.value = H * .9;
  }
  addEventListener('resize', resize); resize();

  function updateCamera(play, gx, gz, gy, dt) {
    const D = Math.max(8, H / K * .5);
    const c = S && S.cine;
    if (play && c && c.boss && c.boss.hp > 0) {          // boss entrance: low, close, slowly circling
      const bx = wx(c.boss.x), bz = wz(c.boss.y), a = .45 - c.t * .2;
      camT.set(bx, 1.4, bz); camP.set(bx + Math.sin(a) * 10, 4.2, bz + Math.cos(a) * 10);
    } else if (play && c && P) {                          // boss defeated: push in on the hunter
      const px = wx(P.x), pz = wz(P.y);
      camT.set(px, 1.2, pz); camP.set(px + 2.5, 3.2 + c.t, pz + 5.5 + c.t);
    } else if (play) {
      const px = wx(P.x), pz = wz(P.y);
      camT.set(px * .8, .9, pz * .8);
      camP.set(camT.x, D * .5, camT.z + D * 1.05);         // HD-2D: low, close; the arena backdrop fills the top of the frame
    } else {   // menu / end: slow orbit around the Gate
      const a = Math.sin(T * .12) * .7;
      camT.set(gx, gy * .8, gz);
      camP.set(gx + Math.sin(a) * 16, gy + 1.5, gz + Math.cos(a) * 16);
    }
    const k = inited && Number.isFinite(camera.position.x) ? 1 - Math.pow(.02, dt * 3) : 1;
    camera.position.lerp(camP, k);
    if (S && S.shake > .5) camera.position.add(v3.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(S.shake * .012));
    const fov = P && P.dash > 0 && play ? 58 : 48;           // dash: quick FOV kick
    if (Math.abs(camera.fov - fov) > .05) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 12); camera.updateProjectionMatrix(); }
    camera.lookAt(camT);
    inited = true;
  }

  function render() {
    const dt = Math.max(0, Math.min(.05, T - lastT));
    syncFace();
    const play = mode === 'play' || mode === 'intro';
    const gp = gatePos(), menu = !play;
    const open = mode === 'intro' ? Math.min(1, T / 1.1) : 1;
    const s = (menu ? 1.5 : 1) * gateScale() * open;
    const gx = menu ? 0 : wx(gp.x), gz = menu ? 0 : wz(gp.y) - 3.2, rx = 1.9 * s, ry = 2.9 * s, gy = 2.9 * (menu ? 1.5 : 1) * gateScale() + .25;
    gate.position.set(gx, gy, gz);
    portal.scale.set(rx, ry, 1); rim.scale.set(rx, ry, 1);
    portalMat.uniforms.uTime.value = T; portalMat.uniforms.uOpen.value = open * (menu ? 1 : .7);
    groundMat.uniforms.uTime.value = T; groundMat.uniforms.uOpen.value = open;
    groundMat.uniforms.uGate.value.set(gx, gz); groundMat.uniforms.uArena.value.set(W / 2 / K, H / 2 / K);
    gateLight.position.set(gx, gy, gz + 1.5); gateLight.intensity = 28 * open;
    for (const d of debris) {
      const u = d.userData, a = u.a + T * u.s * .5;
      d.position.set(Math.cos(a) * rx * u.r, Math.sin(a) * ry * u.r * .9 + Math.sin(T + u.y) * .15, Math.sin(a * 2) * .5);
      d.rotation.set(T * u.s, T * u.s * 1.3, 0); d.visible = open > .3;
    }
    // inflow sparks spiral into the Gate
    {
      const P3 = inflow.geo.attributes.position.array, C3 = inflow.geo.attributes.color.array, S1 = inflow.geo.attributes.size.array;
      inflowState.forEach((p, i) => {
        p.r -= dt * p.v * .5; p.a += dt * (1.5 + (1 - p.r) * 2); if (p.r <= .05) { p.r = 1 + Math.random() * .4; p.a = Math.random() * 6.283; }
        P3[i * 3] = gx + Math.cos(p.a) * rx * p.r * 1.3; P3[i * 3 + 1] = gy + Math.sin(p.a) * ry * p.r * 1.15; P3[i * 3 + 2] = gz + .1 + p.r * .8;
        const c = i % 3 ? [.4, 1.8, 2.6] : [1.6, 1.4, 2.6]; C3.set(c.map(v => v * open), i * 3); S1[i] = .09 + .07 * (1 - p.r);
      });
      for (const n of ['position', 'color', 'size']) inflow.geo.attributes[n].needsUpdate = true;
    }

    // hero
    const heroShown = !!P && (mode === 'play' || (mode === 'intro' && T > 2));
    hero.visible = heroShown;
    if (P && SPR.ready && SPR.chars.hunter) {     // HD-2D: the LTX-animated hunter sprite
      hero.visible = false;
      if (!heroActor) heroActor = makeActor('hunter', CYAN);
      heroActor.g.visible = heroShown && !(P.inv > 0 && P.state !== 'dash' && Math.floor(T * 20) % 2);
      const hx = wx(P.x), hz = wz(P.y);
      poseActor(heroActor, P.anim || { name: P.moving ? 'run' : 'idle', t: T }, P.face || 1, hx, hz, 0);
      heroActor.body.material.color.setScalar(P.flash > 0 ? 2.4 : 1.3);
      heroActor.glow.material.color.copy(WCOL[P.weapon ? P.weapon.kind : 'none']);
      heroActor.glow.material.opacity = .4 + .12 * Math.sin(T * 3) + (P.state === 'sp' ? .7 : 0) + (P.dash > 0 ? .35 : 0) + ((P.sp || 0) >= 100 ? .25 : 0);
      heroLight.position.set(hx, 1.4, hz + .6); heroLight.intensity = 9;
      heroPool.visible = heroActor.g.visible; heroPool.position.set(hx, .03, hz);
    } else { if (heroActor) heroActor.g.visible = false; heroPool.visible = false; }
    if (P && !(SPR.ready && SPR.chars.hunter)) {
      const hx = wx(P.x), hz = wz(P.y);
      if (lastHX !== null) { const dx = hx - lastHX, dz = hz - lastHZ; if (dx * dx + dz * dz > 1e-5) heroYaw = Math.atan2(dx, dz); }
      lastHX = hx; lastHZ = hz;
      hero.position.set(hx, P.moving ? Math.abs(Math.sin(T * 14)) * .06 : 0, hz);
      hero.rotation.y += Math.atan2(Math.sin(heroYaw - hero.rotation.y), Math.cos(heroYaw - hero.rotation.y)) * Math.min(1, dt * 14);
      const sw = P.moving ? Math.sin(T * 14) * .6 : 0; legs[0].rotation.x = sw; legs[1].rotation.x = -sw;
      coat.rotation.x = P.dash > 0 ? .35 : P.moving ? .12 : 0;
      headMat.color.setRGB(...(P.flash > 0 ? [1.4, .5, .6] : P.dash > 0 ? [1.2, 1.2, 1.2] : [.86, .86, .86]));
      if (P.inv > 0 && P.dash <= 0 && Math.floor(T * 20) % 2) hero.visible = false;
      heroLight.position.set(hx, 1.2, hz + .4);
    }
    // intro: your face flies out of the Gate and lands on the hunter
    introHead.visible = mode === 'intro' && T > .8 && T < 2.05 && !!P;
    if (introHead.visible) {
      const k = Math.min(1, (T - .8) / 1.2), e = 1 - Math.pow(1 - k, 3), sz = 3.2 - 2.15 * e;
      introHead.position.set(gx + (wx(P.x) - gx) * e, gy + (1.62 - gy) * e + Math.sin(e * Math.PI) * 1.5, gz + (wz(P.y) - gz) * e);
      introHead.scale.set(sz, sz, 1);
    }

    // enemies
    seen.clear();
    for (const e of (play ? enemies : [])) {
      if (SPR.ready && SPR.chars[e.type]) {     // HD-2D sprite enemy
        let a = actors.get(e);
        if (!a) { a = makeActor(e.type, e.type === 'boss' ? VIOLET : e.type === 'brute' ? 0x6a2aff : null); a.born = T; actors.set(e, a); if (e.type === 'boss') shock.push({ x: wx(e.x), z: wz(e.y), t: 0 }); }
        seen.add(e);
        poseActor(a, e.anim || { name: e.type === 'boss' ? 'idle' : 'move', t: T + e.wob }, e.face || (P && P.x < e.x ? -1 : 1), wx(e.x), wz(e.y), (e.z || 0) / K);
        a.g.scale.setScalar(Math.min(1, (T - a.born) / .35));
        const c = a.body.material.color;
        if (e.hit > 0) c.setScalar(2.4);
        else if (e.state === 'wind') { const k = .5 + .5 * Math.sin(T * 30); c.setRGB(1.6 + k, .55, .55); }
        else c.setScalar(1.25);
        continue;
      }
      let g = live.get(e); if (!g) { g = enemyMesh(e); live.set(e, g); }
      seen.add(e);
      const r = e.r / K, born = Math.min(1, (T - g.userData.born) / .35);
      g.scale.setScalar(r * born);
      g.position.set(wx(e.x), r + Math.sin(e.wob) * r * .12, wz(e.y));
      if (P) g.rotation.y = Math.atan2(wx(P.x) - g.position.x, wz(P.y) - g.position.z);
      g.userData.body.material.emissive.setHex(e.hit > 0 ? 0x9a80ff : 0x2a0f5a);
      if (g.userData.crown) g.userData.crown.rotation.y = T * 1.2;
    }
    for (const [e, a] of actors) if (!seen.has(e)) {   // death: flash, squash and dissolve
      a.dead += dt;
      const k = Math.min(1, a.dead / .4);
      a.body.material.color.setScalar(2.5 * (1 - k) + .2); a.body.material.opacity = 1 - k; a.body.material.alphaTest = .3 * (1 - k) + .01;
      a.g.scale.set(1 + k * .3, 1 - k * .6, 1);
      if (a.glow) a.glow.material.opacity = .6 * (1 - k);
      if (k >= 1) { scene.remove(a.g); a.body.material.dispose(); if (a.glow) a.glow.material.dispose(); Object.values(a.clones).forEach(t => t.dispose()); actors.delete(e); }
    }
    // weapon pickups: spinning crystal + ground ring
    const pkSet = new Set(play && S && S.pickups ? S.pickups : []);
    for (const pk of pkSet) {
      let m = pickMeshes.get(pk);
      if (!m) { const col = { flame: 0xff7a45, thunder: 0xffe66a, twin: 0xb18cff, cleaver: 0xffd84a }[pk.kind];
        m = new THREE.Group(); const gem = new THREE.Mesh(pickGeo, new THREE.MeshBasicMaterial({ color: hdr(col, 2.6) })); const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: hdr(col, 1.6), transparent: true, opacity: .7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
        ring.rotation.x = -Math.PI / 2; ring.position.y = -.85; m.add(gem, ring); m.userData.gem = gem; scene.add(m); pickMeshes.set(pk, m); }
      m.position.set(wx(pk.x), .95 + Math.sin(T * 3 + pk.t) * .12, wz(pk.y)); m.userData.gem.rotation.y = T * 2.5; m.visible = !(pk.t > 16 && Math.floor(T * 8) % 2);
    }
    for (const [pk, m] of pickMeshes) if (!pkSet.has(pk)) { scene.remove(m); m.traverse(o => o.material && o.material.dispose()); pickMeshes.delete(pk); }
    // attack telegraphs on the ground
    tl.clear(); if (play && S && S.tele) for (const x of S.tele) tl.add(x);
    for (const t of tl) {
      let m = teleMeshes.get(t);
      if (!m) { m = new THREE.Mesh(t.kind === 'rect' ? new THREE.PlaneGeometry(1, 1) : new THREE.CircleGeometry(1, 40), teleMat()); m.rotation.x = -Math.PI / 2; scene.add(m); teleMeshes.set(t, m); }
      const k = Math.min(1, t.t / t.dur);
      if (t.kind === 'rect') { m.scale.set(t.len / K, t.wid / K, 1); m.position.set(wx(t.x + t.face * t.len / 2), .04, wz(t.y)); }
      else { m.scale.setScalar(t.r / K * (.4 + .6 * k)); m.position.set(wx(t.x), .04, wz(t.y)); }
      m.material.opacity = .18 + .35 * k + .15 * Math.sin(T * 24);
    }
    for (const [t, m] of teleMeshes) if (!tl.has(t)) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); teleMeshes.delete(t); }
    for (const [e, g] of live) if (!seen.has(e)) { scene.remove(g); g.traverse(o => { if (o.material && o.material !== eyeMat && o.material !== auraMat) o.material.dispose(); }); live.delete(e); }

    // shards
    const sh = play ? shards : [];
    shardMesh.count = Math.min(sh.length, 600);
    for (let i = 0; i < shardMesh.count; i++) {
      const s2 = sh[i];
      q.setFromEuler(eul.set(T * 3 + s2.t, T * 2, 0));
      m4.compose(v3.set(wx(s2.x), .32 + Math.sin(T * 4 + i) * .06, wz(s2.y)), q, one); shardMesh.setMatrixAt(i, m4);
    }
    shardMesh.instanceMatrix.needsUpdate = true;

    // slashes
    ss.clear(); if (play) for (const x of slashes) ss.add(x);
    for (const sl of ss) {
      let m = slashPool.get(sl);
      if (!m) {
        m = new THREE.Group(); const arc = new THREE.Mesh(slashGeo, new THREE.MeshBasicMaterial({ color: hdr(0x9fe8ff, 3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
        if (sl.face === undefined) arc.rotation.x = -Math.PI / 2;
        else { arc.rotation.z = sl.step === 2 ? .9 : sl.step === 3 ? -.9 : 0; arc.material.color = sl.big ? hdr(0xc9b8ff, 3.2) : hdr(sl.color || 0x7fe6ff, sl.color ? 2.4 : 1.9); }
        m.add(arc); m.userData.arc = arc; scene.add(m); slashPool.set(sl, m);
      }
      const k = Math.max(0, sl.life / (sl.max || .18));
      if (sl.face === undefined) { m.position.set(wx(sl.x), .55, wz(sl.y)); m.rotation.y = -sl.ang - (1 - k) * .4; m.scale.setScalar(.85 + (1 - k) * .3); }
      else {
        const sc = sl.big ? 3.2 : sl.step === 3 ? 1.2 : .85;
        const fx = sl.big || !P ? sl.x : P.x, fy = sl.big || !P ? sl.y : P.y;   // swings travel with the lunge
        m.position.set(wx(fx) + sl.face * .45, .95, wz(fy) + .05);
        m.rotation.y = Math.atan2(camera.position.x - m.position.x, camera.position.z - m.position.z);
        m.scale.set(sl.face * sc * (.85 + (1 - k) * .35), sc * (.85 + (1 - k) * .35), 1);
      }
      m.userData.arc.material.opacity = k; m.visible = !(sl.delay > 0);
    }
    for (const [sl, m] of slashPool) if (!ss.has(sl)) { scene.remove(m); m.userData.arc.material.dispose(); slashPool.delete(sl); }

    // boss shockwaves
    for (let i = shock.length - 1; i >= 0; i--) {
      const w = shock[i]; w.t += dt;
      if (!shockMeshes[i]) { const mm = new THREE.Mesh(shockGeo, new THREE.MeshBasicMaterial({ color: hdr(GOLD, 2.5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })); mm.rotation.x = -Math.PI / 2; scene.add(mm); shockMeshes[i] = mm; }
      const mm = shockMeshes[i]; mm.position.set(w.x, .1, w.z); mm.scale.setScalar(1 + w.t * 14); mm.material.opacity = Math.max(0, 1 - w.t / 1.2);
      if (w.t > 1.2) { scene.remove(mm); mm.material.dispose(); shockMeshes.splice(i, 1); shock.splice(i, 1); }
    }

    // particles from the game simulation
    {
      const P3 = sparks.geo.attributes.position.array, C3 = sparks.geo.attributes.color.array, S1 = sparks.geo.attributes.size.array;
      let n = 0;
      for (const p of parts) {
        if (n >= sparks.max) break;
        if (p.h === undefined) { p.h = .25 + Math.random() * 1.1; p.vh = (Math.random() - .3) * 2; }
        p.h = Math.max(.05, p.h + p.vh * dt);
        const a = Math.max(0, Math.min(1, p.life / p.max)), c = col(p.c);
        P3[n * 3] = wx(p.x); P3[n * 3 + 1] = p.h; P3[n * 3 + 2] = wz(p.y);
        C3[n * 3] = c.r * a; C3[n * 3 + 1] = c.g * a; C3[n * 3 + 2] = c.b * a; S1[n] = p.s * .07;
        n++;
      }
      sparks.geo.setDrawRange(0, n);
      for (const k of ['position', 'color', 'size']) sparks.geo.attributes[k].needsUpdate = true;
    }

    if (mode !== lastMode) { lastMode = mode; inited = false; }   // snap the camera on mode changes (T resets per run)
    updateCamera(play, gx, gz, gy, dt);
    lastT = T;
    bloom.strength = S && S.cine ? .32 : .7;   // keep cinematic close-ups from blooming out
    composer.render();
  }

  function project(x, y, h = 0) {
    v3.set(wx(x), h, wz(y)).project(camera);
    return { x: (v3.x + 1) / 2 * W, y: (1 - v3.y) / 2 * H, behind: v3.z > 1 };
  }

  if (window.pendingArena) window.setArena(window.pendingArena);   // arena picked before the renderer loaded
  window.R3 = { render, project, K };
  document.documentElement.classList.add('gl3d');
}
