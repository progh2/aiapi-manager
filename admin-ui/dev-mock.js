#!/usr/bin/env node
// Firebase·LiteLLM 없이 관리 화면 전체를 돌려 본다. 배포에 쓰지 않는다.
//  1) 흉내 LiteLLM 을 내부 포트에 띄우고, 가짜 학생 호출을 계속 만든다.
//  2) firebase-admin 만 스텁으로 바꾼 뒤 실제 server.js 를 그대로 띄운다.
//     화면은 FIREBASE_CONFIG.apiKey 가 "__MOCK__" 이면 구글 로그인 대신 가짜 로그인을 쓴다.
//     서버는 여전히 토큰을 검증하므로, 이 값이 실제 배포에 들어가도 인증이 풀리지 않는다.
// 사용: npm run mock → http://127.0.0.1:3456   (?as=user 는 등록 사용자 화면)
//       MOCK_SIMULATE=0 이면 가짜 호출을 만들지 않는다.
//       흉내 LLM(:4456)이 AI 엘피의 Ollama·OpenAI 호환 서버 노릇을 한다. MOCK_ASSISTANT=off 면 엘피 설정을 비워 둔다.

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { scheduleAllows } = require("./lib/schedule");
const { createFakeLlm, openaiReply } = require("./dev-llm");

const PORT = Number(process.env.PORT || 3456);
const LITE_PORT = Number(process.env.MOCK_LITELLM_PORT || 4455);
const LLM_PORT = Number(process.env.MOCK_LLM_PORT || 4456);
const SIMULATE = process.env.MOCK_SIMULATE !== "0";
const MASTER = "sk-mock-master";
const ADMIN = "teacher@school.kr";
const STUDENT = "student@school.kr";
const DAY = 86400000;

// ---------------------------------------------------------------- 흉내 LiteLLM 상태
const db = { keys: [], teams: [], users: new Map(), models: [], logs: [], daily: new Map() };
const hash = (raw) => crypto.createHash("sha256").update(raw).digest("hex");
const uid = () => crypto.randomUUID();
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const seoulYmd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d);
const seoulParts = (d) => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.find((x) => x.type === "weekday").value];
  return { isoDay: wd, hour: Number(p.find((x) => x.type === "hour").value) % 24 };
};

function parseDuration(value, now = Date.now()) {
  const m = /^(\d+)([smhd])$/.exec(String(value || ""));
  if (!m) return null;
  const mult = { s: 1000, m: 60000, h: 3600000, d: DAY }[m[2]];
  return new Date(now + Number(m[1]) * mult).toISOString();
}

function newKeyRecord(body, raw) {
  const key = raw || `sk-${crypto.randomBytes(16).toString("base64url")}`;
  return {
    token: hash(key),
    key_alias: body.key_alias || null,
    team_id: body.team_id || null,
    user_id: body.user_id || null,
    max_budget: body.max_budget ?? null,
    budget_duration: body.budget_duration || null,
    models: Array.isArray(body.models) ? body.models : [],
    rpm_limit: body.rpm_limit ?? null,
    tpm_limit: body.tpm_limit ?? null,
    metadata: body.metadata || {},
    expires: body.duration ? parseDuration(body.duration) : null,
    blocked: false,
    spend: 0,
    created_at: new Date().toISOString(),
    _raw: key,
  };
}

function publicKey(k) {
  const { _raw, ...rest } = k;
  return rest;
}

function fail(res, status, message) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message } }));
}

function modelNames() {
  const names = new Set(["gpt-4o-mini", "gpt-4o"]);
  for (const m of db.models) names.add(m.model_name);
  return [...names];
}

// v2 는 "YYYY-MM-DD HH:MM:SS"(UTC) 를 받는다.
const parseStamp = (s) => (s ? Date.parse(String(s).replace(" ", "T") + (String(s).length <= 10 ? "T00:00:00Z" : "Z")) : NaN);

async function handleLite(req, res, body) {
  const url = new URL(req.url, "http://lite");
  const p = url.pathname;
  const q = url.searchParams;
  const ok = (data) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };

  if (p === "/health/liveliness") return ok("I'm alive!");
  if (p === "/health/readiness") return ok({ status: "healthy", db: "connected", litellm_version: "mock" });
  // AI 엘피 "프록시 방식": 비서 전용 가상 키로 부르면 흉내 LLM 이 답하고 호출 기록이 남는다.
  if (p === "/v1/chat/completions") {
    const bearer = String(req.headers.authorization || "").replace(/^Bearer /, "");
    const key = db.keys.find((k) => k.token === hash(bearer));
    if (!key && bearer !== MASTER) return fail(res, 401, "Authentication Error, Invalid proxy server token passed");
    if (key && key.blocked) return fail(res, 401, "Key is blocked. Update via `/key/unblock` if you're an admin.");
    const out = openaiReply(body);
    if (key) logCall(key, { model: body.model, ok: true, promptTok: out.usage.prompt_tokens, completionTok: out.usage.completion_tokens, spend: ((out.usage.prompt_tokens * 0.4 + out.usage.completion_tokens * 1.6) / 1e6) * 12 });
    return ok(out);
  }
  if ((req.headers.authorization || "") !== `Bearer ${MASTER}`) return fail(res, 401, "Authentication Error, Invalid proxy server token passed");
  if (p === "/v1/models") return ok({ data: modelNames().map((id) => ({ id, object: "model" })) });

  // ---- 키
  if (p === "/key/generate") {
    if (body.key_alias && db.keys.some((k) => k.key_alias === body.key_alias)) {
      return fail(res, 400, `Key with alias '${body.key_alias}' already exists. Unique key aliases across all keys are required.`);
    }
    if (body.key && db.keys.some((k) => k._raw === body.key)) return fail(res, 400, "Key already exists");
    const rec = newKeyRecord(body, body.key || null);
    db.keys.push(rec);
    return ok({ ...publicKey(rec), key: rec._raw });
  }
  if (p === "/key/list") {
    const size = Math.min(100, Number(q.get("size") || 10));
    const page = Math.max(1, Number(q.get("page") || 1));
    const all = db.keys.map(publicKey);
    return ok({ keys: all.slice((page - 1) * size, page * size), total_count: all.length, current_page: page, total_pages: Math.max(1, Math.ceil(all.length / size)) });
  }
  if (p === "/key/info") {
    const needle = q.get("key") || "";
    const k = db.keys.find((x) => x.token === needle || x._raw === needle || x.token === hash(needle));
    if (!k) return fail(res, 404, "Key not found");
    return ok({ key: k.token, info: publicKey(k) });
  }
  if (p === "/key/update") {
    const k = db.keys.find((x) => x.token === body.key || x._raw === body.key);
    if (!k) return fail(res, 404, "Key not found");
    for (const f of ["key_alias", "max_budget", "budget_duration", "rpm_limit", "tpm_limit", "models", "metadata", "user_id"]) {
      if (body[f] !== undefined) k[f] = body[f];
    }
    if (body.team_id !== undefined) k.team_id = body.team_id || null;
    if (body.duration) k.expires = parseDuration(body.duration);
    return ok(publicKey(k));
  }
  if (p === "/key/block" || p === "/key/unblock") {
    const k = db.keys.find((x) => x.token === body.key || x._raw === body.key);
    if (!k) return fail(res, 404, "Key not found");
    k.blocked = p === "/key/block";
    return ok({ blocked: k.blocked });
  }
  if (p === "/key/delete") {
    const doomed = new Set(body.keys || []);
    const before = db.keys.length;
    db.keys = db.keys.filter((k) => !doomed.has(k.token) && !doomed.has(k._raw));
    if (before === db.keys.length) return fail(res, 404, "Key not found");
    return ok({ deleted_keys: body.keys });
  }

  // ---- 학급(팀)
  if (p === "/team/list") return ok(db.teams);
  if (p === "/team/new") {
    const t = {
      team_id: uid(), team_alias: body.team_alias, max_budget: body.max_budget ?? null,
      budget_duration: body.budget_duration || null, models: body.models || [],
      rpm_limit: body.rpm_limit ?? null, tpm_limit: body.tpm_limit ?? null,
      metadata: body.metadata || {}, spend: 0, created_at: new Date().toISOString(),
    };
    db.teams.push(t);
    return ok(t);
  }
  if (p === "/team/update") {
    const t = db.teams.find((x) => x.team_id === body.team_id);
    if (!t) return fail(res, 404, "Team not found");
    for (const f of ["team_alias", "max_budget", "budget_duration", "models", "rpm_limit", "tpm_limit", "metadata"]) {
      if (body[f] !== undefined) t[f] = body[f];
    }
    return ok({ data: t, team_id: t.team_id });
  }
  if (p === "/team/delete") {
    const doomed = new Set(body.team_ids || []);
    db.teams = db.teams.filter((t) => !doomed.has(t.team_id));
    db.keys = db.keys.filter((k) => !doomed.has(k.team_id));
    return ok({ deleted: [...doomed] });
  }

  // ---- 공급자용 사용자·모델 배포
  if (p === "/user/new") {
    db.users.set(body.user_id, { ...body, spend: 0 });
    return ok(db.users.get(body.user_id));
  }
  if (p === "/user/update") {
    const u = db.users.get(body.user_id);
    if (!u) return fail(res, 404, "User not found");
    Object.assign(u, body);
    return ok(u);
  }
  if (p === "/user/delete") {
    for (const id of body.user_ids || []) db.users.delete(id);
    return ok({ deleted: body.user_ids });
  }
  if (p === "/model/new") {
    const m = { model_id: uid(), model_name: body.model_name, litellm_params: body.litellm_params || {}, model_info: body.model_info || {} };
    db.models.push(m);
    return ok(m);
  }
  if (p === "/model/update") {
    const m = db.models.find((x) => x.model_id === body.model_id);
    if (!m) return fail(res, 404, "Model not found");
    m.litellm_params = { ...m.litellm_params, ...(body.litellm_params || {}) };
    return ok(m);
  }
  if (p === "/model/delete") {
    db.models = db.models.filter((x) => x.model_id !== body.id);
    return ok({ deleted: body.id });
  }

  // ---- 사용량
  if (p === "/user/daily/activity") {
    const start = q.get("start_date");
    const end = q.get("end_date");
    const results = [];
    for (const [date, perKey] of [...db.daily.entries()].sort()) {
      if ((start && date < start) || (end && date > end)) continue;
      const metrics = { spend: 0, api_requests: 0, total_tokens: 0, successful_requests: 0, failed_requests: 0 };
      const apiKeys = {};
      const models = {};
      for (const [token, v] of perKey.entries()) {
        metrics.spend += v.spend;
        metrics.api_requests += v.requests;
        metrics.total_tokens += v.tokens;
        metrics.successful_requests += v.requests - v.failed;
        metrics.failed_requests += v.failed;
        apiKeys[token] = { metrics: { spend: v.spend, api_requests: v.requests, total_tokens: v.tokens }, breakdown: { models: Object.fromEntries(Object.entries(v.models).map(([m, s]) => [m, { metrics: { spend: s } }])) } };
        for (const [m, s] of Object.entries(v.models)) models[m] = { metrics: { spend: (models[m]?.metrics.spend || 0) + s } };
      }
      results.push({ date, metrics, breakdown: { api_keys: apiKeys, models } });
    }
    return ok({ results, metadata: { total_pages: 1, total_spend: results.reduce((a, r) => a + r.metrics.spend, 0) } });
  }
  if (p === "/spend/logs/v2") {
    const from = parseStamp(q.get("start_date"));
    const to = parseStamp(q.get("end_date"));
    let rows = db.logs.filter((r) => {
      const t = Date.parse(r.startTime);
      if (Number.isFinite(from) && t < from) return false;
      if (Number.isFinite(to) && t > to) return false;
      if (q.get("api_key") && r.api_key !== q.get("api_key")) return false;
      if (q.get("model_group") && r.model_group !== q.get("model_group")) return false;
      if (q.get("status_filter") && r.status !== q.get("status_filter")) return false;
      return true;
    });
    rows = rows.sort((a, b) => b.startTime.localeCompare(a.startTime));
    const size = Math.min(100, Number(q.get("page_size") || 50));
    const page = Math.max(1, Number(q.get("page") || 1));
    return ok({ data: rows.slice((page - 1) * size, page * size), total: rows.length, page, page_size: size, total_pages: Math.max(1, Math.ceil(rows.length / size)) });
  }
  if (p === "/spend/logs") return ok([]);
  return fail(res, 404, `mock 미구현: ${p}`);
}

const lite = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return fail(res, 400, "bad json"); }
    handleLite(req, res, body).catch((e) => fail(res, 500, e.message));
  });
});

// ---------------------------------------------------------------- 호출 기록
function dailyBucket(date, token) {
  if (!db.daily.has(date)) db.daily.set(date, new Map());
  const day = db.daily.get(date);
  if (!day.has(token)) day.set(token, { spend: 0, requests: 0, tokens: 0, failed: 0, models: {} });
  return day.get(token);
}

const PRICE = { "gpt-4o-mini": [0.15, 0.6], "gpt-4o": [2.5, 10] };

function logCall(key, { at = new Date(), model, ok, message = "", klass = "Exception", promptTok = 0, completionTok = 0, spend = 0, write = true }) {
  const team = db.teams.find((t) => t.team_id === key.team_id);
  const deployment = db.models.find((m) => m.model_name === model);
  const row = {
    request_id: uid(),
    api_key: key.token,
    model: deployment ? deployment.litellm_params.model : `openai/${model.split("/").pop()}`,
    model_group: model,
    model_id: deployment ? deployment.model_id : "base-" + model,
    spend,
    total_tokens: promptTok + completionTok,
    prompt_tokens: promptTok,
    completion_tokens: completionTok,
    startTime: at.toISOString(),
    endTime: new Date(at.getTime() + (ok ? rand(400, 2600) : rand(5, 40))).toISOString(),
    status: ok ? "success" : "failure",
    team_id: key.team_id || "",
    custom_llm_provider: "openai",
    requester_ip_address: `192.168.10.${20 + (parseInt(key.token.slice(0, 2), 16) % 60)}`,
    metadata: {
      user_api_key_alias: key.key_alias,
      user_api_key_team_alias: team ? team.team_alias : null,
      user_api_key_team_id: key.team_id || null,
      ...(ok ? {} : { error_information: { error_message: message, error_class: klass, error_code: "" } }),
    },
  };
  if (write) {
    db.logs.push(row);
    if (db.logs.length > 6000) db.logs.splice(0, db.logs.length - 6000);
  }
  const bucket = dailyBucket(seoulYmd(at), key.token);
  bucket.requests += 1;
  bucket.tokens += promptTok + completionTok;
  if (ok) {
    bucket.spend += spend;
    bucket.models[model] = (bucket.models[model] || 0) + spend;
    key.spend = (key.spend || 0) + spend;
    if (team) team.spend = (team.spend || 0) + spend;
    const owner = key.user_id && db.users.get(key.user_id);
    if (owner) owner.spend = (owner.spend || 0) + spend;
  } else {
    bucket.failed += 1;
  }
  return row;
}

// 실제 프록시가 거절하는 순서를 흉내 낸다.
function outcomeFor(key, model, now) {
  if (key.blocked) return { ok: false, message: "Key is blocked. Update via `/key/unblock` if you're an admin." };
  if (key.expires && Date.parse(key.expires) < now.getTime()) {
    return { ok: false, message: `Authentication Error - Expired Key. Key Expiry time ${key.expires}` };
  }
  if (!scheduleAllows((key.metadata || {}).aiapi_schedule || [], now)) {
    return { ok: false, message: "지금은 이 키를 쓸 수 있는 시간이 아닙니다. 수업 시간대는 한국(서울) 시각 기준입니다.", klass: "HTTPException" };
  }
  const allowed = key.models && key.models.length ? key.models : modelNames();
  if (!allowed.includes(model)) {
    return { ok: false, message: `key not allowed to access model. This key can only access models=${JSON.stringify(allowed)}. Tried to access ${model}` };
  }
  if (key.max_budget != null && key.spend >= key.max_budget) {
    return { ok: false, message: `Budget has been exceeded! Current cost: ${key.spend.toFixed(4)}, Max budget: ${key.max_budget}`, klass: "BudgetExceededError" };
  }
  const team = db.teams.find((t) => t.team_id === key.team_id);
  if (team && team.max_budget != null && team.spend >= team.max_budget) {
    return { ok: false, message: `Team=${team.team_id} over budget. Spend=${team.spend.toFixed(2)}, Budget=${team.max_budget}`, klass: "BudgetExceededError" };
  }
  const owner = key.user_id && db.users.get(key.user_id);
  if (owner && owner.max_budget != null && owner.spend >= owner.max_budget) {
    return { ok: false, message: `ExceededBudget: User=${key.user_id} over budget. Spend=${owner.spend.toFixed(2)}, Budget=${owner.max_budget}`, klass: "BudgetExceededError" };
  }
  if (Math.random() < 0.025) return { ok: false, message: "Rate limit exceeded: Crossed RPM limit for key", klass: "RateLimitError" };
  return { ok: true };
}

function simulateOne(key, now = new Date(), { write = true } = {}) {
  const allowed = key.models && key.models.length ? key.models : ["gpt-4o-mini"];
  // 가끔 허용 안 된 비싼 모델을 시도하는 학생도 있다.
  const model = Math.random() < 0.06 ? "gpt-4o" : pick(allowed);
  const res = outcomeFor(key, model, now);
  if (!res.ok) return logCall(key, { at: now, model, ok: false, message: res.message, klass: res.klass, promptTok: Math.round(rand(20, 300)), write });
  const [pin, pout] = PRICE[model.split("/").pop()] || PRICE["gpt-4o-mini"];
  const promptTok = Math.round(rand(250, 1800));
  const completionTok = Math.round(rand(80, 900));
  // 화면에서 사용량이 보이도록 실제 단가의 12배로 센다.
  const spend = ((promptTok * pin + completionTok * pout) / 1e6) * 12;
  return logCall(key, { at: now, model, ok: true, promptTok, completionTok, spend, write });
}

// ---------------------------------------------------------------- 시연 데이터
function seed(dataDir) {
  const now = new Date();
  const here = seoulParts(now);
  const hh = (h) => String(Math.max(0, Math.min(23, h))).padStart(2, "0");
  const openNow = [{ days: [here.isoDay], start: `${hh(here.hour - 1)}:00`, end: `${hh(here.hour + 2)}:59` }];
  const closedNow = [{ days: [(here.isoDay % 7) + 1], start: "09:00", end: "10:50" }];

  const team = (alias, extra) => {
    const t = { team_id: uid(), team_alias: alias, max_budget: null, budget_duration: null, models: ["gpt-4o-mini"], rpm_limit: null, tpm_limit: null, metadata: {}, spend: 0, created_at: new Date(now - 40 * DAY).toISOString(), ...extra };
    db.teams.push(t);
    return t;
  };
  const a = team("3학년A반", { max_budget: 50, budget_duration: "30d", rpm_limit: 120, metadata: { aiapi_schedule: openNow } });
  const b = team("3학년B반", { max_budget: 40, budget_duration: "30d", metadata: { aiapi_schedule: closedNow } });
  const cap = team("캡스톤1조", { max_budget: 30, models: ["school-a/gpt-4o-mini", "gpt-4o-mini"] });
  const club = team("AI 동아리", { max_budget: 20, metadata: { aiapi_lockdown: { at: new Date(now - 2 * 3600000).toISOString(), by: ADMIN, reason: "대회 준비 점검", keys: 4 } } });
  const camp = team("캠프1일차", { max_budget: 25 });

  const names = ["홍길동", "김철수", "이영희", "박민수", "최지우", "정하늘", "강서준", "윤다은", "장민재", "임수아", "한지호", "오예린", "서도윤", "신유나", "권태양", "황보람", "안지후", "송하린", "류건우", "배소윤"];
  const key = (alias, t, extra = {}) => {
    const rec = newKeyRecord({ key_alias: alias, team_id: t ? t.team_id : null, max_budget: 2, budget_duration: "30d", models: t ? t.models.slice(0, 1) : [], metadata: { aiapi_schedule: t ? (t.metadata.aiapi_schedule || []) : [], aiapi_schedule_from: t ? "team" : "key" }, duration: "120d", ...extra });
    rec.created_at = new Date(now - rand(20, 40) * DAY).toISOString();
    db.keys.push(rec);
    return rec;
  };
  names.slice(0, 12).forEach((n, i) => key(`2026${String(1001 + i)}-${n}`, a));
  names.slice(12, 20).forEach((n, i) => key(`2026${String(2001 + i)}-${n}`, b));
  names.slice(0, 5).forEach((n, i) => key(`캡스톤-${n}`, cap, { max_budget: 5, models: ["school-a/gpt-4o-mini"], user_id: "provider:school-a", metadata: { aiapi_provider_key_id: "pk_mock_a", aiapi_schedule: [], aiapi_schedule_from: "team" } }));
  names.slice(5, 9).forEach((n) => {
    const k = key(`동아리-${n}`, club);
    k.blocked = true;
    k.metadata.aiapi_lockdown = club.metadata.aiapi_lockdown;
  });
  const campCode = () => "CAMP-" + Array.from({ length: 4 }, () => pick("ABCDEFGHJKMNPQRSTUVWXYZ23456789".split(""))).join("");
  const endOfToday = new Date(new Date().setHours(23, 59, 59, 0));
  for (let i = 0; i < 8; i++) {
    const code = campCode();
    const k = key(code, camp, { max_budget: 1, budget_duration: null, metadata: { aiapi_camp: { kind: "camp", code, prefix: "CAMP", expires_ymd: seoulYmd(now), models: ["gpt-4o-mini"] }, aiapi_schedule: [], aiapi_schedule_from: "key" } }, );
    k.expires = endOfToday.toISOString();
  }
  for (let i = 0; i < 3; i++) {
    const code = campCode();
    const k = key(code, camp, { max_budget: 1, budget_duration: null, metadata: { aiapi_camp: { kind: "camp", code, prefix: "CAMP", expires_ymd: seoulYmd(new Date(now - 3 * DAY)) }, aiapi_schedule: [], aiapi_schedule_from: "key" } });
    k.expires = new Date(now - 3 * DAY + 3600000).toISOString();
    k.blocked = true;
  }
  key("교사-시연", null, { max_budget: null, budget_duration: null, duration: null, models: [] });
  key("교사-실습", null, { max_budget: 10, budget_duration: null, duration: null, models: [] });
  // 만료 임박·만료 상태를 몇 개 만든다.
  db.keys.find((k) => k.key_alias.endsWith("이영희")).expires = new Date(now.getTime() + 3 * DAY).toISOString();
  db.keys.find((k) => k.key_alias.endsWith("정하늘")).expires = new Date(now.getTime() - 1 * DAY).toISOString();
  db.keys.find((k) => k.key_alias.endsWith("한지호")).blocked = true;

  // 공급자 키 2개와 묶음 1개. 실제 저장 파일 형식 그대로 쓴다.
  const deploy = (model_name, model, extraInfo) => {
    const m = { model_id: uid(), model_name, litellm_params: { model, api_key: "sk-mock-provider" }, model_info: extraInfo };
    db.models.push(m);
    return m.model_id;
  };
  db.users.set("provider:school-a", { user_id: "provider:school-a", user_alias: "학교 OpenAI A", max_budget: 60, budget_duration: "30d", spend: 0 });
  db.users.set("provider:school-b", { user_id: "provider:school-b", user_alias: "학교 OpenAI B", max_budget: 40, budget_duration: "30d", spend: 0 });
  db.users.set("pool:class-mix", { user_id: "pool:class-mix", user_alias: "수업용 묶음", max_budget: 30, spend: 0 });
  const aMini = deploy("school-a/gpt-4o-mini", "openai/gpt-4o-mini", { aiapi_provider_key_id: "pk_mock_a" });
  const aFull = deploy("school-a/gpt-4o", "openai/gpt-4o", { aiapi_provider_key_id: "pk_mock_a" });
  const bMini = deploy("school-b/gpt-4o-mini", "openai/gpt-4o-mini", { aiapi_provider_key_id: "pk_mock_b" });
  const pa = deploy("class-mix/gpt-4o-mini", "openai/gpt-4o-mini", { aiapi_pool_id: "pool_mock", aiapi_member_id: "pk_mock_a" });
  const pb = deploy("class-mix/gpt-4o-mini", "openai/gpt-4o-mini", { aiapi_pool_id: "pool_mock", aiapi_member_id: "pk_mock_b" });
  const providers = {
    keys: [
      { id: "pk_mock_a", slug: "school-a", label: "학교 OpenAI A", kind: "key", provider: "openai", api_key: "sk-mock-a-1234", api_base: null, key_hint: "••••1234", max_budget: 60, budget_duration: "30d", litellm_user_id: "provider:school-a", models: [{ name: "gpt-4o-mini", call_name: "school-a/gpt-4o-mini", backend: "openai/gpt-4o-mini", model_id: aMini }, { name: "gpt-4o", call_name: "school-a/gpt-4o", backend: "openai/gpt-4o", model_id: aFull }], created_at: now.toISOString() },
      { id: "pk_mock_b", slug: "school-b", label: "학교 OpenAI B", kind: "key", provider: "openai", api_key: "sk-mock-b-5678", api_base: null, key_hint: "••••5678", max_budget: 40, budget_duration: "30d", litellm_user_id: "provider:school-b", models: [{ name: "gpt-4o-mini", call_name: "school-b/gpt-4o-mini", backend: "openai/gpt-4o-mini", model_id: bMini }], created_at: now.toISOString() },
      { id: "pool_mock", kind: "pool", slug: "class-mix", label: "수업용 묶음", provider: "pool", api_key: "", api_base: null, key_hint: "2:1", max_budget: 30, budget_duration: "", litellm_user_id: "pool:class-mix", models: [{ name: "gpt-4o-mini", call_name: "class-mix/gpt-4o-mini", model_id: pa, model_ids: [pa, pb] }], members: [{ provider_key_id: "pk_mock_a", provider_slug: "school-a", label: "학교 OpenAI A", model: "gpt-4o-mini", weight: 2, model_id: pa }, { provider_key_id: "pk_mock_b", provider_slug: "school-b", label: "학교 OpenAI B", model: "gpt-4o-mini", weight: 1, model_id: pb }], created_at: now.toISOString() },
    ],
  };
  fs.writeFileSync(path.join(dataDir, "provider-keys.json"), JSON.stringify(providers, null, 2));
  // 캡스톤 두 명은 묶음을 쓴다.
  db.keys.filter((k) => k.key_alias.startsWith("캡스톤-")).slice(0, 2).forEach((k) => {
    k.models = ["class-mix/gpt-4o-mini"];
    k.user_id = "pool:class-mix";
    k.metadata.aiapi_provider_key_id = "pool_mock";
  });

  fs.writeFileSync(path.join(dataDir, "users.json"), JSON.stringify({
    users: [
      { email: STUDENT, name: "홍길동", key_aliases: ["20261001-홍길동"], created_at: now.toISOString(), created_by: ADMIN },
      { email: "cap@school.kr", name: "캡스톤 지도교사", key_aliases: db.keys.filter((k) => k.key_alias.startsWith("캡스톤-")).map((k) => k.key_alias), created_at: now.toISOString(), created_by: ADMIN },
    ],
  }, null, 2));

  // 지난 30일 사용 기록. 평일에 많고, 과제 마감이 다가올수록 늘어난다.
  const heavy = new Set(["20261002-김철수", "20262003-서도윤", "캡스톤-홍길동"]);
  for (let back = 29; back >= 0; back--) {
    const day = new Date(now.getTime() - back * DAY);
    const weekend = [6, 7].includes(seoulParts(day).isoDay);
    for (const k of db.keys) {
      if (k.metadata.aiapi_camp) continue;
      const base = heavy.has(k.key_alias) ? 9 : k.key_alias.startsWith("교사") ? 2 : 4;
      const calls = Math.round(Math.max(0, rand(0, base) * (weekend ? 0.25 : 1) * (1 + (29 - back) * 0.025)));
      for (let c = 0; c < calls; c++) {
        const at = new Date(day.getTime() - rand(0, 9) * 3600000);
        const saved = { blocked: k.blocked, expires: k.expires, meta: k.metadata.aiapi_schedule };
        k.blocked = false; k.expires = null; k.metadata.aiapi_schedule = [];
        simulateOne(k, at, { write: back <= 1 });
        k.blocked = saved.blocked; k.expires = saved.expires; k.metadata.aiapi_schedule = saved.meta;
      }
    }
  }
  // 몇 명은 예산 가까이, 한 명은 초과.
  const bump = (suffix, spend) => { const k = db.keys.find((x) => x.key_alias.endsWith(suffix)); if (k) k.spend = spend; };
  bump("김철수", 1.93);
  bump("서도윤", 2.12);
  bump("박민수", 1.66);
}

// ---------------------------------------------------------------- 실행
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aiapi-mock-"));
seed(dataDir);

createFakeLlm().listen(LLM_PORT, "127.0.0.1");
// 엘피를 흉내 Ollama 에 미리 연결해 둔다. 설정 화면 흐름을 보려면 MOCK_ASSISTANT=off.
if (process.env.MOCK_ASSISTANT !== "off") {
  fs.writeFileSync(path.join(dataDir, "assistant.json"), JSON.stringify({
    enabled: true, mode: "direct", provider: "ollama", base_url: `http://127.0.0.1:${LLM_PORT}`, model: "qwen3:8b",
    mask_names: true, allow_users: true,
  }, null, 2));
}

lite.listen(LITE_PORT, "127.0.0.1", () => {
  // 실제 server.js 를 띄운다. firebase-admin 의 app·auth 모듈만 스텁이다.
  const stub = (id, exports) => {
    const file = require.resolve(id);
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
  };
  stub("firebase-admin/app", { initializeApp() {} });
  stub("firebase-admin/auth", {
    getAuth: () => ({
      async verifyIdToken(token) {
        const email = String(token || "").startsWith("mock:") ? token.slice(5) : ADMIN;
        return { email, email_verified: true };
      },
    }),
  });
  Object.assign(process.env, {
    PORT: String(PORT),
    FIREBASE_PROJECT_ID: "aiapi-mock",
    FIREBASE_API_KEY: "__MOCK__",
    ADMIN_EMAILS: ADMIN,
    LITELLM_MASTER_KEY: MASTER,
    LITELLM_BASE_URL: `http://127.0.0.1:${LITE_PORT}`,
    USERS_DATA_PATH: path.join(dataDir, "users.json"),
    PROVIDER_KEYS_PATH: path.join(dataDir, "provider-keys.json"),
    AUDIT_LOG_PATH: path.join(dataDir, "audit.jsonl"),
    ASSISTANT_DATA_PATH: path.join(dataDir, "assistant.json"),
    PUBLIC_PROXY_URL: process.env.PUBLIC_PROXY_URL || "http://192.168.0.10:4000",
  });
  require("./server.js");
  console.log(`admin-ui mock  http://127.0.0.1:${PORT}   (관리자)`);
  console.log(`               http://127.0.0.1:${PORT}/?as=${STUDENT}   (등록 사용자)`);
  console.log(`흉내 LiteLLM   http://127.0.0.1:${LITE_PORT}   데이터 ${dataDir}`);
  console.log(`흉내 LLM       http://127.0.0.1:${LLM_PORT}   (Ollama·OpenAI 호환, AI 엘피용)`);

  if (SIMULATE) {
    const tick = () => {
      const live = db.keys.filter((k) => !k.key_alias.startsWith("교사") || Math.random() < 0.2);
      const burst = Math.random() < 0.15 ? 3 : 1;
      for (let i = 0; i < burst; i++) simulateOne(pick(live));
      setTimeout(tick, rand(900, 3200));
    };
    setTimeout(tick, 1500);
  }
});
