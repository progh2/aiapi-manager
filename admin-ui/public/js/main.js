// 관제 함교 진입점. 로그인 → 역할 확인 → 관리자 함교 또는 등록 사용자 조종석.
import {
  $, esc, icon, money, debounce, seoulParts, keyState, isRetired, isSystemKey, isCamp, budgetRatio, sessionState, prefersReducedMotion, relTime, fmtTime,
} from "./lib/util.js";
import { createApi } from "./lib/api.js";
import * as store from "./lib/store.js";
import { toast, toastError, modal, commandPalette, isOverlayOpen, showSceneTip, hideSceneTip } from "./lib/ui.js";
import { createRouter, STATIONS } from "./lib/router.js";
import * as sfx from "./lib/sfx.js";
import { createElfy } from "./lib/assistant.js";
import bridge from "./stations/bridge.js";
import telemetry from "./stations/telemetry.js";
import keys from "./stations/keys.js";
import classes from "./stations/classes.js";
import launch from "./stations/launch.js";
import engines from "./stations/engines.js";
import crew from "./stations/crew.js";
import log from "./stations/log.js";
import ai from "./stations/ai.js";

const STATION_MODULES = { bridge, telemetry, keys, classes, launch, engines, crew, log, ai };
const { state } = store;

// ---------------------------------------------------------------- 설정
const SETTINGS_KEY = "aiapi.bridge.settings";
const DEFAULTS = {
  scene: "on", quality: "auto", labels: true, autoInterval: 20, autoStations: [], reduceMotion: false, contrast: false, proxyUrl: "",
  // 소리와 엘피
  sound: true, volume: 0.5, sfxTraffic: false, proactive: true, voice: false, voiceName: "",
};
const settings = { ...DEFAULTS, ...(() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); } catch { return {}; } })() };
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* 사생활 보호 모드 */ } };
function applySound() {
  sfx.configure({ enabled: settings.sound !== false, vol: settings.volume ?? 0.5 });
  const b = document.getElementById("btn-sound");
  if (b) {
    b.setAttribute("aria-pressed", String(settings.sound !== false));
    b.innerHTML = `<svg><use href="#i-${settings.sound !== false ? "volume" : "mute"}"/></svg>`;
  }
}
function applySettings() {
  document.body.classList.toggle("reduce-motion", Boolean(settings.reduceMotion) || prefersReducedMotion());
  document.body.classList.toggle("hc", Boolean(settings.contrast));
  applySound();
}
applySettings();

// ---------------------------------------------------------------- 부팅 화면
const bootLines = $("#boot-lines");
let bootStep = 0;
function boot(text, cls = "") {
  const div = document.createElement("div");
  if (cls) div.className = cls;
  div.textContent = text;
  bootLines.appendChild(div);
  while (bootLines.children.length > 7) bootLines.firstElementChild.remove();
  bootStep += 1;
  $("#boot-bar").style.width = `${Math.min(100, bootStep * 13)}%`;
}
function bootDone() {
  $("#boot-bar").style.width = "100%";
  setTimeout(() => $("#boot").classList.add("done"), document.body.classList.contains("reduce-motion") ? 0 : 350);
  setTimeout(() => $("#boot").remove(), 1100);
}
boot("관제 시스템 기동");

// ---------------------------------------------------------------- 로그인
const cfg = window.FIREBASE_CONFIG || null;
const MOCK = Boolean(cfg && cfg.apiKey === "__MOCK__");
const mockAs = new URLSearchParams(location.search).get("as");
let auth;
if (MOCK) {
  const user = { email: mockAs || "teacher@school.kr", getIdToken: async () => (mockAs ? `mock:${mockAs}` : "mock") };
  auth = {
    currentUser: user,
    onAuthStateChanged(cb) { queueMicrotask(() => cb(user)); },
    signOut: async () => {},
    signInWithPopup: async () => {},
  };
} else if (typeof window.firebase === "undefined") {
  auth = null;
} else {
  try {
    window.firebase.initializeApp(cfg);
    auth = window.firebase.auth();
  } catch (e) {
    auth = null;
    console.error(e);
  }
}

const LOGIN_HINT = {
  "auth/invalid-api-key": "Firebase apiKey 가 올바르지 않습니다. .env 의 FIREBASE_API_KEY 를 확인하세요.",
  "auth/unauthorized-domain": "이 주소가 Firebase 승인된 도메인에 없습니다. Firebase 콘솔 → Authentication → 설정 → 승인된 도메인에 추가하세요.",
  "auth/operation-not-allowed": "Firebase 콘솔에서 Google 로그인 방법이 켜져 있지 않습니다.",
  "auth/popup-blocked": "브라우저가 팝업을 막았습니다. 팝업을 허용해 주세요.",
  "auth/network-request-failed": "구글 로그인 서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.",
};

function showLogin(message = "") {
  bootDone();
  $("#login").hidden = false;
  $("#login-error").innerHTML = message;
  const cfgMissing = !MOCK && (!cfg || Object.values(cfg).some((v) => String(v).includes("REPLACE_ME")));
  if (cfgMissing) {
    $("#login-btn").disabled = true;
    $("#login-error").innerHTML = 'Firebase 가 아직 설정되지 않았습니다. <code>.env</code> 의 <code>FIREBASE_PROJECT_ID</code>·<code>FIREBASE_API_KEY</code> 를 채운 뒤 <code>docker compose up -d --build admin-ui</code> 로 다시 띄우세요. (docs/firebase-checklist.md)';
  } else if (!auth) {
    $("#login-btn").disabled = true;
    $("#login-error").textContent = "구글 로그인 모듈(Firebase)을 불러오지 못했습니다. 학교 망에서 www.gstatic.com 이 막혔는지 확인하세요.";
  }
}

$("#login-btn").addEventListener("click", () => {
  if (!auth || MOCK) return;
  $("#login-error").textContent = "";
  auth.signInWithPopup(new window.firebase.auth.GoogleAuthProvider()).catch((e) => {
    if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return;
    $("#login-error").textContent = `${LOGIN_HINT[e.code] || e.message} (${e.code || "오류"})`;
  });
});

if (!auth) showLogin();
else {
  boot("승무원 인증 확인");
  auth.onAuthStateChanged(async (user) => {
    if (!user) { showLogin(); return; }
    const api = createApi(() => auth.currentUser.getIdToken());
    let me;
    try {
      me = await api("/api/me");
    } catch (e) {
      if (!MOCK && (e.status === 403 || e.status === 503)) await auth.signOut().catch(() => {});
      showLogin(esc(e.status === 403 ? e.message : e.status === 503 ? e.message : `관리 서버에 연결하지 못했습니다: ${e.message}`));
      return;
    }
    $("#login").hidden = true;
    const proxyUrl = () => settings.proxyUrl || me.proxy_url || `${location.protocol}//${location.hostname}:${me.proxy_port || 4000}`;
    if (me.role === "admin") startAdmin({ api, me, proxyUrl });
    else startPilotView({ api, me, proxyUrl });
  });
}

// ---------------------------------------------------------------- 3D 관제도
async function createScene({ onPick, onHover }) {
  if (settings.scene === "off") { document.body.classList.add("scene-off"); return null; }
  try {
    const mod = await import("./scene/orbital.js");
    const scene = mod.createOrbital({
      canvas: $("#scene"),
      labelsEl: $("#scene-labels"),
      quality: settings.quality === "low" ? "low" : "high",
      reduceMotion: document.body.classList.contains("reduce-motion"),
      onPick,
      onHover,
      onQuality: () => toast("그래픽이 느려 3D 관제도를 저사양 모드로 바꿨습니다. 설정에서 끌 수도 있습니다.", { tone: "info" }),
    });
    if (!scene) document.body.classList.add("no-webgl");
    else scene.setLabels(settings.labels !== false);
    return scene;
  } catch (e) {
    console.warn("3D 관제도를 켜지 못했습니다", e);
    document.body.classList.add("no-webgl");
    return null;
  }
}

async function startPilotView({ api, me, proxyUrl }) {
  boot(`조종사 확인 · ${me.email}`, "ok");
  const scene = await createScene({ onPick: () => {}, onHover: () => {} });
  if (scene) scene.setStation("pilot");
  const { startPilot } = await import("./pilot.js");
  await startPilot({ api, me, auth, proxyUrl: proxyUrl(), scene, settings, saveSettings });
  boot("조종석 가동", "ok");
  bootDone();
}

// ---------------------------------------------------------------- 관리자 함교
async function startAdmin({ api, me, proxyUrl }) {
  boot(`함장 확인 · ${me.email}`, "ok");
  store.init(api, me);
  $("#app").hidden = false;
  $("#hud-who").textContent = me.email;

  let scene = null;
  let elfy = null;
  let tickerHead = "";
  // 경보 알림 상태. 데이터가 오기 전에 hudCondition 이 불릴 수 있어 위에 둔다.
  let lastLevel = null;
  let announced = null;
  const ctx = {
    api,
    me,
    proxyUrl,
    settings,
    saveSettings,
    applySound,
    get scene() { return scene; },
    get elfy() { return elfy; },
    go: (id, params = {}) => router.go(id, params, { user: true }),
    isActive: (id) => router.current === id,
    replaceParams: (params) => {
      const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
      history.replaceState(null, "", `#${router.current}${q ? `?${q}` : ""}`);
    },
    openKey: (token) => keys.openDetail(token),
    topup: ({ teamId, title }) => keys.bulkTopup([], { teamId, title }),
  };

  for (const s of STATIONS) STATION_MODULES[s.id].init(document.getElementById(`st-${s.id}`), ctx);

  const router = createRouter({
    getSettings: () => settings,
    onAutoChange: (on) => toast(on ? `관제 모드 · ${settings.autoInterval}초마다 화면을 돌며 보여 줍니다. 아무 키나 누르면 잠시 멈춥니다.` : "관제 모드를 껐습니다", { tone: "info", timeout: 3500 }),
    onEnter: (id, params, info) => {
      const meta = router.station(id);
      $("#hud-code").textContent = `STATION ${meta.no} · ${meta.code}`;
      $("#hud-name").textContent = meta.label;
      document.documentElement.style.setProperty("--veil", String(meta.veil));
      document.title = `${meta.label} · AIAPI 관제 함교`;
      if (scene) {
        scene.setStation(id);
        // 표·폼이 많은 화면에서는 반투명 패널 뒤로 이름표가 비쳐 읽기를 방해한다.
        scene.setLabels(settings.labels !== false && id === "bridge");
      }
      if (elfy && !info.same) elfy.setStation(id);
      try { STATION_MODULES[id].enter(params, info); } catch (e) { console.error(e); toastError(e, "화면을 그리지 못했습니다"); }
    },
  });

  // AI 엘피: 하단 줄 오른쪽의 홀로그램. 제안 카드를 실행하면 바뀐 데이터를 다시 받는다.
  elfy = createElfy({
    api,
    role: "admin",
    host: $("#foot"),
    getStation: () => router.current || "bridge",
    go: (id, params) => router.go(id, params || {}, { user: true }),
    getSettings: () => settings,
    saveSettings,
    onExecuted: (p) => {
      const jobs = { keys: store.loadKeys, teams: store.loadTeams, analytics: () => store.loadAnalytics(), providers: store.loadProviders };
      for (const name of p.refresh || ["keys", "teams"]) if (jobs[name]) jobs[name]().catch(() => {});
      store.loadActivity().catch(() => {});
    },
  });

  // 저장소 → 화면
  const refreshActive = (ev) => {
    const id = router.current;
    const mod = STATION_MODULES[id];
    if (mod && mod.deps && mod.deps.includes(ev)) {
      try { mod.refresh(ev); } catch (e) { console.error(e); }
    }
  };
  const sceneRefresh = debounce(() => { if (scene) scene.setData(sceneData()); }, 250);
  for (const ev of ["keys", "teams", "providers", "users", "analytics", "activity", "status"]) {
    store.on(ev, () => {
      refreshActive(ev);
      if (ev === "keys" || ev === "teams" || ev === "providers") sceneRefresh();
      if (ev === "activity") ticker();
      if (ev === "status") lights();
      hudCondition();
    });
  }
  store.on("traffic", (fresh) => {
    if (scene) scene.pulse(fresh);
    if (settings.sfxTraffic && !document.hidden) sfx.play("ping");
  });
  const warned = new Set();
  store.on("error", ({ name, error }) => {
    if (error.status === 401) { toast("로그인이 만료되었습니다. 다시 로그인하세요.", { tone: "crit" }); return; }
    if (!warned.has(name) && name !== "activity") { warned.add(name); toastError(error, `${name} 갱신 실패`); }
  });
  // 데이터
  boot("프록시 코어 · 학급 · 키 궤도 데이터 수신");
  const core = await store.loadCore();
  const failed = core.filter((r) => r.status === "rejected");
  if (failed.length) boot(`일부 데이터를 받지 못함: ${failed[0].reason.message}`, "bad");
  else boot(`학급 ${state.teams.length} · 키 ${state.keys.length} · 공급자 ${state.providers.length}`, "ok");
  router.start();
  boot("텔레메트리 · 통신 · 시스템 점검");
  Promise.allSettled([store.loadAnalytics(), store.loadActivity(), store.loadStatus(), store.loadUsers()]).then(() => boot("모든 시스템 가동", "ok"));
  boot("3D 관제도 초기화");
  scene = await createScene({
    onPick: (hit) => {
      hideSceneTip();
      if (hit.kind === "key") ctx.openKey(hit.id);
      else if (hit.kind === "team") ctx.go("classes", { team_id: hit.id });
      else if (hit.kind === "engine") ctx.go("engines", { id: hit.id });
      else if (hit.kind === "core") ctx.go("log", { tab: "system" });
    },
    onHover: (hit, x, y) => {
      if (!hit) { hideSceneTip(); return; }
      showSceneTip(sceneTipHtml(hit), x, y);
    },
  });
  if (scene) { scene.setData(sceneData()); scene.setStation(router.current); scene.setLabels(settings.labels !== false && router.current === "bridge"); }
  bootDone();
  if (failed.length) toastError(failed[0].reason, "데이터를 불러오지 못했습니다");

  store.startPolling();

  // HUD
  // 새 경보는 엘피가 말풍선으로 알린다. 처음 불러온 경보는 한 번에 묶어 말한다.
  function askFor(a) {
    if (/예산 소진 키|80% 넘은 키/.test(a.title)) return "예산이 바닥났거나 거의 다 쓴 키 상황을 알려 주고, 필요하면 충전을 제안해 줘";
    if (/만료되는 키/.test(a.title)) return "곧 만료되는 키를 알려 주고, 연장이 필요하면 제안해 줘";
    if (/실패율/.test(a.title)) return "최근 호출 실패 원인을 요약하고 해결 방법을 알려 줘";
    if (/학급 예산/.test(a.title)) return `${a.title.split(" 학급")[0]} 학급 예산 상황을 알려 주고 어떻게 하면 좋을지 제안해 줘`;
    if (/공급자/.test(a.title)) return "공급자 키 잔액 상황을 알려 주고 어떻게 하면 좋을지 알려 줘";
    return `"${a.title}" 경보가 떴어. 어떻게 하면 좋을까?`;
  }
  function announce(list) {
    if (!elfy) return;
    const serious = list.filter((a) => a.level === "crit" || a.level === "warn");
    const keys = new Set(serious.map((a) => a.title));
    if (announced === null) {
      // 첫 데이터: 경보가 있으면 한 번만 요약해 알린다.
      if (!state.loaded.keys || !state.loaded.teams) return;
      announced = keys;
      if (serious.length && !router.auto) {
        const crit = serious.filter((a) => a.level === "crit").length;
        elfy.notify({
          level: crit ? "crit" : "warn",
          text: `선생님, 경보 ${crit}건 · 주의 ${serious.length - crit}건이 있어요. 먼저 볼 것: "${serious[0].title}"`,
          ask: "지금 상황 브리핑해 주고 먼저 할 일을 알려 줘",
          go: { station: "bridge" },
        });
      }
      return;
    }
    const fresh = serious.filter((a) => !announced.has(a.title));
    announced = keys;
    if (!fresh.length) return;
    const a = fresh[0];
    elfy.notify({ level: a.level, text: `${a.title} — ${a.detail}`, ask: askFor(a), go: a.go || null });
  }

  function hudCondition() {
    const list = store.alerts();
    const lvl = store.conditionLevel(list);
    if (lastLevel && lvl === "red" && lastLevel !== "red") sfx.play("alarm");
    lastLevel = lvl;
    announce(list);
    const btn = $("#hud-condition");
    btn.dataset.level = lvl;
    $("#hud-condition-led").className = `led ${lvl === "red" ? "crit pulse" : lvl === "yellow" ? "warn" : "good"}`;
    $("#hud-condition-code").textContent = `CONDITION ${lvl.toUpperCase()}`;
    const crit = list.filter((a) => a.level === "crit").length;
    const warn = list.filter((a) => a.level === "warn").length;
    $("#hud-condition-text").textContent = lvl === "red" ? `경보 ${crit}` : lvl === "yellow" ? `주의 ${warn}` : "이상 없음";
    const hot = new Set(list.filter((a) => a.level === "crit").map((a) => a.go && a.go.station).filter(Boolean));
    for (const b of document.querySelectorAll("#rail [data-go]")) {
      const has = hot.has(b.dataset.go);
      const dot = b.querySelector(".badge-dot");
      if (has && !dot) b.insertAdjacentHTML("beforeend", '<span class="badge-dot" aria-label="경보"></span>');
      if (!has && dot) dot.remove();
    }
  }
  $("#hud-condition").addEventListener("click", () => ctx.go("bridge"));
  function lights() {
    const s = state.status;
    const light = (ok, label, title) => `<span class="light" title="${esc(title)}"><span class="led ${ok === true ? "good" : ok === false ? "crit pulse" : "warn"}"></span><span class="lb">${esc(label)}</span></span>`;
    const live = s ? s.litellm.live : null;
    const db = s ? (s.litellm.db === "connected" ? true : s.litellm.live ? null : false) : null;
    const stores = s ? (s.stores.users.ok && s.stores.providers.ok) : null;
    const comms = state.activity.at ? (Date.now() - new Date(state.activity.at).getTime() < 60000) : null;
    $("#hud-lights").innerHTML = light(live, "프록시", s ? (live ? `LiteLLM 응답 ${s.litellm.latency_ms}ms` : s.litellm.error || "응답 없음") : "확인 중")
      + light(db, "DB", s ? `DB ${s.litellm.db || "알 수 없음"}` : "확인 중")
      + light(stores, "저장소", "users.json · provider-keys.json")
      + light(comms, "통신", state.activity.at ? `호출 기록 ${fmtTime(state.activity.at)} 수신` : "대기");
  }
  lights();
  hudCondition();
  const tickClock = () => {
    const p = seoulParts();
    $("#hud-clock").textContent = `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}:${String(p.ss).padStart(2, "0")}`;
    $("#hud-date").textContent = `${p.m}월 ${p.d}일 (${p.weekday}) · 서울`;
  };
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(lights, 15000);

  function ticker() {
    const items = state.activity.items.slice(0, 14);
    const head = items[0] ? items[0].id || items[0].at : "";
    if (head === tickerHead) return;
    tickerHead = head;
    $("#ticker-track").innerHTML = items.length ? items.map((it) => `<span class="tk"><span class="led ${it.ok ? "good" : "crit"}"></span><span class="num">${esc(fmtTime(it.at))}</span><b>${esc(it.alias || "?")}</b><span>${esc(it.ok ? it.model || "" : it.reason || "실패")}</span></span>`).join("")
      : '<span class="tk muted">최근 24시간 호출이 없습니다</span>';
  }
  ticker();

  // 상단 버튼
  $("#btn-auto").addEventListener("click", () => router.toggleAuto());
  $("#btn-full").addEventListener("click", toggleFullscreen);
  $("#btn-cmd").addEventListener("click", openPalette);
  $("#btn-settings").addEventListener("click", openSettings);
  $("#btn-help").addEventListener("click", openHelp);
  $("#btn-logout").addEventListener("click", () => auth.signOut().finally(() => location.reload()));
  const toggleSound = () => {
    settings.sound = settings.sound === false;
    saveSettings();
    applySound();
    if (settings.sound) sfx.play("ok");
    toast(settings.sound ? "효과음을 켰습니다" : "효과음을 껐습니다", { timeout: 1600 });
  };
  $("#btn-sound").addEventListener("click", toggleSound);
  const btn3d = $("#btn-3d");
  btn3d.setAttribute("aria-pressed", String(settings.scene !== "off"));
  btn3d.addEventListener("click", async () => {
    settings.scene = settings.scene === "off" ? "on" : "off";
    saveSettings();
    btn3d.setAttribute("aria-pressed", String(settings.scene !== "off"));
    if (settings.scene === "off") {
      if (scene) { scene.dispose(); scene = null; }
      document.body.classList.add("scene-off");
      hideSceneTip();
    } else {
      document.body.classList.remove("scene-off");
      scene = await createScene({ onPick: (hit) => sceneOnPick(hit), onHover: (hit, x, y) => (hit ? showSceneTip(sceneTipHtml(hit), x, y) : hideSceneTip()) });
      if (scene) { scene.setData(sceneData()); scene.setStation(router.current); scene.setLabels(settings.labels !== false && router.current === "bridge"); }
    }
  });
  function sceneOnPick(hit) {
    hideSceneTip();
    if (hit.kind === "key") ctx.openKey(hit.id);
    else if (hit.kind === "team") ctx.go("classes", { team_id: hit.id });
    else if (hit.kind === "engine") ctx.go("engines", { id: hit.id });
    else if (hit.kind === "core") ctx.go("log", { tab: "system" });
  }

  // 단축키 — 한글 자판에서도 되도록 글자 대신 키 위치(code)를 본다.
  document.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.code === "KeyK") { ev.preventDefault(); if (!isOverlayOpen()) openPalette(); return; }
    const typing = ev.target.closest && ev.target.closest("input, textarea, select, [contenteditable]");
    // 입력칸에서 Esc 를 누르면 초점을 빼서 숫자 단축키를 바로 쓸 수 있게 한다.
    if (typing && ev.key === "Escape" && !isOverlayOpen()) { ev.target.blur(); return; }
    if (typing || isOverlayOpen() || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const digit = /^Digit([1-9])$/.exec(ev.code) || /^Numpad([1-9])$/.exec(ev.code);
    if (digit) { router.go(STATIONS[Number(digit[1]) - 1].id, {}, { user: true }); ev.preventDefault(); return; }
    if (ev.code === "Slash" && ev.shiftKey) { openHelp(); ev.preventDefault(); return; }
    if (ev.code === "Slash") { router.go("keys", { focus: "search" }, { user: true }); ev.preventDefault(); return; }
    if (ev.code === "KeyA") { router.toggleAuto(); return; }
    if (ev.code === "KeyE") { elfy.toggle(); ev.preventDefault(); return; }
    if (ev.code === "KeyM") { toggleSound(); return; }
    if (ev.code === "KeyR") { store.refreshAll().then(() => toast("모든 데이터를 새로 받았습니다", { tone: "good", timeout: 2000 })); return; }
    if (ev.code === "KeyF") { toggleFullscreen(); return; }
    if (ev.code === "KeyT") { btn3d.click(); }
  });

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => toast("이 브라우저는 전체 화면을 허용하지 않습니다", { tone: "warn" }));
  }

  function openPalette() {
    commandPalette(() => {
      const items = STATIONS.map((s) => ({ group: "STATION", label: `${s.label}로 이동`, sub: `${Number(s.no)} · ${s.code}`, keywords: s.code, run: () => ctx.go(s.id) }));
      items.push(
        { group: "ACTION", label: "학급 일괄 발급", sub: "키 발급", keywords: "명단 csv 학급", run: () => ctx.go("launch", { tab: "bulk" }) },
        { group: "ACTION", label: "캠프 짧은 키 만들기", sub: "키 발급", keywords: "캠프 camp", run: () => ctx.go("launch", { tab: "camp" }) },
        { group: "ACTION", label: "키 한 개 발급", sub: "키 발급", keywords: "새 키 single", run: () => ctx.go("launch", { tab: "single" }) },
        { group: "ACTION", label: "새 학급/조 만들기", sub: "학급/조", run: () => { ctx.go("classes"); setTimeout(() => classes.openForm(null), 400); } },
        { group: "ACTION", label: "공급자 키 등록", sub: "공급자", run: () => { ctx.go("engines"); setTimeout(() => engines.openRegister(), 400); } },
        { group: "ACTION", label: "사용자 등록", sub: "사용자", run: () => { ctx.go("crew"); setTimeout(() => crew.openForm(null), 400); } },
        { group: "ACTION", label: "예산 소진 키 보기", sub: "키 관리", keywords: "초과 over", run: () => ctx.go("keys", { filter: "over" }) },
        { group: "ACTION", label: "만료 임박 키 보기", sub: "키 관리", keywords: "만료 expiring", run: () => ctx.go("keys", { filter: "expiring" }) },
        { group: "ACTION", label: "실패한 호출 보기", sub: "기록", keywords: "오류 실패", run: () => ctx.go("log", { tab: "activity" }) },
        { group: "ACTION", label: "작업 기록 보기", sub: "기록", keywords: "audit 감사", run: () => ctx.go("log", { tab: "audit" }) },
        { group: "ACTION", label: "학생 접속 안내", sub: "기록", keywords: "base_url 예제 코드", run: () => ctx.go("log", { tab: "guide" }) },
        { group: "ELFY", label: "AI 엘피에게 묻기", sub: "E", keywords: "엘피 ai 챗 채팅 질문 상담", run: () => elfy.open() },
        { group: "ELFY", label: "지금 상황 브리핑 받기", sub: "AI 엘피", keywords: "요약 브리핑 엘피", run: () => elfy.ask("지금 상황 브리핑해 줘") },
        { group: "ELFY", label: "AI 엘피 설정 (모델 연결)", sub: "09 · AI CORE", keywords: "ollama openai chatgpt 모델 llm", run: () => ctx.go("ai") },
        { group: "SYSTEM", label: settings.sound === false ? "효과음 켜기" : "효과음 끄기", sub: "M", keywords: "소리 사운드", run: toggleSound },
        { group: "SYSTEM", label: router.auto ? "관제 모드 끄기" : "관제 모드 켜기", sub: "A", run: () => router.toggleAuto() },
        { group: "SYSTEM", label: settings.scene === "off" ? "3D 관제도 켜기" : "3D 관제도 끄기", sub: "T", run: () => btn3d.click() },
        { group: "SYSTEM", label: "모든 데이터 새로고침", sub: "R", run: () => store.refreshAll() },
        { group: "SYSTEM", label: "전체 화면", sub: "F", run: toggleFullscreen },
        { group: "SYSTEM", label: "설정", run: openSettings },
        { group: "SYSTEM", label: "단축키 도움말", sub: "?", run: openHelp },
      );
      for (const t of state.teams) items.push({ group: "CLASS", label: t.team_alias || t.team_id.slice(0, 8), sub: "학급/조", searchOnly: true, run: () => ctx.go("classes", { team_id: t.team_id }) });
      for (const k of state.keys) if (k.key_alias && !isRetired(k)) items.push({ group: "KEY", label: k.key_alias, sub: store.teamName(k.team_id) || "키", searchOnly: true, keywords: (k.metadata && k.metadata.aiapi_camp && k.metadata.aiapi_camp.code) || "", run: () => ctx.openKey(k.token) });
      return items;
    });
  }

  function openSettings() {
    const disp = STATIONS.map((s) => `<label class="chip ${(!settings.autoStations.length ? s.display : settings.autoStations.includes(s.id)) ? "on" : ""}"><input type="checkbox" name="st-auto" value="${s.id}" ${(!settings.autoStations.length ? s.display : settings.autoStations.includes(s.id)) ? "checked" : ""}>${esc(s.label)}</label>`).join("");
    modal({
      title: "설정", code: "SHIP CONFIG", size: "wide",
      body: `
        <h4 style="margin:0 0 8px;font-size:13px">3D 관제도</h4>
        <div class="form-grid">
          <label class="field"><span>표시</span><select id="s-scene"><option value="on">켜기</option><option value="off">끄기 (정적 배경)</option></select></label>
          <label class="field"><span>품질</span><select id="s-quality"><option value="auto">자동</option><option value="high">높음</option><option value="low">낮음 (오래된 PC)</option></select></label>
          <label class="field"><span>이름표</span><select id="s-labels"><option value="1">보이기</option><option value="0">숨기기</option></select></label>
        </div>
        <h4 style="margin:18px 0 8px;font-size:13px">관제 모드 (교실 화면 자동 순환)</h4>
        <div class="form-grid"><label class="field"><span>간격</span><select id="s-interval"><option value="10">10초</option><option value="15">15초</option><option value="20">20초</option><option value="30">30초</option><option value="60">60초</option></select></label></div>
        <div class="field" style="margin-top:10px"><span>돌아갈 스테이션</span><div class="chips">${disp}</div></div>
        <h4 style="margin:18px 0 8px;font-size:13px">보기 편하게</h4>
        <div class="stack" style="gap:8px">
          <label class="check"><input type="checkbox" id="s-motion" ${settings.reduceMotion ? "checked" : ""}> 움직임 줄이기 (회전 전환·깜빡임·타자 효과 끔)</label>
          <label class="check"><input type="checkbox" id="s-contrast" ${settings.contrast ? "checked" : ""}> 대비 강화 (밝은 교실·프로젝터)</label>
        </div>
        <h4 style="margin:18px 0 8px;font-size:13px">소리와 엘피</h4>
        <div class="stack" style="gap:8px">
          <label class="check"><input type="checkbox" id="s-sound" ${settings.sound !== false ? "checked" : ""}> 효과음 (M)</label>
          <label class="field"><span>음량</span><input type="range" id="s-volume" min="0" max="1" step="0.05" value="${esc(String(settings.volume ?? 0.5))}"></label>
          <label class="check"><input type="checkbox" id="s-ping" ${settings.sfxTraffic ? "checked" : ""}> 학생 호출이 들어올 때 핑 소리</label>
          <label class="check"><input type="checkbox" id="s-proactive" ${settings.proactive !== false ? "checked" : ""}> 엘피가 경보·도움말을 먼저 알려 주기</label>
          <p class="help" style="margin:0">엘피가 쓸 언어 모델(Ollama·ChatGPT)은 <b>09 AI 엘피</b> 화면에서 연결합니다.</p>
        </div>
        <h4 style="margin:18px 0 8px;font-size:13px">학생 안내 주소</h4>
        <label class="field"><span>프록시 주소 (비우면 자동: <code>${esc(me.proxy_url || `${location.protocol}//${location.hostname}:${me.proxy_port || 4000}`)}</code>)</span><input id="s-proxy" value="${esc(settings.proxyUrl)}" placeholder="http://192.168.0.10:4000"></label>`,
      onOpen: (h) => {
        h.el.querySelector("#s-scene").value = settings.scene;
        h.el.querySelector("#s-quality").value = settings.quality;
        h.el.querySelector("#s-labels").value = settings.labels === false ? "0" : "1";
        h.el.querySelector("#s-interval").value = String(settings.autoInterval);
      },
      actions: [
        { label: "취소", tone: "ghost", value: null },
        {
          label: "저장", tone: "primary",
          onClick: (h) => {
            const before = settings.scene;
            settings.scene = h.el.querySelector("#s-scene").value;
            settings.quality = h.el.querySelector("#s-quality").value;
            settings.labels = h.el.querySelector("#s-labels").value === "1";
            settings.autoInterval = Number(h.el.querySelector("#s-interval").value);
            settings.autoStations = [...h.el.querySelectorAll('input[name="st-auto"]:checked')].map((c) => c.value);
            settings.reduceMotion = h.el.querySelector("#s-motion").checked;
            settings.contrast = h.el.querySelector("#s-contrast").checked;
            settings.proxyUrl = h.el.querySelector("#s-proxy").value.trim().replace(/\/$/, "");
            settings.sound = h.el.querySelector("#s-sound").checked;
            settings.volume = Number(h.el.querySelector("#s-volume").value);
            settings.sfxTraffic = h.el.querySelector("#s-ping").checked;
            settings.proactive = h.el.querySelector("#s-proactive").checked;
            saveSettings();
            applySettings();
            if (scene) {
              scene.setLabels(settings.labels && router.current === "bridge");
              scene.setReduceMotion(document.body.classList.contains("reduce-motion"));
              if (settings.quality !== "auto") scene.setQuality(settings.quality);
            }
            if (before !== settings.scene) { settings.scene = before; btn3d.click(); }
            toast("설정을 저장했습니다", { tone: "good", timeout: 2000 });
            return true;
          },
        },
      ],
    });
  }

  function openHelp() {
    const row = (k, d) => `<tr><td class="nowrap">${k}</td><td>${esc(d)}</td></tr>`;
    modal({
      title: "사용 안내 · 단축키", code: "FIELD MANUAL", size: "wide",
      body: `
        <div class="grid g2">
          <div><table class="tbl"><tbody>
            ${row('<span class="kbd">1</span> … <span class="kbd">9</span>', "스테이션 이동 (9 = AI 엘피 설정)")}
            ${row('<span class="kbd">E</span>', "AI 엘피에게 묻기 — 상황 요약·원인 분석·조치 제안")}
            ${row('<span class="kbd">M</span>', "효과음 켜기·끄기")}
            ${row('<span class="kbd">Ctrl</span>+<span class="kbd">K</span>', "명령 팔레트 — 키 별칭·학급·작업 검색")}
            ${row('<span class="kbd">/</span>', "키 검색으로 이동")}
            ${row('<span class="kbd">A</span>', "관제 모드(자동 순환) 켜기·끄기")}
            ${row('<span class="kbd">R</span>', "모든 데이터 새로고침")}
            ${row('<span class="kbd">T</span>', "3D 관제도 켜기·끄기")}
            ${row('<span class="kbd">F</span>', "전체 화면")}
            ${row('<span class="kbd">Esc</span>', "창 닫기")}
          </tbody></table></div>
          <div>
            <p class="help"><b>3D 관제도</b> — 가운데 코어는 프록시(LiteLLM), 도는 행성은 학급(크기 = 예산, 색 = 사용률: 청록 → 주황 80% → 빨강 소진), 행성 고리는 수업 중(녹색)·항상 열림(청록)·수업 외(회색)·봉쇄(빨간 육각)입니다. 작은 위성은 학생 키, 아래쪽 팔면체는 공급자 키, 매듭 모양은 묶음입니다.</p>
            <p class="help">실제 호출이 오면 위성에서 코어를 거쳐 엔진으로 빛이 흐르고, 막힌 호출은 코어에서 붉게 튕깁니다. 빈 곳을 끌면 회전하고, 행성·위성을 누르면 상세로 갑니다.</p>
            <p class="help"><b>관제 모드</b> — 교실 화면에 띄워 두면 읽기 전용 스테이션을 정한 간격으로 돌며 보여 줍니다. 마우스를 누르거나 키를 치면 30초 멈춥니다.</p>
            <p class="help"><b>AI 엘피</b> — 오른쪽 아래 엘피를 누르고 "3학년A반 소진된 키에 2달러씩 충전해 줘"처럼 말하면 제안 카드를 만들어 줍니다. 카드의 [실행]을 눌러야 바뀝니다.</p>
          </div>
        </div>`,
    });
  }

  function sceneTipHtml(hit) {
    if (hit.kind === "key") {
      const k = state.keys.find((x) => x.token === hit.id);
      if (!k) return "학생 키";
      const st = keyState(k);
      return `<b>${esc(k.key_alias || "(별칭 없음)")}</b><br>${esc(st.label)} · ${esc(store.teamName(k.team_id) || "학급 없음")}<br>${money(k.spend)} / ${k.max_budget == null ? "무제한" : money(k.max_budget)}<br><span class="muted">눌러서 상세 보기</span>`;
    }
    if (hit.kind === "team") {
      const t = store.teamById(hit.id);
      if (!t) return "학급";
      const sess = t.metadata && t.metadata.aiapi_lockdown ? "봉쇄 중" : sessionState(t.metadata && t.metadata.aiapi_schedule).label;
      return `<b>${esc(t.team_alias)}</b><br>${money(t.spend)} / ${t.max_budget == null ? "무제한" : money(t.max_budget)} · ${esc(sess)}<br>키 ${store.keysOfTeam(t.team_id).length}개<br><span class="muted">눌러서 학급 보기</span>`;
    }
    if (hit.kind === "engine") {
      const p = state.providers.find((x) => x.id === hit.id);
      if (!p) return "공급자";
      return `<b>${esc(p.label)}</b><br>${esc(p.kind === "pool" ? "묶음" : p.provider_label || p.provider)}<br>${p.max_budget == null ? "한도 없음" : `남은 ${money(p.remaining ?? (p.max_budget - (p.spend || 0)))} / ${money(p.max_budget)}`}`;
    }
    const s = state.activity.summary;
    return `<b>프록시 코어 · LiteLLM</b><br>${state.status && state.status.litellm.live ? "정상 가동" : "상태 확인 중"}${s ? `<br>최근 호출 ${s.total} · 실패 ${s.failed}` : ""}`;
  }
}

// 3D 관제도에 넘길 모양. 폐기된 키는 뺀다.
function sceneData() {
  const now = Date.now();
  const teams = [...state.teams].sort((a, b) => String(a.team_alias).localeCompare(String(b.team_alias), "ko", { numeric: true }));
  const known = new Set(teams.map((t) => t.team_id));
  return {
    teams: teams.map((t) => ({
      id: t.team_id,
      name: t.team_alias || t.team_id.slice(0, 8),
      ratio: budgetRatio(t.spend, t.max_budget),
      session: sessionState(t.metadata && t.metadata.aiapi_schedule).code,
      locked: Boolean(t.metadata && t.metadata.aiapi_lockdown),
      keys: state.keys.filter((k) => k.team_id === t.team_id && !isRetired(k)).length,
    })),
    keys: state.keys.filter((k) => !isRetired(k) && !isSystemKey(k)).slice(0, 800).map((k) => ({
      id: k.token,
      team: known.has(k.team_id) ? k.team_id : null,
      state: keyState(k, now).code,
      camp: isCamp(k),
    })),
    engines: state.providers.map((p) => {
      const left = p.max_budget == null ? null : (p.remaining ?? (Number(p.max_budget) - Number(p.spend || 0)));
      return {
        id: p.id, slug: p.slug, name: p.label, pool: p.kind === "pool",
        members: (p.members || []).map((m) => m.provider_key_id),
        ratio: left == null ? null : left / Number(p.max_budget),
        remainingText: left == null ? (p.builtin ? ".env 기본 키" : "한도 없음") : `잔액 ${money(Math.max(0, left))}`,
      };
    }),
  };
}

window.addEventListener("error", (e) => console.error("[bridge]", e.error || e.message));
