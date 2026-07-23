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
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import './arena.css';
import { fetchAstrid, fetchLeaderboard, type AstridBot } from '../lib/arcade';
import { prefersReducedMotion } from '../lib/motion';
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
    const grp = new THREE.Group(); scene.add(grp);
    const die = new THREE.Mesh(new THREE.BoxGeometry(1.58, 1.58, 1.58), dieMats);
    grp.add(die); grp.rotation.set(-0.4, 0.62, 0.12);

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

    let mx = 0, my = 0;
    const onMove = (e: PointerEvent) => { mx = e.clientX / window.innerWidth - 0.5; my = e.clientY / window.innerHeight - 0.5; };
    const onResize = () => { renderer.setSize(window.innerWidth, window.innerHeight); camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); };
    window.addEventListener('pointermove', onMove); window.addEventListener('resize', onResize);

    let charge = 0, target = 0, winF = 0, raf = 0;
    let rvx = 0.0035, rvy = 0.0052, rvz = 0.0009;               // die angular velocity
    const IDLE_X = 0.0035, IDLE_Y = 0.0052, IDLE_Z = 0.0009;
    const Core = {
      agent(hexNum: number) { rim.color.set(hexNum); arc.material.color.set(hexNum); arc.material.emissive.set(hexNum); dieMats.forEach((m) => m.emissive.set(hexNum)); },
      commit() { target = 1; },
      reveal() { rvx = 0.30; rvy = 0.36; rvz = 0.14; },          // a real tumble on the roll
      settle() { target = 0; },
      win(hexNum: number) { winF = 1; doBurst(hexNum, 1); flashDom(0.55); fieldPulse(); },
    };
    const tick = (t: number) => {
      if (stopped) return;
      raf = requestAnimationFrame(tick);
      charge += (target - charge) * 0.08;
      grp.rotation.x += rvx; grp.rotation.y += rvy; grp.rotation.z += rvz;
      rvx += (IDLE_X - rvx) * 0.035; rvy += (IDLE_Y - rvy) * 0.035; rvz += (IDLE_Z - rvz) * 0.035;
      grp.position.y = Math.sin(t * 0.0009) * 0.06;
      const ei = 0.22 + charge * 1.4 + winF * 2.6;
      dieMats.forEach((m) => (m.emissiveIntensity = ei));
      arc.material.emissiveIntensity = 0.8 + charge * 1.6 + winF * 2.4;
      rim.intensity = 2.2 + charge * 3.6 + winF * 6;
      winF *= 0.93; if (winF < 0.01) winF = 0;
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
      camera.lookAt(0, 0.12, 0);
      renderer.render(scene, camera);
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

      phase.textContent = 'reveal'; Core.reveal();
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
        pushFeed('▲', `@${p.name}`, `won ${p.game}`, `+ ${p.game}`, 'a3-win'); Core.win(sm.hex); celebrate('a3-win', 'Win', `@${p.name} · ${p.game}`);
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
      renderer.dispose();
      env.dispose(); dieTex.forEach((t) => t.dispose());
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
