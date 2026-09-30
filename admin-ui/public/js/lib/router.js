// 스테이션 전환·해시 주소·관제 모드(자동 순환).
import { $, esc, icon } from "./util.js";
import * as sfx from "./sfx.js";

export const STATIONS = [
  { id: "bridge", no: "01", code: "BRIDGE", label: "개요", icon: "bridge", display: true, veil: 0 },
  { id: "telemetry", no: "02", code: "TELEMETRY", label: "사용량", icon: "telemetry", display: true, veil: 0.55 },
  { id: "keys", no: "03", code: "ROSTER", label: "키 관리", icon: "keys", display: false, veil: 0.66 },
  { id: "classes", no: "04", code: "SQUADRON", label: "학급/조", icon: "classes", display: true, veil: 0.32 },
  { id: "launch", no: "05", code: "LAUNCH BAY", label: "키 발급", icon: "launch", display: false, veil: 0.6 },
  { id: "engines", no: "06", code: "ENGINE ROOM", label: "공급자", icon: "engine", display: true, veil: 0.4 },
  { id: "crew", no: "07", code: "CREW", label: "사용자", icon: "crew", display: false, veil: 0.6 },
  { id: "log", no: "08", code: "SHIP LOG", label: "기록", icon: "log", display: true, veil: 0.6 },
  { id: "ai", no: "09", code: "AI CORE", label: "AI 엘피", icon: "elfy", display: false, veil: 0.62 },
];

// 스테이션에 들어올 때 패널이 차례로 켜진다. 안쪽 패널까지 따로 움직이면 어지러워 바깥 덩어리만 고른다.
const ENTER_SEL = ".st-head, .tabs, .panel, .card, .tile, .bulkbar";
function stagger(station) {
  if (document.body.classList.contains("reduce-motion")) return;
  const items = [...station.querySelectorAll(ENTER_SEL)].filter((el) => {
    const outer = el.parentElement && el.parentElement.closest(ENTER_SEL);
    return !outer || !station.contains(outer);
  }).slice(0, 18);
  for (const el of station.querySelectorAll(".enter-item")) el.classList.remove("enter-item");
  void station.offsetWidth;
  items.forEach((el, i) => {
    el.style.setProperty("--i", String(i));
    el.classList.add("enter-item");
  });
  clearTimeout(station._enterTimer);
  station._enterTimer = setTimeout(() => items.forEach((el) => el.classList.remove("enter-item")), 1600);
  const stage = $("#stage");
  if (stage) {
    stage.classList.remove("sweep");
    void stage.offsetWidth;
    stage.classList.add("sweep");
  }
  const name = $("#hud-name");
  if (name) {
    name.classList.remove("glitch");
    void name.offsetWidth;
    name.classList.add("glitch");
  }
}

const byId = Object.fromEntries(STATIONS.map((s, i) => [s.id, { ...s, index: i }]));

function parseHash() {
  const raw = decodeURIComponent((location.hash || "").replace(/^#/, ""));
  const [id, query = ""] = raw.split("?");
  const params = Object.fromEntries(new URLSearchParams(query));
  return { id: byId[id] ? id : null, params };
}

function hashFor(id, params) {
  const q = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v != null && v !== "")).toString();
  return `#${id}${q ? `?${q}` : ""}`;
}

export function createRouter({ onEnter, getSettings, onAutoChange }) {
  let current = null;
  let currentParams = {};
  const rail = $("#rail");

  rail.innerHTML = STATIONS.map((s) => `
    <button class="rail-btn" type="button" data-go="${s.id}" title="${esc(s.label)} (${Number(s.no)})">
      ${icon(s.icon)}<span class="no">${s.no}</span><span class="lb">${esc(s.label)}</span>
    </button>`).join("")
    + `<div class="rail-sep"></div>
      <div class="auto-ring"><button type="button" id="rail-auto" aria-pressed="false" title="관제 모드: 스테이션을 자동으로 돌며 보여 줍니다">
        <svg viewBox="0 0 60 60"><circle cx="30" cy="30" r="28"/></svg>관제<br>모드</button></div>`;

  rail.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-go]");
    if (b) go(b.dataset.go, {}, { user: true });
  });

  function el(id) { return document.getElementById(`st-${id}`); }

  function go(id, params = {}, { user = false, replace = false } = {}) {
    if (!byId[id]) id = "bridge";
    if (user) pauseAuto();
    if (user && id !== current) sfx.play("nav");
    const prevId = current;
    currentParams = params || {};
    const url = hashFor(id, currentParams);
    if (location.hash !== url) {
      if (replace || !user) history.replaceState(null, "", url);
      else history.pushState(null, "", url);
    }
    if (prevId === id) {
      onEnter(id, currentParams, { same: true, prev: prevId });
      return;
    }
    const forward = !prevId || byId[id].index > byId[prevId].index;
    const next = el(id);
    const prev = prevId ? el(prevId) : null;
    // 들어올 스테이션을 출발 위치에 전환 없이 놓고, 다음 프레임에 가운데로 보낸다.
    next.style.transition = "none";
    next.classList.remove("active");
    next.classList.toggle("leave-left", !forward);
    void next.offsetWidth;
    next.style.transition = "";
    next.classList.remove("leave-left");
    next.classList.add("active");
    next.scrollTop = next.scrollTop;
    if (prev) {
      prev.classList.remove("active");
      prev.classList.toggle("leave-left", forward);
    }
    for (const b of rail.querySelectorAll("[data-go]")) {
      b.toggleAttribute("aria-current", b.dataset.go === id);
      if (b.dataset.go === id) b.setAttribute("aria-current", "page");
    }
    current = id;
    onEnter(id, currentParams, { same: false, prev: prevId, forward });
    stagger(next);
  }

  window.addEventListener("popstate", () => {
    const h = parseHash();
    if (h.id) go(h.id, h.params, { replace: true });
  });
  window.addEventListener("hashchange", () => {
    const h = parseHash();
    if (h.id && (h.id !== current || JSON.stringify(h.params) !== JSON.stringify(currentParams))) go(h.id, h.params, { replace: true });
  });

  // ---------------------------------------------------------------- 관제 모드
  let autoOn = false;
  let autoStart = 0;
  let pausedUntil = 0;
  let timer = null;
  const ring = () => $("#rail-auto circle");

  function autoList() {
    const s = getSettings();
    const list = (s.autoStations && s.autoStations.length ? s.autoStations : STATIONS.filter((x) => x.display).map((x) => x.id)).filter((id) => byId[id]);
    return list.length ? list : ["bridge"];
  }

  function paint(progress) {
    const c = ring();
    if (c) c.style.strokeDashoffset = String(176 - 176 * progress);
    const label = $("#auto-state");
    if (!label) return;
    if (!autoOn) { label.textContent = ""; return; }
    const left = Math.max(0, Math.ceil((pausedUntil - Date.now()) / 1000));
    label.textContent = left > 0 ? `관제 모드 · 조작 감지, ${left}초 뒤 재개` : `관제 모드 · ${Math.max(0, Math.ceil(getSettings().autoInterval * (1 - progress)))}초 뒤 전환`;
  }

  function tick() {
    if (!autoOn) return;
    const now = Date.now();
    const s = getSettings();
    if (now < pausedUntil) { paint(0); autoStart = now; return; }
    const span = Math.max(5, Number(s.autoInterval) || 20) * 1000;
    const p = (now - autoStart) / span;
    if (p >= 1) {
      const list = autoList();
      const i = list.indexOf(current);
      go(list[(i + 1) % list.length], {}, { replace: true });
      autoStart = now;
      paint(0);
    } else paint(p);
  }

  function setAuto(on) {
    autoOn = Boolean(on);
    autoStart = Date.now();
    pausedUntil = 0;
    clearInterval(timer);
    if (autoOn) timer = setInterval(tick, 250);
    for (const b of [$("#rail-auto"), $("#btn-auto")]) if (b) b.setAttribute("aria-pressed", String(autoOn));
    document.body.classList.toggle("auto-mode", autoOn);
    paint(0);
    if (onAutoChange) onAutoChange(autoOn);
  }

  function pauseAuto(ms = 30000) {
    if (!autoOn) return;
    pausedUntil = Date.now() + ms;
  }

  for (const t of ["pointerdown", "keydown", "wheel"]) {
    window.addEventListener(t, (ev) => {
      if (!autoOn) return;
      if (ev.target && ev.target.closest && ev.target.closest("#rail-auto, #btn-auto")) return;
      pauseAuto();
    }, { passive: true, capture: true });
  }
  $("#rail-auto").addEventListener("click", () => setAuto(!autoOn));

  const initial = parseHash();
  return {
    go,
    start() { go(initial.id || "bridge", initial.params, { replace: true }); },
    get current() { return current; },
    get params() { return currentParams; },
    station: (id) => byId[id],
    setAuto,
    toggleAuto: () => setAuto(!autoOn),
    get auto() { return autoOn; },
  };
}
