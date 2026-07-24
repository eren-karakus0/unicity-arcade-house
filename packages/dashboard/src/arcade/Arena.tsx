/**
 * Unicity Arena — a full-page cinematic showcase of the autonomous bot league,
 * driven by REAL data from /api/arcade/astrid (+ the live jackpot from the
 * leaderboard). A metallic provably-fair coin (Three.js) is the hero; a
 * restrained broadcast HUD sits over it.
 *
 * Honesty (the product's rule): every persona, W/L/earning, strategist reason,
 * outcome, jackpot pool and runtime fact shown here is REAL — pulled from the
 * capsule's own reported league sessions. The coin's commit/reveal is a LIVE
 * in-browser SHA-256 demonstration of the house's commit-reveal scheme (a fresh
 * secret each cycle, re-hashed on screen) — it illustrates the mechanism the
 * capsule verifies in-sandbox; it is never presented as a specific round's hash.
 *
 * The whole engine is imperative (ported from the tuned prototype) so the
 * typewriter + per-frame 3D never trigger React re-renders. React only mounts
 * the static skeleton and owns setup/teardown.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import './arena.css';
import { fetchAstrid, fetchLeaderboard, type AstridBot } from '../lib/arcade';
import { prefersReducedMotion } from '../lib/motion';
import { isMuted, setMuted, sfx } from './sound';
import { go } from '../lib/nav';

interface StyleMeta { css: string; hex: number; tint: string }
const STYLE: Record<string, StyleMeta> = {
  balanced:   { css: '#ffcf4d', hex: 0xffcf4d, tint: 'rgba(255,207,77,0.08)' },
  aggressive: { css: '#ff6f00', hex: 0xff6f00, tint: 'rgba(255,111,0,0.09)' },
  cautious:   { css: '#9aa7b8', hex: 0x9aa7b8, tint: 'rgba(154,167,184,0.07)' },
  'for-hire': { css: '#c8823f', hex: 0xc8823f, tint: 'rgba(200,130,63,0.08)' },
};
const FALLBACK_STYLE: StyleMeta = { css: '#ffcf4d', hex: 0xffcf4d, tint: 'rgba(255,207,77,0.08)' };
const styleOf = (s: string): StyleMeta => STYLE[s] ?? FALLBACK_STYLE;

const CREST: Record<string, (c: string) => string> = {
  balanced: (c) => `<svg viewBox="0 0 100 100"><polygon points="50,8 86,29 86,71 50,92 14,71 14,29" fill="none" stroke="${c}" stroke-width="5"/><circle cx="50" cy="50" r="19" fill="none" stroke="${c}" stroke-width="4"/><path d="M50 31 A19 19 0 0 1 50 69 Z" fill="${c}"/></svg>`,
  aggressive: (c) => `<svg viewBox="0 0 100 100"><path d="M50 10 L80 42 H63 L50 29 L37 42 H20 Z" fill="${c}"/><path d="M50 40 L80 72 H63 L50 59 L37 72 H20 Z" fill="${c}" opacity=".62"/><path d="M50 68 L72 92 H28 Z" fill="${c}" opacity=".36"/></svg>`,
  cautious: (c) => `<svg viewBox="0 0 100 100"><path d="M50 9 L85 22 V52 C85 74 69 87 50 93 C31 87 15 74 15 52 V22 Z" fill="none" stroke="${c}" stroke-width="5"/><rect x="37" y="37" width="26" height="26" transform="rotate(45 50 50)" fill="${c}"/></svg>`,
  'for-hire': (c) => `<svg viewBox="0 0 100 100"><ellipse cx="50" cy="50" rx="45" ry="17" fill="none" stroke="${c}" stroke-width="2.5" opacity=".5" transform="rotate(-24 50 50)"/><circle cx="37" cy="50" r="19" fill="none" stroke="${c}" stroke-width="7"/><circle cx="63" cy="50" r="19" fill="none" stroke="${c}" stroke-width="7"/></svg>`,
};
const crestOf = (style: string, c: string): string => (CREST[style] ?? CREST.balanced!)(c);

interface Play { name: string; style: string; game: string; bet: number; outcome: string; reason: string; source: string }

export default function Arena() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [muted, setMutedState] = useState(isMuted());
  const toggleMute = () => { const next = !isMuted(); setMuted(next); setMutedState(next); if (!next) sfx.click(); };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const RM = prefersReducedMotion();
    const MOBILE = window.innerWidth < 860;
    const q = (name: string) => root.querySelector<HTMLElement>(`[data-el="${name}"]`)!;
    const rand = (n: number) => Math.floor(Math.random() * n);
    const hexs = (n: number) => Array.from({ length: n }, () => rand(16).toString(16)).join('');
    let stopped = false;
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, RM ? Math.min(ms, 120) : ms));
    const sha256 = async (s: string) => {
      const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
      return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
    };

    /* ---------------- 3D core (Three.js) ---------------- */
    const cv = q('gl') as HTMLCanvasElement;
    const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MOBILE ? 1.4 : 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.06;
    renderer.setClearColor(0x060606, 1);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x060606, 0.052);
    const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 1.15, 5.4);

    const envC = document.createElement('canvas'); envC.width = 256; envC.height = 128;
    const eg = envC.getContext('2d')!; const grd = eg.createLinearGradient(0, 0, 0, 128);
    grd.addColorStop(0.0, '#1b1712'); grd.addColorStop(0.48, '#0c0b09'); grd.addColorStop(0.62, '#2a1808');
    grd.addColorStop(0.68, '#ff7a10'); grd.addColorStop(0.74, '#1c1208'); grd.addColorStop(1.0, '#060606');
    eg.fillStyle = grd; eg.fillRect(0, 0, 256, 128);
    const env = new THREE.CanvasTexture(envC); env.mapping = THREE.EquirectangularReflectionMapping; env.encoding = THREE.sRGBEncoding;
    scene.environment = env;

    const key = new THREE.DirectionalLight(0xfff1e2, 2.1); key.position.set(3.5, 5, 4); scene.add(key);
    const rim = new THREE.PointLight(0xff6f00, 3.4, 16); rim.position.set(-2.6, 1.4, -2.2); scene.add(rim);
    const under = new THREE.PointLight(0xff8a2b, 1.4, 12); under.position.set(0, -1.4, 1.5); scene.add(under);
    scene.add(new THREE.HemisphereLight(0x2a3040, 0x070605, 0.32));

    const floor = new THREE.Mesh(new THREE.CircleGeometry(11, 72),
      new THREE.MeshStandardMaterial({ color: 0x0a0908, metalness: 0.92, roughness: 0.38, envMap: env }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -1.18; scene.add(floor);
    const arc = new THREE.Mesh(new THREE.TorusGeometry(2.55, 0.022, 16, 140),
      new THREE.MeshStandardMaterial({ color: 0xff6f00, emissive: 0xff6f00, emissiveIntensity: 1.1, metalness: 0.5, roughness: 0.5 }));
    arc.rotation.x = -Math.PI / 2; arc.position.y = -1.15; scene.add(arc);

    // The hero: a dark-metal die (our dice mark) with glowing orange pips that
    // tumbles like a real roll. Opposite faces sum to 7; pips light up on the
    // active agent's colour during a play.
    const PIPS: [number, number][][] = [
      [[1, 1]],
      [[0, 0], [2, 2]],
      [[0, 0], [1, 1], [2, 2]],
      [[0, 0], [2, 0], [0, 2], [2, 2]],
      [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
      [[0, 0], [0, 1], [0, 2], [2, 0], [2, 1], [2, 2]],
    ];
    const faceTexOf = (n: number): THREE.CanvasTexture => {
      const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d')!;
      const bg = g.createLinearGradient(0, 0, 256, 256); bg.addColorStop(0, '#181410'); bg.addColorStop(1, '#0c0a08');
      g.fillStyle = bg; g.fillRect(0, 0, 256, 256);
      g.strokeStyle = 'rgba(255,150,60,0.12)'; g.lineWidth = 8; g.strokeRect(16, 16, 224, 224);
      g.fillStyle = '#ff6f00';
      for (const [cx, cy] of PIPS[n - 1]!) { g.beginPath(); g.arc(52 + cx * 76, 52 + cy * 76, 22, 0, 7); g.fill(); }
      const t = new THREE.CanvasTexture(c); t.anisotropy = 8; t.encoding = THREE.sRGBEncoding; return t;
    };
    const dieTex = [1, 2, 3, 4, 5, 6].map(faceTexOf);            // index 0..5 → faces 1..6
    const faceForBox = [1, 6, 2, 5, 3, 4];                        // px,nx,py,ny,pz,nz (opposite sum 7)
    const dieMats = faceForBox.map((n) => new THREE.MeshStandardMaterial({
      map: dieTex[n - 1]!, emissive: 0xff6f00, emissiveMap: dieTex[n - 1]!, emissiveIntensity: 0.24,
      metalness: 0.6, roughness: 0.34, envMap: env,
    }));
    const grp = new THREE.Group();
    const die = new THREE.Mesh(new THREE.BoxGeometry(1.58, 1.58, 1.58), dieMats);
    grp.add(die); grp.rotation.set(-0.4, 0.62, 0.12);

    // (E) additional hero shapes — the centre morphs to the active game. Each,
    // like the die, is DARK METAL with a glowing accent that carries the agent
    // colour (the accent is what `mats` tints/pulses — bodies stay rich metal).

    // COIN (coin / rps): dark coin with a glowing Unicity hex emblem (not die pips).
    const coinFaceTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d')!;
      const bg = g.createRadialGradient(128, 104, 16, 128, 128, 150); bg.addColorStop(0, '#221a12'); bg.addColorStop(1, '#0a0807');
      g.fillStyle = bg; g.beginPath(); g.arc(128, 128, 126, 0, 7); g.fill();
      g.strokeStyle = 'rgba(255,150,60,0.2)'; g.lineWidth = 9; g.beginPath(); g.arc(128, 128, 114, 0, 7); g.stroke();
      g.strokeStyle = '#ff6f00'; g.lineWidth = 16; g.lineJoin = 'round'; g.beginPath();
      for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3, x = 128 + 58 * Math.cos(a), y = 128 + 58 * Math.sin(a); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
      g.closePath(); g.stroke();
      g.fillStyle = '#ff6f00'; g.beginPath(); g.arc(128, 128, 20, 0, 7); g.fill();
      const t = new THREE.CanvasTexture(c); t.anisotropy = 8; t.encoding = THREE.sRGBEncoding; return t;
    })();
    const coinFaceMat = new THREE.MeshStandardMaterial({ map: coinFaceTex, emissive: 0xff6f00, emissiveMap: coinFaceTex, emissiveIntensity: 0.3, metalness: 0.75, roughness: 0.3, envMap: env });
    const coinEdgeMat = new THREE.MeshStandardMaterial({ color: 0x7a726a, metalness: 1, roughness: 0.32, envMap: env });
    const coinGrp = new THREE.Group();
    const coinMesh = new THREE.Mesh(new THREE.CylinderGeometry(1.24, 1.24, 0.2, 64), [coinEdgeMat, coinFaceMat, coinFaceMat]);
    coinMesh.rotation.x = Math.PI / 2; coinGrp.add(coinMesh);

    // ROCKET (crash / limbo): dark metal body, glowing fins (only the fins tint).
    const rocketBodyMat = new THREE.MeshStandardMaterial({ color: 0x2b2621, emissive: 0x000000, metalness: 0.9, roughness: 0.28, envMap: env });
    const rocketFinMat = new THREE.MeshStandardMaterial({ color: 0x120d08, emissive: 0xff6f00, emissiveIntensity: 0.4, metalness: 0.6, roughness: 0.4, envMap: env });
    const rocketGrp = new THREE.Group();
    const rBody = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.52, 1.5, 28), rocketBodyMat);
    const rNose = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.78, 28), rocketFinMat); rNose.position.y = 1.14; // glowing nose cone
    const mkFin = (x: number, rot: number) => { const f = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.55, 0.06), rocketFinMat); f.position.set(x, -0.72, 0); f.rotation.z = rot; return f; };
    rocketGrp.add(rBody, rNose, mkFin(0.44, -0.42), mkFin(-0.44, 0.42));
    // exhaust flame — two additive cones (orange plume + white-hot core) that
    // flicker; longer while the rocket is firing (roll/settle), a pilot flame at rest.
    const flameOuterMat = new THREE.MeshBasicMaterial({ color: 0xff7a1e, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
    const flameInnerMat = new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    const flameOuter = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.35, 20), flameOuterMat); flameOuter.rotation.x = Math.PI; flameOuter.position.y = -1.4;
    const flameInner = new THREE.Mesh(new THREE.ConeGeometry(0.21, 0.9, 16), flameInnerMat); flameInner.rotation.x = Math.PI; flameInner.position.y = -1.15;
    const flameGrp = new THREE.Group(); flameGrp.add(flameOuter, flameInner); rocketGrp.add(flameGrp);

    // GEM (mines / plinko / wheel / number / … ): a faceted crystal. Many facets +
    // sharp, highly-reflective metal make each face catch the env-map differently
    // (that's the "design"); a restrained emissive tints it the agent colour
    // without washing the facets flat (see the per-hero `glow` scale below).
    const gemMat = new THREE.MeshStandardMaterial({ color: 0x14100b, emissive: 0xff6f00, emissiveIntensity: 0.4, metalness: 0.96, roughness: 0.1, envMap: env, flatShading: true });
    const gemGrp = new THREE.Group();
    gemGrp.add(new THREE.Mesh(new THREE.IcosahedronGeometry(1.2, 1), gemMat));

    interface Hero { grp: THREE.Group; mats: THREE.MeshStandardMaterial[]; glow?: number }
    const HEROES: Record<string, Hero> = {
      die: { grp, mats: dieMats },
      coin: { grp: coinGrp, mats: [coinFaceMat] },
      rocket: { grp: rocketGrp, mats: [rocketFinMat] },
      gem: { grp: gemGrp, mats: [gemMat], glow: 0.5 },
    };
    Object.values(HEROES).forEach((h) => { h.grp.visible = false; scene.add(h.grp); });
    const heroTypeFor = (game: string): string =>
      game === 'coin' || game === 'rps' ? 'coin'
        : game === 'crash' || game === 'limbo' ? 'rocket'
          : game === 'dice' ? 'die' : 'gem';
    let heroKey = 'die';
    let hero: Hero = HEROES.die!;
    hero.grp.visible = true;

    // Ambient FLOW FIELD — thousands of tiny points drifting through the arena
    // (GPU-animated in a vertex shader), so the whole space reads as living
    // particles rather than a lone object on a floor.
    const FN = MOBILE ? 1600 : 3600;
    const fpos = new Float32Array(FN * 3); const fseed = new Float32Array(FN);
    for (let i = 0; i < FN; i++) {
      fpos[i * 3] = (Math.random() - 0.5) * 32;
      fpos[i * 3 + 1] = (Math.random() - 0.5) * 17 + 2.5;
      fpos[i * 3 + 2] = (Math.random() - 0.5) * 26 - 5;
      fseed[i] = Math.random();
    }
    const fieldGeo = new THREE.BufferGeometry();
    fieldGeo.setAttribute('position', new THREE.BufferAttribute(fpos, 3));
    fieldGeo.setAttribute('aSeed', new THREE.BufferAttribute(fseed, 1));
    const fieldMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uPulse: { value: 0 }, uPR: { value: renderer.getPixelRatio() },
        uColor: { value: new THREE.Color(0xff8a2b) },
      },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `
        uniform float uTime; uniform float uPulse; uniform float uPR;
        attribute float aSeed; varying float vF;
        void main() {
          vec3 p = position; float t = uTime + aSeed * 6.2831;
          p.x += sin(t * 0.5 + p.y * 0.3) * 0.55;
          p.y += cos(t * 0.4 + p.x * 0.2) * 0.4;
          p.z += sin(t * 0.45 + p.y * 0.25) * 0.45;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float sz = (9.0 + 26.0 * uPulse) * uPR / -mv.z;
          gl_PointSize = sz * (0.5 + 0.5 * sin(aSeed * 6.2831 + uTime * 0.6));
          gl_Position = projectionMatrix * mv;
          vF = smoothstep(-28.0, -4.0, mv.z);
        }`,
      fragmentShader: `
        uniform vec3 uColor; uniform float uPulse; varying float vF;
        void main() {
          vec2 c = gl_PointCoord - 0.5; float d = length(c);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.0, d) * (0.26 + 0.55 * uPulse) * vF;
          gl_FragColor = vec4(uColor, a);
        }`,
    });
    const field = new THREE.Points(fieldGeo, fieldMat); scene.add(field);
    const fieldPulse = () => { fieldMat.uniforms.uPulse!.value = 1; };

    const BN = MOBILE ? 110 : 180; const bpos = new Float32Array(BN * 3); const bvel = new Float32Array(BN * 3);
    const burstGeo = new THREE.BufferGeometry(); const burstAttr = new THREE.BufferAttribute(bpos, 3); burstGeo.setAttribute('position', burstAttr);
    const burstMat = new THREE.PointsMaterial({ color: 0xffcf4d, size: 0.075, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    scene.add(new THREE.Points(burstGeo, burstMat));
    let burstLife = 0;
    const doBurst = (colorHex: number, power = 1) => {
      burstMat.color.set(colorHex); burstMat.opacity = 1; burstLife = 1;
      for (let i = 0; i < BN; i++) {
        const j = i * 3;
        const a = Math.random() * Math.PI * 2, b = Math.acos(2 * Math.random() - 1), s = (2 + Math.random() * 4) * power * 0.04;
        bvel[j] = Math.sin(b) * Math.cos(a) * s; bvel[j + 1] = Math.cos(b) * s + 0.02; bvel[j + 2] = Math.sin(b) * Math.sin(a) * s;
        bpos[j] = 0; bpos[j + 1] = 0.1; bpos[j + 2] = 0;
      }
      burstAttr.needsUpdate = true;
    };

    // (D) cinematic bloom — only the bright orange emissive (pips, arc, field)
    // blooms, giving the scene a glow. Skipped on mobile for perf (renders direct).
    const composer = MOBILE ? null : new EffectComposer(renderer);
    let bloom: UnrealBloomPass | null = null;
    if (composer) {
      composer.addPass(new RenderPass(scene, camera));
      bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.62, 0.55, 0.82);
      composer.addPass(bloom);
    }

    let mx = 0, my = 0;
    const onMove = (e: PointerEvent) => { mx = e.clientX / window.innerWidth - 0.5; my = e.clientY / window.innerHeight - 0.5; };
    const onResize = () => {
      renderer.setSize(window.innerWidth, window.innerHeight);
      composer?.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
    };
    window.addEventListener('pointermove', onMove); window.addEventListener('resize', onResize);

    let charge = 0, target = 0, winF = 0, raf = 0;
    // hero roll → settle state machine, generalized across die / coin / rocket / gem
    let mode: 'idle' | 'roll' | 'settle' | 'held' = 'idle';
    let rvx = 0.0035, rvy = 0.0052, rvz = 0.0009, settleT = 0, camPush = 0;
    let coinStartX = 0, coinTargetX = 0, rocketY = 0, rocketTargetY = 0;
    const IDLE_X = 0.0035, IDLE_Y = 0.0052, IDLE_Z = 0.0009;
    const AXIS_X = new THREE.Vector3(1, 0, 0), AXIS_Y = new THREE.Vector3(0, 1, 0);
    const TILT = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.26, 0.4, 0.06));
    const startQ = new THREE.Quaternion(), targetQ = new THREE.Quaternion(), wobQ = new THREE.Quaternion();
    // Local face normals: box materials [px,nx,py,ny,pz,nz] = die faces [1,6,2,5,3,4].
    const faceQuat = (face: number): THREE.Quaternion => {
      const q = new THREE.Quaternion();
      if (face === 4) q.setFromAxisAngle(AXIS_Y, Math.PI);
      else if (face === 1) q.setFromAxisAngle(AXIS_Y, -Math.PI / 2);
      else if (face === 6) q.setFromAxisAngle(AXIS_Y, Math.PI / 2);
      else if (face === 2) q.setFromAxisAngle(AXIS_X, Math.PI / 2);
      else if (face === 5) q.setFromAxisAngle(AXIS_X, -Math.PI / 2);
      return TILT.clone().multiply(q);
    };
    const faceForOutcome = (o: string) => (o === 'win' ? 6 : o === 'lose' ? 1 : o === 'tie' ? 3 : o === 'stop' ? 2 : o === 'skip' ? 5 : 4);
    const warm = new THREE.Color(0xff8a2b);

    // (E) morph the centre to the active game's shape (called at the start of a play)
    const setHero = (game: string) => {
      const k = heroTypeFor(game);
      if (k === heroKey) return;
      hero.grp.visible = false;
      heroKey = k; hero = HEROES[k]!; hero.grp.visible = true;
      hero.grp.position.set(0, 0, 0);
      hero.grp.rotation.set(-0.2, 0.4, 0.05);
      hero.grp.quaternion.setFromEuler(hero.grp.rotation);
      coinGrp.rotation.set(0, 0, 0); rocketGrp.position.y = 0; rocketY = 0; rocketTargetY = 0;
    };

    const Core = {
      agent(hexNum: number) {
        rim.color.set(hexNum); arc.material.color.set(hexNum); arc.material.emissive.set(hexNum);
        hero.mats.forEach((m) => m.emissive.set(hexNum));
        fieldMat.uniforms.uColor!.value.copy(warm).lerp(new THREE.Color(hexNum), 0.45); // (B)
      },
      commit() { target = 1; mode = 'roll'; rvx = 0.24; rvy = 0.30; rvz = 0.12; if (heroKey === 'rocket') rocketTargetY = 0; },
      reveal(outcome: string) {                                    // (F) push-in + per-hero settle
        camPush = 1; settleT = 0; mode = 'settle';
        const win = outcome === 'win';
        if (heroKey === 'die') { startQ.copy(hero.grp.quaternion); targetQ.copy(faceQuat(faceForOutcome(outcome))); }
        else if (heroKey === 'coin') { coinStartX = coinGrp.rotation.x; const base = coinStartX + Math.PI * 8; coinTargetX = base - (base % (Math.PI * 2)) + (win ? 0 : Math.PI); }
        else if (heroKey === 'rocket') { rocketTargetY = win ? 1.7 : 0.35; }
      },
      settle() { target = 0; },
      win(hexNum: number, big = false) { winF = big ? 1.7 : 1; doBurst(hexNum, big ? 1.7 : 1); flashDom(big ? 0.9 : 0.55); fieldPulse(); },
    };

    const tick = (t: number) => {
      if (stopped) return;
      raf = requestAnimationFrame(tick);
      charge += (target - charge) * 0.08;
      const g = hero.grp;
      if (heroKey === 'die') {
        if (mode === 'roll' || mode === 'idle') {
          g.rotation.x += rvx; g.rotation.y += rvy; g.rotation.z += rvz;
          rvx += (IDLE_X - rvx) * 0.03; rvy += (IDLE_Y - rvy) * 0.03; rvz += (IDLE_Z - rvz) * 0.03;
        } else if (mode === 'settle') {
          settleT = Math.min(1, settleT + 0.022);
          g.quaternion.slerpQuaternions(startQ, targetQ, 1 - Math.pow(1 - settleT, 3));
          if (settleT >= 1) mode = 'held';
        } else {
          wobQ.setFromEuler(new THREE.Euler(Math.sin(t * 0.001) * 0.03, Math.cos(t * 0.0012) * 0.03, 0));
          g.quaternion.copy(targetQ).multiply(wobQ);
        }
        g.position.y = Math.sin(t * 0.0009) * 0.06;
      } else if (heroKey === 'coin') {
        g.rotation.y += 0.004;
        if (mode === 'roll' || mode === 'idle') coinGrp.rotation.x += (mode === 'roll' ? 0.42 : 0.02);
        else if (mode === 'settle') {
          settleT = Math.min(1, settleT + 0.02);
          coinGrp.rotation.x = coinStartX + (coinTargetX - coinStartX) * (1 - Math.pow(1 - settleT, 3));
          if (settleT >= 1) mode = 'held';
        }
        g.position.y = Math.sin(t * 0.0009) * 0.06;
      } else if (heroKey === 'rocket') {
        g.rotation.y += 0.01;
        g.position.x = mode === 'roll' ? Math.sin(t * 0.05) * 0.03 : 0;
        if (mode === 'settle') { settleT = Math.min(1, settleT + 0.02); rocketY += (rocketTargetY - rocketY) * 0.12; if (settleT >= 1) mode = 'held'; }
        else if (mode === 'held') rocketY += (rocketTargetY - rocketY) * 0.08;
        else rocketY += (0 - rocketY) * 0.1;
        g.position.y = rocketY + Math.sin(t * 0.001) * 0.05;
        // exhaust flame: firing hard on launch, a flickering pilot flame at rest
        const firing = mode === 'roll' || mode === 'settle' ? 1 : 0.45;
        const flick = 0.82 + Math.sin(t * 0.045) * 0.13 + Math.sin(t * 0.13) * 0.07;
        flameGrp.scale.set(1, firing * flick, 1);
        flameOuterMat.opacity = (0.35 + firing * 0.4) * flick;
        flameInnerMat.opacity = (0.5 + firing * 0.4) * flick;
      } else { // gem
        const spin = mode === 'roll' ? 0.06 : mode === 'settle' ? 0.02 : 0.008;
        g.rotation.x += spin * 0.7; g.rotation.y += spin;
        if (mode === 'settle') { settleT = Math.min(1, settleT + 0.02); if (settleT >= 1) mode = 'held'; }
        g.scale.setScalar(1 + winF * 0.14);
        g.position.y = Math.sin(t * 0.0009) * 0.06;
      }
      const ei = (0.22 + charge * 1.4 + winF * 2.6) * (hero.glow ?? 1);
      hero.mats.forEach((m) => (m.emissiveIntensity = ei));
      arc.material.emissiveIntensity = 0.8 + charge * 1.6 + winF * 2.4;
      rim.intensity = 2.2 + charge * 3.6 + winF * 6;
      winF *= 0.93; if (winF < 0.01) winF = 0;
      camPush *= 0.95; if (camPush < 0.01) camPush = 0;
      fieldMat.uniforms.uTime!.value = t * 0.001;
      fieldMat.uniforms.uPulse!.value *= 0.94;
      if (burstLife > 0) {
        burstLife -= 0.016; burstMat.opacity = Math.max(0, burstLife);
        for (let i = 0; i < BN; i++) {
          const j = i * 3;
          bpos[j] = bpos[j]! + bvel[j]!; bpos[j + 1] = bpos[j + 1]! + bvel[j + 1]!; bpos[j + 2] = bpos[j + 2]! + bvel[j + 2]!; bvel[j + 1] = bvel[j + 1]! - 0.0016;
        }
        burstAttr.needsUpdate = true;
      }
      camera.position.x += (Math.sin(t * 0.00009) * 0.5 + mx * 0.5 - camera.position.x) * 0.04;
      camera.position.y += (1.15 + my * 0.3 - camera.position.y) * 0.04;
      camera.position.z += (5.4 - camPush * 1.25 - camera.position.z) * 0.06; // (F) dolly in on reveal
      camera.lookAt(0, 0.12, 0);
      if (bloom) bloom.strength = 0.58 + charge * 0.28 + winF * 0.7; // (D) bloom swells on charge/win
      if (composer) composer.render(); else renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(tick);

    const flashEl = q('flash');
    const flashDom = (v: number) => { if (RM) return; flashEl.style.opacity = String(v); setTimeout(() => (flashEl.style.opacity = '0'), 130); };

    /* ---------------- HUD helpers ---------------- */
    const celEl = q('celebrate'), celBig = q('celBig'), celAmt = q('celAmt');
    const celebrate = (kind: string, big: string, amt: string) => {
      celEl.className = 'a3-celebrate ' + kind; celBig.textContent = big; celAmt.textContent = amt;
      void celEl.offsetWidth; celEl.classList.add('a3-show'); setTimeout(() => celEl.classList.remove('a3-show'), RM ? 0 : 1400);
    };
    const thoughtEl = q('thought');
    const type = (text: string, lead: string) => new Promise<void>((res) => {
      if (RM || !text) { thoughtEl.innerHTML = `<span class="a3-lead">${lead}</span> ${escapeHtml(text)} <span class="a3-cur">▌</span>`; return res(); }
      let i = 0;
      const step = () => { if (stopped) return res();
        thoughtEl.innerHTML = `<span class="a3-lead">${lead}</span> ${escapeHtml(text.slice(0, i))}<span class="a3-cur">▌</span>`;
        if (i < text.length) { i++; setTimeout(step, 19); } else res(); };
      step();
    });
    const feedEl = q('feed');
    const pushFeed = (icon: string, tag: string, what: string, val: string, kind: string) => {
      const r = document.createElement('div'); r.className = 'a3-fr ' + kind;
      r.innerHTML = `<span class="a3-i">${icon}</span><span class="a3-x"><b>${escapeHtml(tag)}</b> ${escapeHtml(what)}</span><span class="a3-fv">${escapeHtml(val)}</span>`;
      feedEl.prepend(r); while (feedEl.children.length > 6) feedEl.lastChild!.remove();
    };
    function escapeHtml(s: string) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

    /* ---------------- standings (from real league) ---------------- */
    const cardsEl = q('cards'), podEl = q('podium');
    let league: AstridBot[] = [];
    const prevRank: Record<string, number> = {};
    const cardById: Record<string, HTMLElement> = {};

    function buildCards() {
      cardsEl.innerHTML = ''; for (const k in cardById) delete cardById[k];
      for (const b of league) {
        const sm = styleOf(b.style);
        const el = document.createElement('div'); el.className = 'a3-pc'; el.dataset.aid = b.name;
        el.style.setProperty('--a3-ac', sm.css); el.style.setProperty('--a3-tint', sm.tint);
        el.innerHTML = `<span class="a3-sw"></span><span class="a3-cr">${crestOf(b.style, sm.css)}</span>
          <div class="a3-info"><div class="a3-nm">@${escapeHtml(b.name)}</div><div class="a3-rk"><span class="a3-rkn">#—</span> <span class="a3-mv"></span></div></div>
          <div class="a3-bank"><div class="a3-b"><span class="a3-bv">0</span> <em>UCT</em></div><div class="a3-rc"><span class="a3-w">0W</span>·<span class="a3-l">0L</span>·0T</div></div>`;
        cardsEl.appendChild(el); cardById[b.name] = el;
      }
    }
    function renderStandings() {
      const sorted = [...league].sort((x, y) => (y.board?.earnedUct ?? 0) - (x.board?.earnedUct ?? 0) || (y.board?.wins ?? 0) - (x.board?.wins ?? 0));
      const first: Record<string, number> = {}; league.forEach((b) => { const el = cardById[b.name]; if (el) first[b.name] = el.getBoundingClientRect().top; });
      sorted.forEach((b, i) => {
        const el = cardById[b.name]; if (!el) return; cardsEl.appendChild(el);
        const rank = i + 1, prev = prevRank[b.name]; prevRank[b.name] = rank;
        el.querySelector('.a3-rkn')!.textContent = '#' + rank;
        const mv = el.querySelector('.a3-mv')!;
        if (prev && prev > rank) { mv.textContent = '▲'; mv.className = 'a3-mv a3-up'; }
        else if (prev && prev < rank) { mv.textContent = '▼'; mv.className = 'a3-mv a3-dn'; }
        else { mv.textContent = ''; mv.className = 'a3-mv'; }
        el.querySelector('.a3-bv')!.textContent = String(b.board?.earnedUct ?? 0);
        el.querySelector('.a3-rc')!.innerHTML = `<span class="a3-w">${b.board?.wins ?? 0}W</span>·<span class="a3-l">${b.board?.losses ?? 0}L</span>·${b.board?.ties ?? 0}T`;
      });
      if (!RM) league.forEach((b) => { const el = cardById[b.name]; if (!el) return; const last = el.getBoundingClientRect().top, dy = (first[b.name] ?? last) - last;
        if (dy) { el.style.transform = `translateY(${dy}px)`; el.style.transition = 'none'; requestAnimationFrame(() => { el.style.transition = ''; el.style.transform = ''; }); } });
      const mc = ['#ffcf4d', '#9aa7b8', '#c8823f'];
      podEl.innerHTML = sorted.slice(0, 3).map((b, i) => {
        const sm = styleOf(b.style); const ring = mc[i] ?? '#ffcf4d';
        return `<div class="a3-lead a3-l${i + 1}" style="--ring:${ring}">${i === 0 ? '<span class="a3-crown">♛</span>' : ''}<div class="a3-ring"><span class="a3-ringcrest">${crestOf(b.style, sm.css)}</span><span class="a3-rankn">${i + 1}</span></div><div class="a3-lname">@${escapeHtml(b.name)}</div><div class="a3-learn">${b.board?.earnedUct ?? 0} <em>UCT</em></div></div>`;
      }).join('');
    }

    /* ---------------- real-data poll + play queue ---------------- */
    let queue: Play[] = [];
    async function refresh() {
      try {
        const [av, lb] = await Promise.all([fetchAstrid(), fetchLeaderboard().catch(() => null)]);
        if (stopped) return;
        if (av.ready && av.league?.length) { league = av.league; buildCards(); renderStandings(); q('idle').style.display = 'none'; }
        // real jackpot pool
        const pot = lb?.houseStats?.jackpotUct;
        if (typeof pot === 'number') q('pot').innerHTML = `${pot}<small> UCT</small>`;
        const rp = lb?.houseStats?.roundsPlayed;
        if (typeof rp === 'number') q('rounds').textContent = `${rp.toLocaleString()} ROUNDS`;
        if (av.runtime?.kernel) q('kernel').textContent = av.runtime.kernel;
        // rebuild the play queue from the capsule's REAL reported sessions
        const plays: Play[] = [];
        for (const s of av.sessions ?? []) for (const l of s.lines ?? [])
          plays.push({ name: s.name, style: s.style, game: l.game, bet: l.bet, outcome: l.outcome, reason: l.reason, source: l.source });
        if (plays.length) queue = plays;
      } catch { /* keep the last good data + keep playing the queue */ }
    }

    /* ---------------- the play (one real reported decision) ---------------- */
    const setActing = (name: string, css: string) => {
      root.querySelectorAll('.a3-pc.a3-acting').forEach((e) => e.classList.remove('a3-acting'));
      cardById[name]?.classList.add('a3-acting');
      q('nowpanel').style.setProperty('--a3-ac', css);
    };
    async function playOne(p: Play) {
      const sm = styleOf(p.style);
      setHero(p.game); // (E) morph the centre to this game's shape
      setActing(p.name, sm.css); Core.agent(sm.hex);
      q('nowCrest').innerHTML = crestOf(p.style, sm.css);
      q('nowName').textContent = `@${p.name}`;
      q('nowSt').textContent = `${p.style} · bet ${p.bet} · ${p.game}`;
      const phase = q('phase');

      phase.textContent = 'reasoning'; phase.className = 'a3-npp a3-on';
      const reason = p.reason && p.reason !== 'entropy pick' ? p.reason : 'entropy pick — no strategist key this session';
      await type(reason, '[strategist]'); if (stopped) return; await wait(430);

      phase.textContent = 'commit'; Core.commit();
      const secret = hexs(32), nonce = hexs(16), commit = await sha256(`${secret}:${nonce}`);
      q('commitH').textContent = commit; q('commit').classList.add('a3-lock');
      const rev = q('reveal'); rev.classList.remove('a3-open'); q('revealH').textContent = 'sealed';
      const vf = q('vf'); vf.className = 'a3-vf'; vf.textContent = '○ verifying…';
      const oc = q('oc'); oc.className = 'a3-oc'; q('res').textContent = '—'; q('amt').textContent = '';
      await wait(820); if (stopped) return;

      phase.textContent = 'reveal'; Core.reveal(p.outcome); sfx.bet(); // (E) per-hero settle + (C) soft roll tick
      q('revealH').innerHTML = `secret <b style="color:var(--a3-dim)">${secret.slice(0, 12)}…</b> · nonce <b style="color:var(--a3-dim)">${nonce}</b>`;
      rev.classList.add('a3-open');
      const check = await sha256(`${secret}:${nonce}`);
      vf.className = check === commit ? 'a3-vf a3-ok' : 'a3-vf';
      vf.textContent = check === commit ? '✓ scheme verified · sha256 re-derived in-browser' : '✗ mismatch';
      await wait(470); if (stopped) return;

      phase.textContent = 'settled'; phase.className = 'a3-npp'; Core.settle();
      const win = p.outcome === 'win', lose = p.outcome === 'lose';
      if (win) {
        oc.className = 'a3-oc a3-win'; q('res').textContent = 'WIN'; q('amt').textContent = `bet ${p.bet}`;
        pushFeed('▲', `@${p.name}`, `won ${p.game}`, `+ ${p.game}`, 'a3-win'); Core.win(sm.hex); sfx.win(); celebrate('a3-win', 'Win', `@${p.name} · ${p.game}`);
      } else if (lose) {
        oc.className = 'a3-oc a3-lose'; q('res').textContent = 'LOSS'; q('amt').textContent = `bet ${p.bet}`;
        pushFeed('▽', `@${p.name}`, `lost ${p.game}`, `− ${p.bet}`, 'a3-lose');
      } else if (p.outcome === 'stop') {
        oc.className = 'a3-oc a3-neutral'; q('res').textContent = 'STOP'; q('amt').textContent = 'bankroll kept';
        pushFeed('—', `@${p.name}`, 'stopped — bankroll protected', '0', '');
      } else if (p.outcome === 'skip') {
        oc.className = 'a3-oc a3-neutral'; q('res').textContent = 'SKIP'; q('amt').textContent = 'out of chips';
        pushFeed('—', `@${p.name}`, `sat out ${p.game}`, '0', '');
      } else {
        oc.className = 'a3-oc a3-neutral'; q('res').textContent = 'TIE'; q('amt').textContent = `bet ${p.bet}`;
        pushFeed('=', `@${p.name}`, `tied ${p.game}`, '±0', '');
      }
      await wait(1500);
    }

    /* ---------------- main loop ---------------- */
    let qi = 0;
    async function loop() {
      while (!stopped) {
        if (!queue.length) { await wait(2500); continue; }
        const p = queue[qi % queue.length]; qi++;
        if (!p) { await wait(500); continue; }
        await playOne(p); if (stopped) return;
        if (qi % queue.length === 0) await refresh(); // one full pass → pull fresh reports
      }
    }

    // boot
    void (async () => {
      await refresh();
      if (stopped) return;
      if (!league.length) q('idle').style.display = '';
      setTimeout(() => { if (!stopped) void loop(); }, RM ? 200 : 900);
    })();
    const pollId = window.setInterval(() => void refresh(), 30_000);

    /* ---------------- cleanup ---------------- */
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      clearInterval(pollId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('resize', onResize);
      composer?.dispose();
      renderer.dispose();
      env.dispose(); dieTex.forEach((t) => t.dispose()); coinFaceTex.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = (m as THREE.Mesh).material;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else if (mat) (mat as THREE.Material).dispose();
      });
    };
  }, []);

  return (
    <div className="a3-root" ref={rootRef}>
      <canvas className="a3-gl" data-el="gl" />
      <div className="a3-vig" />
      <div className="a3-flash" data-el="flash" />

      <div className="a3-hud">
        <header className="a3-top a3-rise">
          <div className="a3-brand">
            <svg className="a3-mark" viewBox="0 0 100 100" aria-label="Unicity Arcade House">
              <defs><linearGradient id="a3logo" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ff9a4d" /><stop offset="100%" stopColor="#ff6f00" /></linearGradient></defs>
              <rect x="8" y="8" width="84" height="84" rx="20" fill="url(#a3logo)" />
              <circle cx="32" cy="32" r="7" fill="#0a0a0a" /><circle cx="68" cy="32" r="7" fill="#0a0a0a" />
              <circle cx="50" cy="50" r="7" fill="#0a0a0a" />
              <circle cx="32" cy="68" r="7" fill="#0a0a0a" /><circle cx="68" cy="68" r="7" fill="#0a0a0a" />
            </svg>
            <div>
              <h1>Unicity <b>Arena</b></h1>
              <div className="a3-sea"><span className="a3-s">AUTONOMOUS LEAGUE</span> · <span data-el="rounds">LIVE</span></div>
            </div>
          </div>
          <div className="a3-tr">
            <button className="a3-mute" onClick={toggleMute} aria-label={muted ? 'unmute' : 'mute'} title={muted ? 'unmute sounds' : 'mute sounds'}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M4 9 v6 h4 l5 4 V5 L8 9 Z" fill="currentColor" />
                {muted
                  ? <path d="M16 9 l5 6 M21 9 l-5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  : <><path d="M15.5 9.5 a4 4 0 0 1 0 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><path d="M18 7.5 a7.5 7.5 0 0 1 0 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></>}
              </svg>
            </button>
            <a className="a3-back" href="/" onClick={(e) => { e.preventDefault(); go('/'); }}>‹ back to the arcade</a>
            <span className="a3-live"><span className="a3-d" /> live · testnet2</span>
            <div className="a3-prize">
              <svg viewBox="0 0 100 100"><path d="M30 18h40v14a20 20 0 01-40 0z" fill="#ffcf4d" /><path d="M30 22H18a10 10 0 0012 12M70 22h12a10 10 0 01-12 12" fill="none" stroke="#ffcf4d" strokeWidth="5" /><rect x="44" y="50" width="12" height="16" fill="#ffcf4d" /><rect x="32" y="66" width="36" height="8" rx="2" fill="#ffcf4d" /><rect x="36" y="74" width="28" height="8" rx="2" fill="#c8823f" /></svg>
              <div><div className="a3-k">jackpot pool</div><div className="a3-v" data-el="pot">—<small> UCT</small></div></div>
            </div>
          </div>
        </header>

        <div className="a3-mid">
          <section className="a3-panel a3-nowpanel a3-rise" data-el="nowpanel" style={{ animationDelay: '.26s' }}>
            <div className="a3-nowhead">
              <span className="a3-npc" data-el="nowCrest" />
              <div><div className="a3-npn" data-el="nowName">warming up</div><div className="a3-nps" data-el="nowSt">the league takes the floor</div></div>
              <span className="a3-npp" data-el="phase">idle</span>
            </div>
            <div className="a3-thought" data-el="thought"><span className="a3-cur">▌</span></div>
            <div className="a3-fair" style={{ marginTop: '10px' }}>
              <div className="a3-ho a3-commit" data-el="commit"><div className="a3-k">house commit · sha256(secret:nonce)</div><div className="a3-h" data-el="commitH">—</div></div>
              <div className="a3-ho a3-reveal" data-el="reveal"><div className="a3-k">reveal</div><div className="a3-h" data-el="revealH">sealed</div><div className="a3-vf" data-el="vf">○ verifying…</div></div>
              <div className="a3-oc" data-el="oc"><span className="a3-r" data-el="res">—</span><span className="a3-a" data-el="amt" /></div>
            </div>
          </section>

          <div className="a3-center">
            <div className="a3-kicker a3-rise">four <b>autonomous</b> agents · <b>provably-fair</b> · live on <b data-el="kernel">Unicity AOS</b></div>
          </div>

          <aside className="a3-rightrail">
            <section className="a3-panel a3-rise" style={{ animationDelay: '.14s' }}>
              <div className="a3-ph"><span className="a3-t">League Standings</span><span className="a3-n">earnings · live</span></div>
              <div className="a3-podium" data-el="podium" />
              <div className="a3-cards" data-el="cards" />
              <div className="a3-idle" data-el="idle" style={{ display: 'none' }}>the league is between sessions — standings load as the capsule reports…</div>
            </section>
            <section className="a3-panel a3-rise" style={{ animationDelay: '.2s' }}>
              <div className="a3-ph"><span className="a3-t">Live Feed</span><span className="a3-n">real decisions</span></div>
              <div className="a3-feed" data-el="feed" />
            </section>
          </aside>

          <div className="a3-celebrate" data-el="celebrate"><div className="a3-big" data-el="celBig" /><div className="a3-camt" data-el="celAmt" /></div>
        </div>
      </div>
    </div>
  );
}
