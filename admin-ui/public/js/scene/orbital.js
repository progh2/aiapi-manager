// 3D 궤도 관제도. 코어=프록시, 행성=학급, 위성=학생 키, 아래 고리=공급자 엔진.
// 실제 호출이 들어오면 위성→행성→코어→엔진으로 입자가 흐르고, 거절된 호출은 코어에서 붉게 튕긴다.
// 화면 조작은 모두 패널에서도 할 수 있다. 3D 는 보조 표시다.
import * as THREE from "three";

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const C = {
  cyan: new THREE.Color("#189fcf"),
  hud: new THREE.Color("#5fdcff"),
  amber: new THREE.Color("#fab219"),
  red: new THREE.Color("#d03b3b"),
  hot: new THREE.Color("#ff5a5a"),
  green: new THREE.Color("#0ca30c"),
  mint: new THREE.Color("#58f0c0"),
  steel: new THREE.Color("#3b6a93"),
  grey: new THREE.Color("#46576a"),
  violet: new THREE.Color("#b3a3ff"),
  dimRed: new THREE.Color("#6e2530"),
  white: new THREE.Color("#e6fbff"),
};

const PRESETS = {
  bridge: { dist: 1.22, polar: 60, spin: 0.035, target: "core", lift: -6 },
  telemetry: { dist: 1.3, polar: 16, spin: 0.012, target: "core" },
  keys: { dist: 0.8, polar: 74, spin: 0.02, target: "core" },
  classes: { dist: 0.92, polar: 46, spin: 0.028, target: "core" },
  launch: { dist: 0.48, polar: 80, spin: 0.035, target: "core" },
  engines: { dist: 0.66, polar: 98, spin: 0.022, target: "engines" },
  crew: { dist: 0.95, polar: 66, spin: 0.015, target: "core" },
  log: { dist: 1.2, polar: 32, spin: 0.01, target: "core" },
  pilot: { dist: 1.0, polar: 62, spin: 0.03, target: "core", lift: -4 },
};

function glowTexture(inner = "rgba(255,255,255,1)", outer = "rgba(255,255,255,0)") {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.25, "rgba(255,255,255,0.55)");
  grd.addColorStop(0.6, "rgba(255,255,255,0.12)");
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function planetTexture(seed) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const g = c.getContext("2d");
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const base = g.createLinearGradient(0, 0, 0, 128);
  base.addColorStop(0, "#9fb4c8");
  base.addColorStop(0.5, "#ffffff");
  base.addColorStop(1, "#8ea4b8");
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 18; i++) {
    const y = rnd() * 128;
    const h = 2 + rnd() * 10;
    g.fillStyle = `rgba(${rnd() > 0.5 ? "20,40,60" : "255,255,255"},${0.08 + rnd() * 0.16})`;
    g.fillRect(0, y, 256, h);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

function usageColor(ratio, locked) {
  if (locked) return C.dimRed.clone();
  if (ratio == null) return C.steel.clone();
  if (ratio >= 1) return C.red.clone();
  if (ratio >= 0.8) return C.amber.clone();
  if (ratio >= 0.6) return C.cyan.clone().lerp(C.amber, (ratio - 0.6) / 0.2);
  return C.cyan.clone();
}

function circleGeometry(radius, segments = 128) {
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
}

export function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return Boolean(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
  } catch {
    return false;
  }
}

export function createOrbital({ canvas, labelsEl, quality = "high", reduceMotion = false, onPick, onHover, onQuality }) {
  if (!webglAvailable()) return null;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== "low", alpha: true, powerPreference: "high-performance" });
  } catch {
    return null;
  }
  let lowQ = quality === "low";
  const setPixelRatio = () => renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowQ ? 1 : 1.75));
  setPixelRatio();
  renderer.setClearColor(0x000000, 0);
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x030812, 0.0042);
  const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 3000);
  const glow = glowTexture();

  scene.add(new THREE.AmbientLight(0x6f8fb3, 0.55));
  const hemi = new THREE.HemisphereLight(0x8fdcff, 0x0a1426, 0.45);
  scene.add(hemi);
  const coreLight = new THREE.PointLight(0x9fe8ff, 2.4, 0, 0);
  scene.add(coreLight);

  // ---------------------------------------------------------------- 별과 성운
  const stars = (() => {
    const group = new THREE.Group();
    const layer = (count, rMin, rMax, size, opacity) => {
      const pos = new Float32Array(count * 3);
      const col = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const r = rMin + Math.random() * (rMax - rMin);
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
        pos[i * 3 + 1] = r * Math.cos(ph) * 0.7;
        pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
        const tint = Math.random();
        const c = tint < 0.15 ? new THREE.Color("#ffd9a8") : tint < 0.45 ? new THREE.Color("#a9ddff") : new THREE.Color("#ffffff");
        col.set([c.r, c.g, c.b], i * 3);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      const mat = new THREE.PointsMaterial({ size, map: glow, vertexColors: true, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: false });
      group.add(new THREE.Points(geo, mat));
    };
    layer(lowQ ? 900 : 2600, 380, 900, 2.2, 0.8);
    layer(lowQ ? 60 : 180, 300, 700, 5.5, 0.9);
    const neb = [["#1b4d9c", -420, 120, -520, 520], ["#5a2a8f", 460, -60, -480, 460], ["#0f6b7a", 60, 260, -700, 600]];
    for (const [color, x, y, z, s] of neb) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: new THREE.Color(color), transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      sp.position.set(x, y, z);
      sp.scale.setScalar(s);
      group.add(sp);
    }
    scene.add(group);
    return group;
  })();

  // ---------------------------------------------------------------- 코어
  const core = new THREE.Group();
  scene.add(core);
  const coreBall = new THREE.Mesh(new THREE.SphereGeometry(1.6, 32, 24), new THREE.MeshBasicMaterial({ color: C.white }));
  core.add(coreBall);
  const coreShell = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(2.6, 1)),
    new THREE.LineBasicMaterial({ color: C.hud, transparent: true, opacity: 0.75 })
  );
  core.add(coreShell);
  const coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: C.hud, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
  coreGlow.scale.setScalar(11);
  core.add(coreGlow);
  const alarmGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: C.hot, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  alarmGlow.scale.setScalar(14);
  core.add(alarmGlow);
  const coreRings = [];
  for (const [r, tilt, speed, op] of [[3.6, 0.35, 0.6, 0.55], [4.4, -0.9, -0.35, 0.35], [5.3, 1.3, 0.22, 0.22]]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.035, 8, 128), new THREE.MeshBasicMaterial({ color: C.hud, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.rotation.x = Math.PI / 2 + tilt;
    ring.userData.speed = speed;
    core.add(ring);
    coreRings.push(ring);
  }
  const grid = new THREE.PolarGridHelper(60, 16, 8, 96, 0x1d5f86, 0x123a55);
  grid.position.y = -3.2;
  for (const m of [].concat(grid.material)) { m.transparent = true; m.opacity = 0.28; m.depthWrite = false; }
  scene.add(grid);

  // ---------------------------------------------------------------- 동적 데이터 층
  const world = new THREE.Group();
  scene.add(world);
  let planets = [];
  let engines = [];
  let sats = [];
  let satMesh = null;
  let satPoints = null;
  const beams = new THREE.Group();
  world.add(beams);
  let fitRadius = 30;
  let labelNodes = [];

  const ZERO = new THREE.Vector3();
  const tmpM = new THREE.Matrix4();
  const tmpV = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const tmpS = new THREE.Vector3();

  function disposeObj(obj) {
    obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) [].concat(o.material).forEach((m) => { if (m.map && m.map !== glow) m.map.dispose(); m.dispose(); });
    });
  }

  function clearWorld() {
    for (const p of planets) { world.remove(p.group); world.remove(p.orbit); disposeObj(p.group); disposeObj(p.orbit); }
    for (const e of engines) { world.remove(e.group); disposeObj(e.group); }
    beams.children.slice().forEach((b) => { beams.remove(b); disposeObj(b); });
    if (satMesh) { world.remove(satMesh); disposeObj(satMesh); satMesh = null; }
    if (satPoints) { world.remove(satPoints); disposeObj(satPoints); satPoints = null; }
    planets = [];
    engines = [];
    sats = [];
  }

  function label(cls = "") {
    const el = document.createElement("div");
    el.className = `s-label ${cls}`;
    labelsEl.appendChild(el);
    labelNodes.push(el);
    return el;
  }

  function resetLabels() {
    labelNodes.forEach((n) => n.remove());
    labelNodes = [];
  }

  let coreLabel = null;
  let signature = "";

  /**
   * data: { teams:[{id,name,ratio,spend,budget,session:'open'|'closed'|'always',locked,keys:n}],
   *         keys:[{id,team,state,camp,alias,spend,budget}], engines:[{id,name,ratio,remaining,pool,members:[ids]}] }
   */
  function setData(data) {
    // 학급·키·엔진 구성이 바뀔 때만 다시 만든다. 값(색·라벨)은 매번 갱신한다.
    const sig = [
      data.teams.map((t) => t.id).join(","),
      data.keys.map((k) => `${k.id}:${k.team || ""}`).join(","),
      data.engines.map((e) => e.id).join(","),
    ].join("|");
    const rebuild = sig !== signature;
    signature = sig;
    if (rebuild) {
      clearWorld();
      resetLabels();
      coreLabel = label("core");
      coreLabel.textContent = "PROXY CORE";
    }
    // 학급 행성
    const teams = data.teams;
    const maxKeys = Math.max(1, ...teams.map((t) => t.keys));
    teams.forEach((t, i) => {
      let p = planets[i];
      const radius = 1.05 + 1.45 * Math.sqrt(t.keys / maxKeys);
      if (rebuild) {
        const orbitR = 13 + i * 6.2;
        const group = new THREE.Group();
        const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: planetTexture(i + 3), roughness: 0.78, metalness: 0.08, emissive: 0x000000, emissiveIntensity: 0.35 });
        const body = new THREE.Mesh(new THREE.SphereGeometry(1, lowQ ? 20 : 36, lowQ ? 14 : 24), mat);
        group.add(body);
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
        group.add(halo);
        const ringMat = new THREE.MeshBasicMaterial({ color: C.hud, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
        const ring = new THREE.Mesh(new THREE.RingGeometry(1.45, 1.62, 64), ringMat);
        ring.rotation.x = Math.PI / 2.3;
        group.add(ring);
        const hazardMat = new THREE.MeshBasicMaterial({ color: C.red, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
        const hazard = new THREE.Mesh(new THREE.RingGeometry(1.8, 2.05, 6, 1), hazardMat);
        hazard.rotation.x = Math.PI / 2;
        group.add(hazard);
        const orbit = new THREE.LineLoop(circleGeometry(orbitR), new THREE.LineBasicMaterial({ color: 0x2a6f9a, transparent: true, opacity: 0.35 }));
        world.add(orbit);
        world.add(group);
        const lab = label();
        p = { id: t.id, group, body, halo, ring, hazard, orbit, orbitR, angle: i * GOLDEN * 3.1, speed: 0.06 / Math.sqrt(orbitR / 13), label: lab, radius, data: t };
        planets[i] = p;
      }
      p.data = t;
      p.radius = radius;
      p.body.scale.setScalar(radius);
      const col = usageColor(t.ratio, t.locked);
      p.body.material.color.copy(col).lerp(C.white, 0.35);
      p.body.material.emissive.copy(col).multiplyScalar(0.35);
      p.halo.material.color.copy(col);
      p.halo.scale.setScalar(radius * 5.2);
      p.ring.scale.setScalar(radius);
      p.hazard.scale.setScalar(radius);
      const ringColor = t.locked ? C.red : t.session === "open" ? C.green : t.session === "always" ? C.hud : C.grey;
      p.ring.material.color.copy(ringColor);
      p.ring.material.opacity = t.session === "closed" ? 0.35 : 0.8;
      p.hazard.material.opacity = t.locked ? 0.9 : 0;
      const pct = t.ratio == null ? "예산 없음" : `${Math.round(t.ratio * 100)}%`;
      const sess = t.locked ? '<span class="lk">봉쇄</span>' : t.session === "open" ? "수업 중" : t.session === "closed" ? "수업 외" : "항상";
      // note 가 있으면(학생 화면) 예산·시간 대신 그 글을 쓴다.
      p.label.innerHTML = t.note
        ? `${escapeHtml(t.name)}<small>${escapeHtml(t.note)}</small>`
        : `${escapeHtml(t.name)}<small>${pct} · ${sess} · 키 ${t.keys}</small>`;
      p.label.classList.toggle("dim", t.session === "closed" && !t.locked);
    });
    fitRadius = Math.max(24, 13 + Math.max(0, teams.length - 1) * 6.2 + 6);

    // 공급자 엔진
    if (rebuild) {
      const list = data.engines;
      const plain = list.filter((e) => !e.pool);
      const pools = list.filter((e) => e.pool);
      const place = (arr, radius, y) => arr.forEach((e, i) => {
        const a = (i / Math.max(1, arr.length)) * Math.PI * 2 + Math.PI / 4;
        const group = new THREE.Group();
        group.position.set(Math.cos(a) * radius, y, Math.sin(a) * radius);
        const shape = e.pool ? new THREE.TorusKnotGeometry(0.62, 0.16, 64, 8) : new THREE.OctahedronGeometry(0.95, 0);
        const inner = new THREE.Mesh(shape, new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x000000, emissiveIntensity: 0.6, roughness: 0.4, metalness: 0.5 }));
        const wire = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.OctahedronGeometry(1.35, 0)), new THREE.LineBasicMaterial({ color: C.hud, transparent: true, opacity: 0.5 }));
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
        halo.scale.setScalar(5);
        group.add(inner, wire, halo);
        world.add(group);
        const beamGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -1.6, 0), group.position.clone()]);
        const beam = new THREE.Line(beamGeo, new THREE.LineBasicMaterial({ color: 0x2f86b8, transparent: true, opacity: 0.35 }));
        beams.add(beam);
        const lab = label();
        lab.style.visibility = engineLabels ? "" : "hidden";
        engines.push({ id: e.id, group, inner, wire, halo, label: lab, data: e, pool: e.pool });
      });
      place(plain, 17, -13);
      place(pools, 9, -21);
      // 묶음과 멤버 엔진을 잇는다.
      for (const pe of engines.filter((x) => x.pool)) {
        for (const mid of pe.data.members || []) {
          const m = engines.find((x) => x.id === mid);
          if (!m) continue;
          const g = new THREE.BufferGeometry().setFromPoints([pe.group.position.clone(), m.group.position.clone()]);
          beams.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x9085e9, transparent: true, opacity: 0.45 })));
        }
      }
    }
    for (const e of engines) {
      const d = data.engines.find((x) => x.id === e.id) || e.data;
      e.data = d;
      const col = d.ratio == null ? C.hud : d.ratio <= 0 ? C.red : d.ratio <= 0.2 ? C.amber : C.mint;
      e.inner.material.color.copy(col).lerp(C.white, 0.2);
      e.inner.material.emissive.copy(col).multiplyScalar(0.55);
      e.halo.material.color.copy(col);
      e.label.innerHTML = `${escapeHtml(d.name)}<small>${d.pool ? "묶음 · " : ""}${d.remainingText || ""}</small>`;
    }

    // 학생 키 위성
    const keys = data.keys;
    if (rebuild) {
      const geo = new THREE.IcosahedronGeometry(0.3, 0);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      satMesh = new THREE.InstancedMesh(geo, mat, Math.max(1, keys.length));
      satMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      satMesh.count = keys.length;
      world.add(satMesh);
      const pos = new Float32Array(Math.max(1, keys.length) * 3);
      const col = new Float32Array(Math.max(1, keys.length) * 3);
      const pg = new THREE.BufferGeometry();
      pg.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      pg.setAttribute("color", new THREE.BufferAttribute(col, 3));
      satPoints = new THREE.Points(pg, new THREE.PointsMaterial({ size: lowQ ? 1.6 : 2.2, map: glow, vertexColors: true, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }));
      satPoints.frustumCulled = false;
      world.add(satPoints);
      const perHost = new Map();
      sats = keys.map((k, i) => {
        const host = planets.findIndex((p) => p.id === k.team);
        const hostKey = host >= 0 ? host : "core";
        const n = perHost.get(hostKey) || 0;
        perHost.set(hostKey, n + 1);
        return { id: k.id, host, n, phase: n * GOLDEN * 2 + i * 0.01, tilt: ((n * 37) % 90 - 45) * (Math.PI / 180) * 0.6, lane: n % 3, speed: 0.35 + ((n * 13) % 10) / 30, pos: new THREE.Vector3(), data: k, i };
      });
    }
    const colors = satPoints ? satPoints.geometry.getAttribute("color") : null;
    keys.forEach((k, i) => {
      const s = sats[i];
      if (!s) return;
      s.data = k;
      const col = k.state === "active" ? (k.camp ? C.violet : C.hud)
        : k.state === "warn" ? C.amber
          : k.state === "over" ? C.hot
            : k.state === "blocked" || k.state === "locked" ? C.dimRed
              : C.grey;
      satMesh.setColorAt(i, col);
      if (colors) {
        const glowCol = (k.state === "blocked" || k.state === "locked" || k.state === "expired") ? new THREE.Color(0x000000) : col;
        colors.setXYZ(i, glowCol.r, glowCol.g, glowCol.b);
      }
    });
    if (satMesh && satMesh.instanceColor) satMesh.instanceColor.needsUpdate = true;
    if (colors) colors.needsUpdate = true;
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------------------------------------------------------------- 호출 입자
  const MAX_P = 160;
  const pPos = new Float32Array(MAX_P * 3);
  const pCol = new Float32Array(MAX_P * 3);
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
  pGeo.setAttribute("color", new THREE.BufferAttribute(pCol, 3).setUsage(THREE.DynamicDrawUsage));
  const pMesh = new THREE.Points(pGeo, new THREE.PointsMaterial({ size: 1.9, map: glow, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }));
  pMesh.frustumCulled = false;
  scene.add(pMesh);
  const particles = [];
  let alarm = 0;

  function engineFor(item) {
    if (!engines.length) return null;
    const model = String(item.model || "");
    const slash = model.indexOf("/");
    if (slash > 0) {
      const slug = model.slice(0, slash);
      const hit = engines.find((e) => e.data.slug === slug);
      if (hit) return hit;
    }
    return engines.find((e) => e.id === "env") || engines[0];
  }

  function pulse(items) {
    for (const it of items.slice(0, 40)) {
      const idx = sats.findIndex((s) => s.id === it.token);
      const start = idx >= 0 ? sats[idx].pos.clone() : new THREE.Vector3((Math.random() - 0.5) * 30, 2, (Math.random() - 0.5) * 30);
      const host = idx >= 0 && sats[idx].host >= 0 ? planets[sats[idx].host].group.position.clone() : start.clone().multiplyScalar(0.6);
      const eng = it.ok ? engineFor(it) : null;
      const path = [start, host, new THREE.Vector3(0, 0, 0)];
      if (eng) path.push(eng.group.position.clone());
      particles.push({ path, t: -Math.random() * 0.6, dur: it.ok ? 2.2 : 1.5, ok: it.ok });
      if (particles.length > MAX_P) particles.shift();
    }
  }

  function along(path, u, out) {
    const segs = path.length - 1;
    const f = Math.min(0.9999, Math.max(0, u)) * segs;
    const i = Math.floor(f);
    const t = f - i;
    const a = path[i];
    const b = path[i + 1];
    out.lerpVectors(a, b, t);
    out.y += Math.sin(t * Math.PI) * (i === 1 ? 2.2 : 0.8);
    return out;
  }

  // ---------------------------------------------------------------- 카메라
  const cam = { radius: 60, polar: 1.05, azimuth: 0.6, target: new THREE.Vector3() };
  const want = { radius: 60, polar: 1.05, target: new THREE.Vector3(), follow: null, spin: 0.03 };
  let userAzimuth = 0;
  let dragging = false;
  let lastUserMove = 0;

  function setStation(id) {
    const p = PRESETS[id] || PRESETS.bridge;
    want.radius = fitRadius * 2.05 * p.dist;
    want.polar = (p.polar * Math.PI) / 180;
    want.spin = reduceMotion ? 0 : p.spin;
    want.follow = null;
    // lift: 카메라 초점을 코어보다 낮춰 궤도계를 화면 위쪽(빈 공간)으로 올린다.
    want.target.set(0, p.target === "engines" ? -14 : (p.lift || 0), 0);
    if (p.target === "engines") want.radius = Math.max(want.radius, 34);
  }

  function focus(kind, id) {
    if (kind === "team") {
      const p = planets.find((x) => x.id === id);
      if (!p) return;
      want.follow = p.group;
      want.radius = 16 + p.radius * 4;
      want.polar = 0.95;
    } else if (kind === "engine") {
      const e = engines.find((x) => x.id === id);
      if (!e) return;
      want.follow = e.group;
      want.radius = 16;
      want.polar = 1.45;
    }
  }

  // ---------------------------------------------------------------- 고르기(화면 좌표 기준)
  const pointer = { x: -1, y: -1, inside: false };
  let hovered = null;
  function project(v) {
    tmpV.copy(v).project(camera);
    return { x: (tmpV.x * 0.5 + 0.5) * window.innerWidth, y: (-tmpV.y * 0.5 + 0.5) * window.innerHeight, z: tmpV.z };
  }
  function pick(x, y) {
    let best = null;
    let bestD = 18;
    for (const s of sats) {
      const p = project(s.pos);
      if (p.z > 1) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) { bestD = d; best = { kind: "key", id: s.id, data: s.data }; }
    }
    if (best) return best;
    for (const pl of planets) {
      const p = project(pl.group.position);
      if (p.z > 1) continue;
      const edge = project(tmpS.copy(pl.group.position).add(new THREE.Vector3(pl.radius, 0, 0)));
      const r = Math.max(14, Math.hypot(edge.x - p.x, edge.y - p.y) + 8);
      if (Math.hypot(p.x - x, p.y - y) < r) return { kind: "team", id: pl.id, data: pl.data };
    }
    for (const e of engines) {
      const p = project(e.group.position);
      if (p.z > 1) continue;
      if (Math.hypot(p.x - x, p.y - y) < 24) return { kind: "engine", id: e.id, data: e.data };
    }
    const c = project(new THREE.Vector3());
    if (Math.hypot(c.x - x, c.y - y) < 30) return { kind: "core" };
    return null;
  }

  const BLOCKERS = ".panel, .card, .hud, .rail, .foot, .modal, .drawer, .palette, .toast, .scrim, .login-card, button, a, input, select, textarea, label, table, .void-legend";
  function isEmptySpace(target) {
    return !(target && target.closest && target.closest(BLOCKERS));
  }
  let downAt = null;
  const onMove = (ev) => {
    if (dragging && downAt) {
      const dx = ev.clientX - downAt.x;
      const dy = ev.clientY - downAt.y;
      userAzimuth = downAt.az - dx * 0.006;
      want.polar = Math.min(2.6, Math.max(0.12, downAt.polar - dy * 0.005));
      lastUserMove = performance.now();
      return;
    }
    pointer.inside = isEmptySpace(ev.target);
    pointer.x = ev.clientX;
    pointer.y = ev.clientY;
  };
  const onDown = (ev) => {
    if (ev.button !== 0 || !isEmptySpace(ev.target)) return;
    downAt = { x: ev.clientX, y: ev.clientY, az: userAzimuth, polar: want.polar, t: performance.now() };
    dragging = true;
  };
  const onUp = (ev) => {
    if (!downAt) return;
    const moved = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y);
    const quick = performance.now() - downAt.t < 400;
    dragging = false;
    downAt = null;
    if (moved < 5 && quick && isEmptySpace(ev.target)) {
      const hit = pick(ev.clientX, ev.clientY);
      if (hit && onPick) onPick(hit);
    }
  };
  window.addEventListener("pointermove", onMove, { passive: true });
  window.addEventListener("pointerdown", onDown, { passive: true });
  window.addEventListener("pointerup", onUp, { passive: true });

  // ---------------------------------------------------------------- 그리기 반복
  // THREE.Clock 은 사용 중단 예정이라 직접 시간을 잰다.
  let lastT = performance.now();
  let elapsed = 0;
  let frames = 0;
  let slowFrames = 0;
  let running = true;
  let labelsVisible = true;
  let engineLabels = false;
  const resize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  };
  window.addEventListener("resize", resize);

  function placeLabel(el, pos, dy = 0) {
    const p = project(pos);
    if (p.z > 1 || p.x < -80 || p.x > window.innerWidth + 80 || p.y < -40 || p.y > window.innerHeight + 40) {
      el.style.display = "none";
      return;
    }
    el.style.display = "";
    el.style.transform = `translate(${p.x.toFixed(1)}px, ${(p.y - dy).toFixed(1)}px) translate(-50%, -100%)`;
  }

  function frame() {
    if (!running) return;
    const nowT = performance.now();
    const dt = Math.min(0.05, (nowT - lastT) / 1000);
    lastT = nowT;
    elapsed += dt;
    const t = elapsed;
    frames += 1;
    if (frames > 30 && frames < 150 && dt > 0.034) slowFrames += 1;
    if (frames === 150 && slowFrames > 70 && !lowQ) {
      lowQ = true;
      setPixelRatio();
      if (onQuality) onQuality("low");
    }

    const motion = reduceMotion ? 0 : 1;
    stars.rotation.y += dt * 0.004 * motion;
    coreShell.rotation.y += dt * 0.25 * motion;
    coreShell.rotation.x += dt * 0.08 * motion;
    coreRings.forEach((r) => { r.rotation.z += dt * r.userData.speed * motion; });
    grid.rotation.y -= dt * 0.01 * motion;
    const beat = 1 + Math.sin(t * 2.2) * 0.06 * motion;
    coreGlow.scale.setScalar(11 * beat);
    alarm = Math.max(0, alarm - dt * 1.4);
    alarmGlow.material.opacity = alarm;

    planets.forEach((p) => {
      p.angle += dt * p.speed * motion;
      p.group.position.set(Math.cos(p.angle) * p.orbitR, Math.sin(p.angle * 0.7) * 0.8, Math.sin(p.angle) * p.orbitR);
      p.body.rotation.y += dt * 0.12 * motion;
      if (p.data.session === "open" && motion) p.ring.material.opacity = 0.55 + Math.sin(t * 3) * 0.3;
      if (p.data.locked) p.hazard.rotation.z += dt * 0.6 * motion;
    });
    engines.forEach((e, i) => {
      e.inner.rotation.y += dt * 0.5 * motion;
      e.wire.rotation.y -= dt * 0.2 * motion;
      e.group.position.y += Math.sin(t * 1.3 + i) * 0.004 * motion;
    });

    if (satMesh) {
      const posAttr = satPoints.geometry.getAttribute("position");
      for (const s of sats) {
        const hostPos = s.host >= 0 ? planets[s.host].group.position : ZERO;
        const r = s.host >= 0 ? planets[s.host].radius + 1.5 + s.lane * 0.55 : 7.5 + s.lane * 0.9;
        const a = s.phase + t * s.speed * 0.35 * motion;
        s.pos.set(Math.cos(a) * r, Math.sin(a) * r * Math.sin(s.tilt), Math.sin(a) * r * Math.cos(s.tilt)).add(hostPos);
        const big = hovered && hovered.kind === "key" && hovered.id === s.id ? 2.4 : 1;
        tmpM.compose(s.pos, tmpQ, tmpS.set(big, big, big));
        satMesh.setMatrixAt(s.i, tmpM);
        posAttr.setXYZ(s.i, s.pos.x, s.pos.y, s.pos.z);
      }
      satMesh.instanceMatrix.needsUpdate = true;
      posAttr.needsUpdate = true;
    }

    // 입자
    const tmpP = new THREE.Vector3();
    let n = 0;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.t += dt / p.dur;
      if (p.t >= 1) {
        if (!p.ok) alarm = Math.min(0.8, alarm + 0.35);
        particles.splice(i, 1);
        continue;
      }
      if (p.t < 0) continue;
      const u = p.ok ? p.t : Math.min(p.t * 1.5, 1);
      along(p.path, u, tmpP);
      pPos[n * 3] = tmpP.x; pPos[n * 3 + 1] = tmpP.y; pPos[n * 3 + 2] = tmpP.z;
      const c = p.ok ? C.mint : C.hot;
      pCol[n * 3] = c.r; pCol[n * 3 + 1] = c.g; pCol[n * 3 + 2] = c.b;
      n += 1;
      if (n >= MAX_P) break;
    }
    pGeo.setDrawRange(0, n);
    pGeo.getAttribute("position").needsUpdate = true;
    pGeo.getAttribute("color").needsUpdate = true;

    // 카메라
    const idle = performance.now() - lastUserMove > 9000;
    if (!dragging && idle) userAzimuth += dt * want.spin;
    const target = want.follow ? want.follow.position : want.target;
    const k = reduceMotion ? 1 : 1 - Math.pow(0.001, dt);
    cam.radius += (want.radius - cam.radius) * k;
    cam.polar += (want.polar - cam.polar) * k;
    cam.azimuth += (userAzimuth - cam.azimuth) * (dragging ? 1 : k);
    cam.target.lerp(target, k);
    camera.position.set(
      cam.target.x + cam.radius * Math.sin(cam.polar) * Math.cos(cam.azimuth),
      cam.target.y + cam.radius * Math.cos(cam.polar),
      cam.target.z + cam.radius * Math.sin(cam.polar) * Math.sin(cam.azimuth)
    );
    camera.lookAt(cam.target);

    // 라벨·호버
    if (labelsVisible) {
      if (coreLabel) placeLabel(coreLabel, new THREE.Vector3(0, 3.2, 0));
      for (const p of planets) placeLabel(p.label, p.group.position, 18 + p.radius * 7);
      for (const e of engines) placeLabel(e.label, e.group.position, 20);
    }
    if (pointer.inside && !dragging && frames % 3 === 0) {
      const hit = pick(pointer.x, pointer.y);
      const changed = (hit && (!hovered || hit.id !== hovered.id || hit.kind !== hovered.kind)) || (!hit && hovered);
      hovered = hit;
      if (changed || hit) { if (onHover) onHover(hit, pointer.x, pointer.y); }
      document.body.style.cursor = hit ? "pointer" : "";
    } else if (!pointer.inside && hovered) {
      hovered = null;
      document.body.style.cursor = "";
      if (onHover) onHover(null);
    }

    renderer.render(scene, camera);
  }
  renderer.setAnimationLoop(frame);

  setStation("bridge");
  cam.radius = want.radius * 1.6;
  cam.polar = want.polar;

  return {
    setData,
    pulse,
    setStation,
    focus,
    reject() { alarm = 0.9; },
    // 개요에서는 행성·코어 이름만 보이고, 엔진은 올려 두면 툴팁으로 본다(가운데가 붐비지 않게).
    setLabels(on, { engines: showEngines = false } = {}) {
      labelsVisible = on;
      engineLabels = showEngines;
      labelsEl.style.display = on ? "" : "none";
      for (const e of engines) e.label.style.visibility = showEngines ? "" : "hidden";
    },
    setReduceMotion(on) { reduceMotion = on; },
    setQuality(q) { lowQ = q === "low"; setPixelRatio(); },
    pause() { running = false; renderer.setAnimationLoop(null); },
    resume() { if (!running) { running = true; lastT = performance.now(); renderer.setAnimationLoop(frame); } },
    dispose() {
      running = false;
      renderer.setAnimationLoop(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("resize", resize);
      clearWorld();
      resetLabels();
      renderer.dispose();
    },
  };
}
