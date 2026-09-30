// 화면 전체가 같이 쓰는 데이터와 주기적 갱신. 스테이션은 on() 으로 바뀐 조각만 다시 그린다.
import {
  keyState, isExpiringSoon, isCamp, isLocked, isRetired, isSystemKey, budgetRatio, sessionState, money, todayYmd, isExpired,
} from "./util.js";

const listeners = new Map();
let api = null;
let timers = [];

export const state = {
  me: null,
  keys: [],
  teams: [],
  providers: [],
  providerCatalog: [],
  models: [],
  campPolicy: { require_models: true, force_same_day_expiry: true, low_cost_models: ["gpt-4o-mini"] },
  users: [],
  analytics: null,
  analyticsOpts: { days: 30, horizon: 14, team_id: "" },
  activity: { items: [], summary: null, at: null },
  status: null,
  loaded: {},
  errors: {},
};

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, payload) {
  for (const fn of listeners.get(event) || []) {
    try { fn(payload); } catch (e) { console.error(`[store] ${event} 처리 실패`, e); }
  }
}

export function init(apiFn, me) {
  api = apiFn;
  state.me = me;
}

async function guarded(name, fn) {
  try {
    const out = await fn();
    state.loaded[name] = Date.now();
    delete state.errors[name];
    emit(name, out);
    emit("any", name);
    return out;
  } catch (e) {
    state.errors[name] = e.message;
    emit("error", { name, error: e });
    throw e;
  }
}

export const loadKeys = () => guarded("keys", async () => {
  state.keys = (await api("/api/keys")).keys || [];
  return state.keys;
});

export const loadTeams = () => guarded("teams", async () => {
  state.teams = (await api("/api/teams")).teams || [];
  return state.teams;
});

export const loadProviders = () => guarded("providers", async () => {
  const [pk, models, camp] = await Promise.all([
    api("/api/provider-keys"),
    api("/api/models").catch(() => ({ models: [] })),
    api("/api/keys/camp/policy").catch(() => null),
  ]);
  state.providers = pk.keys || [];
  state.providerCatalog = pk.providers || [];
  state.models = models.models || [];
  if (camp) state.campPolicy = camp;
  return state.providers;
});

export const loadUsers = () => guarded("users", async () => {
  state.users = (await api("/api/users")).users || [];
  return state.users;
});

export const loadAnalytics = (opts = {}) => guarded("analytics", async () => {
  Object.assign(state.analyticsOpts, opts);
  const { days, horizon, team_id } = state.analyticsOpts;
  const q = `days=${days}&horizon=${horizon}${team_id ? `&team_id=${encodeURIComponent(team_id)}` : ""}`;
  state.analytics = await api(`/api/analytics?${q}`);
  return state.analytics;
});

// 새로 들어온 호출만 골라 3D 입자와 통신 줄에 넘긴다.
const seenCalls = new Set();
export const loadActivity = () => guarded("activity", async () => {
  const data = await api("/api/activity?limit=60&hours=24");
  const fresh = [];
  const first = seenCalls.size === 0;
  for (const it of data.items || []) {
    const id = it.id || `${it.at}-${it.token}`;
    if (!seenCalls.has(id)) {
      seenCalls.add(id);
      if (!first) fresh.push(it);
    }
  }
  if (seenCalls.size > 4000) {
    const keep = [...seenCalls].slice(-2000);
    seenCalls.clear();
    keep.forEach((id) => seenCalls.add(id));
  }
  state.activity = { items: data.items || [], summary: data.summary || null, at: data.at || new Date().toISOString(), fresh };
  if (fresh.length) emit("traffic", fresh);
  return state.activity;
});

export const loadStatus = () => guarded("status", async () => {
  state.status = await api("/api/status");
  return state.status;
});

export async function loadCore() {
  const jobs = [loadKeys(), loadTeams(), loadProviders()];
  return Promise.allSettled(jobs);
}

export async function refreshAll() {
  return Promise.allSettled([loadKeys(), loadTeams(), loadProviders(), loadUsers(), loadAnalytics(), loadActivity(), loadStatus()]);
}

export function startPolling() {
  stopPolling();
  const every = (ms, fn) => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") fn().catch(() => {});
    }, ms);
    timers.push(id);
  };
  every(10000, loadActivity);
  every(60000, loadStatus);
  every(45000, () => Promise.all([loadKeys(), loadTeams()]));
  every(5 * 60000, () => loadAnalytics());
  every(3 * 60000, loadProviders);
}

export function stopPolling() {
  timers.forEach(clearInterval);
  timers = [];
}

// ---------------------------------------------------------------- 조회 도우미
export const teamById = (id) => state.teams.find((t) => t.team_id === id) || null;
export const teamName = (id) => {
  const t = teamById(id);
  return t ? (t.team_alias || t.team_id.slice(0, 8)) : (id ? "(삭제된 학급)" : "");
};
export const keysOfTeam = (id) => state.keys.filter((k) => k.team_id === id);
export const providerById = (id) => state.providers.find((p) => p.id === id) || state.providers.find((p) => p.id === "env") || null;

// 공급자 하나의 모델 체크박스 항목. value 는 학생이 쓰는 호출 이름이다.
export const providerEntries = (id) => (providerById(id)?.models || []).map((m) => ({ value: m.call_name, label: m.name }));

export function providerIdFromModels(models) {
  const first = (models || [])[0] || "";
  const slash = first.indexOf("/");
  if (slash <= 0) return "env";
  const slug = first.slice(0, slash);
  return state.providers.find((p) => p.slug === slug)?.id || "env";
}

export function isCampLowCost(name) {
  const list = state.campPolicy.low_cost_models || ["gpt-4o-mini"];
  if (list.includes(name)) return true;
  return /(mini|nano|flash|haiku|small)/i.test(String(name || ""));
}

export function teamStats(teamId) {
  const keys = keysOfTeam(teamId).filter((k) => !isRetired(k));
  const now = Date.now();
  const out = { total: keys.length, active: 0, blocked: 0, over: 0, warn: 0, expired: 0 };
  for (const k of keys) {
    const st = keyState(k, now).code;
    if (st === "active") out.active += 1;
    else if (st === "blocked" || st === "locked") out.blocked += 1;
    else if (st === "over") out.over += 1;
    else if (st === "warn") { out.warn += 1; out.active += 1; }
    else if (st === "expired") out.expired += 1;
  }
  return out;
}

export function keyCounts() {
  const now = Date.now();
  const out = { total: 0, active: 0, blocked: 0, expired: 0, over: 0, warn: 0, expiring: 0, camp: 0, campToday: 0 };
  const today = todayYmd();
  for (const k of state.keys) {
    if (isRetired(k) || isSystemKey(k)) continue;
    out.total += 1;
    const st = keyState(k, now).code;
    if (st === "active" || st === "warn") out.active += 1;
    if (st === "blocked" || st === "locked") out.blocked += 1;
    if (st === "expired") out.expired += 1;
    if (st === "over") out.over += 1;
    if (st === "warn") out.warn += 1;
    if (!k.blocked && isExpiringSoon(k, 7, now)) out.expiring += 1;
    if (isCamp(k)) {
      out.camp += 1;
      const ymd = k.metadata.aiapi_camp.expires_ymd;
      if (!k.blocked && (ymd ? ymd === today : !isExpired(k, now))) out.campToday += 1;
    }
  }
  return out;
}

export function sessionCounts(now = new Date()) {
  let open = 0;
  let always = 0;
  for (const t of state.teams) {
    const s = sessionState(t.metadata && t.metadata.aiapi_schedule, now).code;
    if (s === "open") open += 1;
    if (s === "always") always += 1;
  }
  return { open, always, total: state.teams.length };
}

// 개요와 상단 경보등이 같이 쓰는 경보 목록. 심각한 것부터.
export function alerts() {
  const out = [];
  const now = Date.now();
  const add = (level, title, detail, go) => out.push({ level, title, detail, go });
  const st = state.status;
  if (st && st.litellm && !st.litellm.live) {
    add("crit", "프록시(LiteLLM) 응답 없음", st.litellm.error || "학생 호출이 모두 실패합니다. 컨테이너 상태를 확인하세요.", { station: "log", tab: "system" });
  } else if (st && st.litellm && st.litellm.db && st.litellm.db !== "connected") {
    add("crit", "데이터베이스 연결 이상", `LiteLLM 이 DB 를 ${st.litellm.db} 로 보고합니다.`, { station: "log", tab: "system" });
  }
  if (st && st.stores && (!st.stores.users.ok || !st.stores.providers.ok)) {
    add("crit", "저장 파일 손상", "users.json 또는 provider-keys.json 을 읽지 못했습니다. 복구가 필요합니다.", { station: "log", tab: "system" });
  }
  for (const t of state.teams) {
    const lock = t.metadata && t.metadata.aiapi_lockdown;
    if (lock) add("crit", `${t.team_alias} 봉쇄 중`, `${lock.reason ? lock.reason + " · " : ""}${lock.by || ""} · 키 ${lock.keys ?? "?"}개 차단`, { station: "classes", team_id: t.team_id });
    const r = budgetRatio(t.spend, t.max_budget);
    if (r != null && r >= 1) add("crit", `${t.team_alias} 학급 예산 소진`, `${money(t.spend)} / ${money(t.max_budget)} — 소속 학생 호출이 막힙니다.`, { station: "classes", team_id: t.team_id });
    else if (r != null && r >= 0.8) add("warn", `${t.team_alias} 학급 예산 ${Math.round(r * 100)}%`, `${money(t.spend)} / ${money(t.max_budget)}`, { station: "classes", team_id: t.team_id });
  }
  for (const p of state.providers) {
    if (p.builtin || p.max_budget == null || p.remaining == null) continue;
    const left = Number(p.remaining);
    const ratio = left / Number(p.max_budget);
    if (left <= 0) add("crit", `공급자 "${p.label}" 한도 소진`, "이 키로 나가는 학생 호출이 모두 멈춥니다.", { station: "engines", id: p.id });
    else if (ratio <= 0.2) add("warn", `공급자 "${p.label}" 잔액 ${money(left)}`, `전체 ${money(p.max_budget)} 중 ${Math.round(ratio * 100)}% 남음`, { station: "engines", id: p.id });
  }
  const c = keyCounts();
  if (c.over) add("warn", `예산 소진 키 ${c.over}개`, "충전하거나 수업 계획을 확인하세요.", { station: "keys", filter: "over" });
  if (c.warn) add("warn", `예산 80% 넘은 키 ${c.warn}개`, "곧 호출이 막힐 수 있습니다.", { station: "keys", filter: "warn" });
  if (c.expiring) add("warn", `7일 안에 만료되는 키 ${c.expiring}개`, "연장이 필요하면 상세에서 늘리세요.", { station: "keys", filter: "expiring" });
  if (c.campToday) add("info", `오늘 캠프 키 ${c.campToday}개 사용 중`, "캠프가 끝나면 일괄 차단하세요.", { station: "launch", tab: "camp" });
  const soon = state.analytics && state.analytics.soonestTeam;
  if (soon && soon.daysLeft != null && soon.daysLeft > 0 && soon.daysLeft <= 7) {
    add("warn", `${soon.name} 예산이 약 ${soon.daysLeft}일 뒤 소진`, `최근 속도 기준 · 잔여 ${money(Math.max(0, soon.left))}`, { station: "telemetry" });
  }
  const sum = state.activity.summary;
  if (sum && sum.unpriced) {
    add("warn", `가격 없는 모델 호출 ${sum.unpriced}건`, `${(sum.unpriced_models || []).join(", ")} — LiteLLM 가격표에 없는 모델이라 비용이 $0 으로 기록되고 예산이 줄지 않습니다. litellm 컨테이너를 다시 시작하면 최신 가격표를 받아 옵니다.`, { station: "log", tab: "activity" });
  }
  if (sum && sum.total >= 10 && sum.failed / sum.total >= 0.3) {
    add("warn", `최근 호출 실패율 ${Math.round((sum.failed / sum.total) * 100)}%`, "기록 → 실시간 호출에서 이유를 확인하세요.", { station: "log", tab: "activity" });
  }
  const order = { crit: 0, warn: 1, info: 2, good: 3 };
  out.sort((a, b) => order[a.level] - order[b.level]);
  return out;
}

export function conditionLevel(list = alerts()) {
  if (list.some((a) => a.level === "crit")) return "red";
  if (list.some((a) => a.level === "warn")) return "yellow";
  return "green";
}

export function lockedTeams() {
  return state.teams.filter((t) => isLocked(t));
}
