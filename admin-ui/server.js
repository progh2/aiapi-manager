// 관리자 UI 백엔드.
// Firebase ID 토큰을 검증하고, 허용된 관리자 이메일만 LiteLLM 관리 API를 호출할 수 있다.
// LITELLM_MASTER_KEY는 이 서버에만 존재하며 브라우저로 나가지 않는다.
const express = require("express");
const path = require("path");
const fs = require("fs");
// firebase-admin 14 에는 네임스페이스 API(admin.auth)가 없다. 모듈 API 를 쓴다.
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { UsersStore } = require("./lib/users-store");
const { checkAlias } = require("./lib/aliases");
const { assignClassBudgets, keyGenerateParams } = require("./lib/class-assign");
const { revokeKeys } = require("./lib/key-revoke");
const { adjustKey, keyDetail, findKey } = require("./lib/key-adjust");
const { attachProvider, ProviderKeyStore, envProvider, toPublic, spendFor, registerProvider, registerPool, updateProvider, deleteProvider, matchPoolCalls } = require("./lib/provider-keys");
const { applyIssueSchedule, keysFollowingTeam, teamScheduleMetadata, keepCampSchedule } = require("./lib/team-schedule");
const { reissueKey } = require("./lib/key-reissue");
const { PROVIDERS, listProviderModels } = require("./lib/provider-catalog");
const { resolveIssueModels, teamModelsFor } = require("./lib/model-allowlist");
const { issueCampKeys, campIssuePolicy, revokeCampKeys, todayYmd } = require("./lib/camp-keys");
const { DAY_MS, ymd, buildAnalytics } = require("./lib/analytics");
const { AuditLog } = require("./lib/audit-log");
const { toActivity, summarizeActivity, activityQuery, rowsOf } = require("./lib/activity");
const { adjustKeys } = require("./lib/key-adjust");
const { lockdownTeam, liftLockdown } = require("./lib/lockdown");
const { AssistantStore } = require("./lib/assistant/store");
const { mountAssistant, createLimiter } = require("./lib/assistant/routes");
const { KeyVault } = require("./lib/key-vault");
const { linkStudentAccounts } = require("./lib/user-link");
const { version: APP_VERSION } = require("./package.json");

const {
  FIREBASE_PROJECT_ID,
  FIREBASE_API_KEY = "",
  FIREBASE_AUTH_DOMAIN = "",
  ADMIN_EMAILS = "",
  LITELLM_BASE_URL = "http://litellm:4000",
  LITELLM_MASTER_KEY,
  USERS_DATA_PATH = path.join(__dirname, "data", "users.json"),
  PROVIDER_KEYS_PATH = path.join(__dirname, "data", "provider-keys.json"),
  AUDIT_LOG_PATH = path.join(__dirname, "data", "audit.jsonl"),
  ASSISTANT_DATA_PATH = path.join(__dirname, "data", "assistant.json"),
  // 학생이 로그인해 자기 키를 다시 볼 수 있게 발급한 키 원문을 암호화해 둔다.
  KEY_VAULT_PATH = path.join(__dirname, "data", "key-vault.json"),
  KEY_VAULT_SECRET = "",
  // NAS 자동 업데이트(scripts/nas-auto-update.sh)가 남기는 결과. 시스템 상태에 보인다.
  AUTO_UPDATE_STATUS_PATH = path.join(__dirname, "data", "auto-update.json"),
  // 학생에게 안내할 프록시 주소. 비우면 화면이 접속 주소와 LITELLM_PORT 로 만든다.
  PUBLIC_PROXY_URL = "",
  LITELLM_PORT = "4000",
  PORT = 3000,
} = process.env;

if (!FIREBASE_PROJECT_ID || !LITELLM_MASTER_KEY) {
  console.error("FIREBASE_PROJECT_ID와 LITELLM_MASTER_KEY 환경변수가 필요합니다");
  process.exit(1);
}

// ID 토큰 검증만 하므로 서비스 계정 키 없이 projectId만으로 초기화
initializeApp({ projectId: FIREBASE_PROJECT_ID });

const adminEmails = new Set(
  ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)
);
const usersStore = new UsersStore(USERS_DATA_PATH);
const providerStore = new ProviderKeyStore(PROVIDER_KEYS_PATH);
const auditLog = new AuditLog(AUDIT_LOG_PATH);
const assistantStore = new AssistantStore(ASSISTANT_DATA_PATH);
const keyVault = new KeyVault(KEY_VAULT_PATH, KEY_VAULT_SECRET || LITELLM_MASTER_KEY);
const revealLimiter = createLimiter();
const STARTED_AT = Date.now();
const firebaseClientConfig = {
  apiKey: FIREBASE_API_KEY || "REPLACE_ME",
  authDomain: FIREBASE_AUTH_DOMAIN || `${FIREBASE_PROJECT_ID}.firebaseapp.com`,
  projectId: FIREBASE_PROJECT_ID,
};

const app = express();
app.use(express.json({ limit: "1mb" }));
app.get("/firebase-config.js", (_req, res) => {
  res.type("application/javascript").send(
    `window.FIREBASE_CONFIG = ${JSON.stringify(firebaseClientConfig)};\n`
  );
});
// 3D·글꼴은 npm 으로 받은 파일을 그대로 준다. 교실 망에서 CDN 에 기대지 않는다.
const vendorDir = (rel) => path.join(__dirname, "node_modules", rel);
app.use("/vendor/three", express.static(vendorDir("three/build"), { maxAge: "7d" }));
app.use("/vendor/fonts/pretendard", express.static(vendorDir("@fontsource/pretendard/files"), { maxAge: "30d" }));
app.use("/vendor/fonts/orbitron", express.static(vendorDir("@fontsource-variable/orbitron/files"), { maxAge: "30d" }));
app.use("/vendor/fonts/jetbrains-mono", express.static(vendorDir("@fontsource-variable/jetbrains-mono/files"), { maxAge: "30d" }));
app.use(express.static(__dirname + "/public"));
// 브라우저 명단 파서가 서버와 같은 규칙을 쓰도록 lib 파일을 그대로 제공한다.
app.get("/roster.js", (_req, res) => {
  res.type("application/javascript").sendFile(__dirname + "/lib/roster.js");
});
app.get("/key-revoke.js", (_req, res) => {
  res.type("application/javascript").sendFile(__dirname + "/lib/key-revoke.js");
});

// Compose healthcheck용. 인증 없이 프로세스 생존만 확인.
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

function isAdminEmail(email) {
  return adminEmails.has((email || "").toLowerCase());
}

// 관리 작업을 컨테이너 로그와 audit.jsonl 에 함께 남긴다.
// AI 엘피의 제안 카드로 실행한 작업은 화면이 X-AIAPI-Via: elfy 를 붙여 보낸다.
function record(req, action, target, detail, message) {
  const actor = req.adminEmail || (req.user && req.user.email) || null;
  const viaElfy = req.get && req.get("x-aiapi-via") === "elfy";
  if (message) console.log(`${actor} 이(가) ${message}${viaElfy ? " (엘피 제안)" : ""}`);
  const d = viaElfy ? { ...(detail && typeof detail === "object" ? detail : {}), via: "elfy" } : detail;
  return auditLog.append({ actor, action, target, detail: d });
}

async function verifyToken(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (!token) return null;
  try {
    const decoded = await getAuth().verifyIdToken(token);
    if (!decoded.email_verified) return null;
    return decoded;
  } catch {
    return null;
  }
}

async function requireRegistered(req, res, next) {
  const decoded = await verifyToken(req);
  if (!decoded) return res.status(401).json({ error: "로그인이 필요합니다" });
  const email = (decoded.email || "").toLowerCase();
  if (isAdminEmail(email)) {
    req.user = { email, name: email.split("@")[0], role: "admin", key_aliases: [] };
    req.adminEmail = email;
    return next();
  }
  if (usersStore.isCorrupt()) {
    return res.status(503).json({ error: "사용자 명단 파일이 손상되었습니다. 관리자에게 복구를 요청하세요." });
  }
  const registered = usersStore.get(email);
  if (!registered) {
    return res.status(403).json({ error: "등록되지 않은 계정입니다. 관리자에게 가입을 요청하세요." });
  }
  req.user = { ...registered, role: "user" };
  next();
}

async function requireAdmin(req, res, next) {
  const decoded = await verifyToken(req);
  if (!decoded) return res.status(401).json({ error: "로그인이 필요합니다" });
  const email = (decoded.email || "").toLowerCase();
  if (!isAdminEmail(email)) {
    return res.status(403).json({ error: `관리자 권한이 없는 계정입니다: ${email}` });
  }
  req.adminEmail = email;
  req.user = { email, name: email.split("@")[0], role: "admin", key_aliases: [] };
  next();
}

async function litellm(path, method = "GET", body) {
  const resp = await fetch(LITELLM_BASE_URL + path, {
    method,
    headers: {
      Authorization: `Bearer ${LITELLM_MASTER_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error?.message || `LiteLLM ${resp.status}`);
  // 새로 만든 키 원문은 이 응답에만 온다. 학생이 나중에 로그인해 볼 수 있게 암호화해 보관한다(비서 전용 키는 뺀다).
  if (path === "/key/generate" && data && typeof data.key === "string" && !(body && body.metadata && body.metadata.aiapi_system)) {
    try {
      keyVault.put(data.key, { alias: data.key_alias || (body && body.key_alias) || null });
    } catch (e) {
      console.error("키 보관 실패:", e.message);
    }
  }
  return data;
}

async function listTeams() {
  const teams = [];
  for (let page = 1; ; page++) {
    const path = page === 1 ? "/team/list" : `/team/list?page=${page}`;
    const data = await litellm(path);
    const batch = Array.isArray(data) ? data : data.teams || [];
    teams.push(...batch);
    const total = data?.metadata?.total_pages || data?.total_pages || 1;
    if (page >= total || !batch.length || Array.isArray(data)) break;
  }
  return teams;
}

// 발급/수정 공통: 클라이언트 입력에서 LiteLLM 키 파라미터만 추려 만든다.
// expires(YYYY-MM-DD)가 있으면 LiteLLM이 받는 duration(초)으로 바꾼다.
function keyParams(body, { clearEmpty = false } = {}) {
  const p = keyGenerateParams(body);
  if (!clearEmpty) return p;
  if (body.budget_duration === "" || body.budget_duration === null) p.budget_duration = null;
  if (body.rpm_limit === "" || body.rpm_limit === null) p.rpm_limit = null;
  if (body.tpm_limit === "" || body.tpm_limit === null) p.tpm_limit = null;
  return p;
}

async function fetchAllKeys() {
  const keys = [];
  for (let page = 1; page <= 100; page++) {
    const data = await litellm(`/key/list?return_full_object=true&size=100&page=${page}`);
    keys.push(...(data.keys || []));
    if (page >= (data.total_pages || 1)) break;
  }
  return keys;
}

function toPublicKey(k, teamNames) {
  return {
    key_alias: k.key_alias || null,
    spend: k.spend || 0,
    max_budget: k.max_budget ?? null,
    budget_duration: k.budget_duration || null,
    expires: k.expires || null,
    models: Array.isArray(k.models) ? k.models : [],
    rpm_limit: k.rpm_limit ?? null,
    tpm_limit: k.tpm_limit ?? null,
    blocked: Boolean(k.blocked),
    team_id: k.team_id || null,
    team_alias: k.team_id ? (teamNames.get(k.team_id) || null) : null,
    // 학생이 "지금 쓸 수 있는 시간인지" 알 수 있게 자기 키의 시간표만 준다.
    schedule: Array.isArray(k.metadata && k.metadata.aiapi_schedule) ? k.metadata.aiapi_schedule : [],
  };
}

function guardStore(res) {
  if (!usersStore.isCorrupt()) return true;
  res.status(503).json({ error: "users.json이 손상되었습니다. 파일을 복구하고 서버를 다시 시작하세요." });
  return false;
}

// ---- 그룹(LiteLLM Team) 관리 ----
// 그룹 예산·제한은 소속 키 전체의 합산 사용량에 적용된다.

app.get("/api/teams", requireAdmin, async (req, res) => {
  try {
    res.json({ teams: await listTeams() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

async function loadTeam(teamId) {
  if (!teamId) return null;
  const teams = await listTeams();
  return teams.find((team) => team.team_id === teamId) || null;
}

// 작업 기록에는 학급 id 대신 이름을 남긴다. 조회가 실패해도 기록은 남긴다.
async function teamLabel(teamId) {
  if (!teamId) return null;
  try {
    const team = await loadTeam(teamId);
    return (team && team.team_alias) || teamId;
  } catch {
    return teamId;
  }
}

async function syncTeamSchedule(teamId, schedule) {
  const keys = keysFollowingTeam(await fetchAllKeys(), teamId);
  let updated = 0;
  for (const key of keys) {
    if (!key.token) continue;
    const metadata = { ...(key.metadata || {}), aiapi_schedule: schedule, aiapi_schedule_from: "team" };
    await litellm("/key/update", "POST", { key: key.token, metadata });
    updated += 1;
  }
  return updated;
}

app.post("/api/teams", requireAdmin, async (req, res) => {
  if (!req.body.alias) return res.status(400).json({ error: "그룹 이름이 필요합니다" });
  try {
    const prepared = attachProvider(req.body, providerStore, { bindUser: false });
    const schedule = teamScheduleMetadata(null, req.body.schedule || []).aiapi_schedule;
    const data = await litellm("/team/new", "POST", {
      team_alias: prepared.alias,
      ...keyParams(prepared),
      metadata: { aiapi_schedule: schedule },
    });
    record(req, "team.create", req.body.alias, {
      team_id: data.team_id, budget: req.body.budget, models: prepared.models,
    }, `그룹 생성: ${req.body.alias}`);
    res.json(data);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

app.post("/api/teams/update", requireAdmin, async (req, res) => {
  if (!req.body.team_id) return res.status(400).json({ error: "team_id가 필요합니다" });
  try {
    const prepared = attachProvider(req.body, providerStore, { bindUser: false });
    const existing = await loadTeam(req.body.team_id);
    const schedule = teamScheduleMetadata(existing && existing.metadata, req.body.schedule || []).aiapi_schedule;
    const data = await litellm("/team/update", "POST", {
      team_id: prepared.team_id,
      ...keyParams(prepared, { clearEmpty: true }),
      metadata: teamScheduleMetadata(existing && existing.metadata, schedule),
    });
    const updated = await syncTeamSchedule(req.body.team_id, schedule);
    record(req, "team.update", req.body.alias || existing?.team_alias || req.body.team_id, {
      team_id: req.body.team_id, budget: req.body.budget, schedule_keys: updated,
    }, `그룹 수정: ${req.body.team_id} (시간표 키 ${updated})`);
    res.json({ ...data, schedule_keys: updated });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

app.post("/api/teams/delete", requireAdmin, async (req, res) => {
  if (!req.body.team_id) return res.status(400).json({ error: "team_id가 필요합니다" });
  try {
    const doomed = await loadTeam(req.body.team_id);
    res.json(await litellm("/team/delete", "POST", { team_ids: [req.body.team_id] }));
    record(req, "team.delete", doomed?.team_alias || req.body.team_id, { team_id: req.body.team_id },
      `그룹 삭제: ${req.body.team_id}`);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 학급 일괄 예산 부여: students[] 또는 csv 텍스트.
// 조/학급은 team_id 또는 team(이름, 없으면 생성). 행별 성공/실패를 돌려준다.
app.post("/api/keys/bulk", requireAdmin, async (req, res) => {
  try {
    const prepared = attachProvider(req.body, providerStore);
    const out = await assignClassBudgets(prepared, { litellm });
    // 명단에 이메일이 있으면 학생 계정을 등록·연결한다. 학생은 그 구글 계정으로 로그인해 자기 키를 본다.
    out.accounts = linkStudentAccounts(usersStore, out.results, { by: req.adminEmail, adminEmails });
    const n = out.results.length;
    const fail = out.results.filter((r) => r.error && !r.skipped).length;
    const acc = out.accounts;
    record(req, "keys.bulk", out.team_alias || await teamLabel(out.team_id), {
      count: n, failed: fail, budget: out.max_budget, expires: out.expires, models: out.models,
      accounts_created: acc.created || undefined, accounts_linked: acc.linked || undefined,
    }, `일괄 발급: ${n}명 (실패 ${fail})${acc.created || acc.linked ? ` · 계정 등록 ${acc.created} · 연결 ${acc.linked}` : ""}`);
    res.json(out);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// 캠프 짧은 키 N개. 명단 없이 인원만. 저가 모델 필수·당일 종료 강제.
app.post("/api/keys/camp", requireAdmin, async (req, res) => {
  try {
    const prepared = attachProvider(req.body, providerStore);
    const out = await issueCampKeys(prepared, { litellm });
    const fail = out.results.filter((r) => r.error).length;
    record(req, "keys.camp", out.prefix, {
      count: out.count, failed: fail, expires: out.expires, models: out.models, team: out.team_alias || out.team_id,
    }, `캠프 키 발급: ${out.count}개 (실패 ${fail}) 만료 ${out.expires} 모델 ${(out.models || []).join(",")}`);
    res.json(out);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// 캠프 발급 정책(저가 모델·당일 종료·회수 훅). UI가 폼을 잠글 때 쓴다.
app.get("/api/keys/camp/policy", requireAdmin, async (_req, res) => {
  const policy = campIssuePolicy();
  res.json({
    ...policy,
    expires: todayYmd(),
  });
});

// 캠프 키 당일/만료 회수. 스케줄(cron)과 화면의 수동 훅.
app.post("/api/keys/camp/revoke", requireAdmin, async (req, res) => {
  try {
    const out = await revokeCampKeys(req.body, { litellm });
    const n = out.results.length;
    const fail = out.results.filter((r) => r.error).length;
    const verb = out.action === "delete" ? "회수" : "차단";
    record(req, "keys.camp.revoke", out.filter, { action: out.action, count: n, failed: fail },
      `캠프 키 ${verb}: ${n}개 (실패 ${fail}) filter ${out.filter}`);
    res.json(out);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// ---- 사용량 분석 ----
// 일별 지출 시계열 + 키/모델별 집계. LiteLLM의 /user/daily/activity는
// 오픈소스에서 쓸 수 있는 집계 엔드포인트다(/global/spend/report는 엔터프라이즈 전용).

// 페이지를 모두 돌아 기간 내 일별 레코드를 모은다.
async function dailyActivity(start, end) {
  const results = [];
  for (let page = 1; page <= 100; page++) {
    const d = await litellm(
      `/user/daily/activity?start_date=${ymd(start)}&end_date=${ymd(end)}&page=${page}&page_size=100`
    );
    results.push(...(d.results || []));
    const total = d.metadata?.total_pages || d.total_pages || 1;
    if (page >= total) break;
  }
  return results;
}

async function analyticsFor({ days = 30, horizon = 14, teamId = "" } = {}) {
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * DAY_MS);
  const results = await dailyActivity(start, end);
  // 키 해시 → 별칭/그룹 이름으로 치환
  const [keyList, teams] = await Promise.all([fetchAllKeys(), listTeams()]);
  if (teamId && !teams.some((t) => t.team_id === teamId)) {
    const err = new Error("알 수 없는 학급/조입니다");
    err.status = 400;
    throw err;
  }
  return buildAnalytics({ results, keyList, teams, start, end, horizon, teamId });
}

app.get("/api/analytics", requireAdmin, async (req, res) => {
  const days = Math.min(180, Math.max(7, Number(req.query.days) || 30));
  const horizon = Math.min(90, Math.max(1, Number(req.query.horizon) || 14));
  const teamId = String(req.query.team_id || "");
  try {
    res.json(await analyticsFor({ days, horizon, teamId }));
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

async function providersPublic() {
  const keys = await fetchAllKeys();
  const stored = providerStore.isCorrupt() ? [] : providerStore.list();
  return [envProvider(), ...stored.map((r) => toPublic(r, spendFor(r, keys)))];
}

// 공급자 API 키. 같은 회사 키도 슬러그만 다르면 여러 개 등록한다.
// 응답에는 비밀 키를 넣지 않는다.
app.get("/api/provider-keys", requireAdmin, async (req, res) => {
  if (providerStore.isCorrupt()) {
    return res.status(503).json({ error: "provider-keys.json이 손상되었습니다" });
  }
  try {
    res.json({
      keys: await providersPublic(),
      providers: Object.entries(PROVIDERS).map(([id, spec]) => ({
        id,
        label: spec.label,
        needs_base: Boolean(spec.needsBase),
        optional_key: Boolean(spec.optionalKey),
        optional_budget: Boolean(spec.optionalBudget),
        base_placeholder: spec.basePlaceholder || "",
      })),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/provider-keys/preview", requireAdmin, async (req, res) => {
  try {
    const models = await listProviderModels({
      provider: req.body.provider,
      apiKey: req.body.api_key,
      apiBase: req.body.api_base,
    });
    res.json({ models });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

app.post("/api/provider-keys", requireAdmin, async (req, res) => {
  try {
    const created = await registerProvider(req.body, { litellm, store: providerStore });
    record(req, "provider.create", created.slug, {
      label: created.label, provider: created.provider, budget: created.max_budget,
      models: (created.models || []).map((m) => m.call_name),
    }, `공급자 키 등록: ${created.slug}`);
    res.json(created);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

app.post("/api/provider-keys/update", requireAdmin, async (req, res) => {
  if (!req.body.id) return res.status(400).json({ error: "id가 필요합니다" });
  try {
    const keys = await fetchAllKeys();
    const updated = await updateProvider(req.body, { litellm, store: providerStore, keys });
    record(req, "provider.update", updated.slug, {
      label: updated.label, budget: updated.max_budget, secret_changed: Boolean(req.body.api_key),
      models: (updated.models || []).map((m) => m.call_name),
    }, `공급자 키 수정: ${updated.slug}`);
    res.json(updated);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

app.post("/api/provider-keys/preview-stored", requireAdmin, async (req, res) => {
  try {
    const stored = providerStore.get(req.body.id);
    if (!stored || stored.kind === "pool") return res.status(404).json({ error: "공급자 키를 찾을 수 없습니다" });
    const started = Date.now();
    const models = await listProviderModels({
      provider: stored.provider,
      apiKey: stored.api_key,
      apiBase: stored.api_base,
    });
    res.json({ models, latency_ms: Date.now() - started });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

app.get("/api/provider-pools/activity", requireAdmin, async (req, res) => {
  try {
    const pool = providerStore.get(req.query.id);
    if (!pool || pool.kind !== "pool") return res.status(404).json({ error: "묶음을 찾을 수 없습니다" });
    // /spend/logs 는 날짜를 주면 일별 요약을 돌려준다. 개별 호출은 v2 에서 모델 그룹으로 거른다.
    const rows = [];
    for (const model of pool.models || []) {
      const data = await litellm(activityQuery({ limit: 30, hours: 24 * 7, modelGroup: model.call_name }));
      rows.push(...rowsOf(data));
    }
    res.json({ calls: matchPoolCalls(pool, rows) });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

app.post("/api/provider-pools", requireAdmin, async (req, res) => {
  try {
    const created = await registerPool(req.body, { litellm, store: providerStore });
    record(req, "pool.create", created.slug, {
      label: created.label, budget: created.max_budget,
      members: (created.members || []).map((m) => `${m.label}×${m.weight}`),
    }, `공급자 묶음 등록: ${created.slug}`);
    res.json(created);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

app.post("/api/provider-keys/delete", requireAdmin, async (req, res) => {
  if (!req.body.id) return res.status(400).json({ error: "id가 필요합니다" });
  try {
    const keys = await fetchAllKeys();
    const doomed = providerStore.get(req.body.id);
    res.json(await deleteProvider(req.body.id, { litellm, store: providerStore, keys }));
    record(req, doomed?.kind === "pool" ? "pool.delete" : "provider.delete", doomed?.slug || req.body.id,
      { label: doomed?.label }, `공급자 키 삭제: ${req.body.id}`);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// 프록시에 설정된 모델 목록 (발급 폼의 선택지)
app.get("/api/models", requireAdmin, async (req, res) => {
  try {
    const data = await litellm("/v1/models");
    res.json({ models: (data.data || []).map((m) => m.id) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 키 목록 (사용량 포함). size는 LiteLLM이 100까지만 허용하므로 페이지를 돌며 모두 모은다.
app.get("/api/keys", requireAdmin, async (req, res) => {
  try {
    // secret_stored: 키 원문이 보관돼 학생 조종석에서 볼 수 있는지
    res.json({ keys: (await fetchAllKeys()).map((k) => ({ ...k, secret_stored: keyVault.has(k.token), secret_hint: keyVault.hint(k.token) })) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 키 발급
app.post("/api/keys", requireAdmin, async (req, res) => {
  try {
    let prepared = attachProvider(req.body, providerStore);
    const team = await loadTeam(prepared.team_id || req.body.team_id);
    prepared = {
      ...prepared,
      metadata: applyIssueSchedule(prepared.metadata || {}, { team }),
    };
    const params = keyParams(prepared);
    if (params.max_budget == null || !Number.isFinite(params.max_budget) || params.max_budget < 0) {
      return res.status(400).json({ error: "예산(USD)이 필요합니다" });
    }
    const existing = new Set((await fetchAllKeys()).map((k) => k.key_alias).filter(Boolean));
    const slot = checkAlias(existing, req.body.alias);
    if (slot.error) return res.status(slot.skipped ? 409 : 400).json({ error: slot.error });
    const models = resolveIssueModels(
      prepared.models,
      await teamModelsFor(litellm, prepared.team_id)
    );
    params.models = models.length ? models : ["gpt-4o-mini"];
    const data = await litellm("/key/generate", "POST", {
      key_alias: slot.alias,
      team_id: req.body.team_id || undefined,
      ...params,
    });
    record(req, "key.issue", slot.alias, {
      team: await teamLabel(req.body.team_id), budget: params.max_budget, models: params.models,
      duration: params.duration || null,
    }, `키 발급: ${slot.alias}`);
    res.json(data);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// 키 상세 (현재 값 + 충전·연장 이력). LiteLLM /key/info, 없으면 /key/list.
app.get("/api/keys/info", requireAdmin, async (req, res) => {
  try {
    res.json(await keyDetail(req.query.token, { litellm }));
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// 개별 충전·기간 연장. 예산은 가산, 만료는 기존일 +N 또는 달력일.
// 이력(누가·언제·얼마/만료)은 LiteLLM metadata.aiapi_history.
app.post("/api/keys/adjust", requireAdmin, async (req, res) => {
  try {
    const out = await adjustKey(req.body, { litellm, actor: req.adminEmail });
    const bits = [];
    if (out.add_budget != null) bits.push(`+$${out.add_budget}`);
    if (out.add_days != null) bits.push(`+${out.add_days}일`);
    if (out.entry?.expires && out.add_days == null) bits.push(`만료 ${out.entry.expires}`);
    record(req, "key.adjust", out.alias || out.token.slice(0, 12), {
      add_budget: out.add_budget, add_days: out.add_days, max_budget: out.max_budget, expires: out.expires,
    }, `키 충전·연장: ${out.alias || out.token.slice(0, 12)} ${bits.join(" ")}`);
    res.json(out);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// 키 수정 (예산·기한·모델·속도 제한 변경)
app.post("/api/keys/update", requireAdmin, async (req, res) => {
  if (!req.body.token) return res.status(400).json({ error: "token이 필요합니다" });
  try {
    if (Array.isArray(req.body.models) && req.body.models.filter(Boolean).length === 0) {
      return res.status(400).json({ error: "모델을 하나 이상 선택하세요" });
    }
    let source = req.body;
    if (req.body.provider_key_id || req.body.schedule !== undefined) {
      const current = await findKey(litellm, req.body.token);
      source = attachProvider({
        ...req.body,
        metadata: (current && current.metadata) || {},
      }, providerStore);
      const teamId = req.body.team_id !== undefined ? req.body.team_id : (current && current.team_id);
      const team = await loadTeam(teamId);
      source.metadata = keepCampSchedule(applyIssueSchedule(source.metadata || {}, { team }), current);
    }
    const payload = { key: req.body.token, ...keyParams(source, { clearEmpty: true }) };
    if (req.body.team_id !== undefined) payload.team_id = req.body.team_id || null;
    const data = await litellm("/key/update", "POST", payload);
    record(req, "key.update", req.body.alias || req.body.token.slice(0, 12), {
      budget: req.body.budget, team_id: req.body.team_id, models: req.body.models,
      rpm_limit: req.body.rpm_limit, tpm_limit: req.body.tpm_limit, duration: req.body.duration || null,
    }, `키 수정: ${req.body.token.slice(0, 12)}...`);
    res.json(data);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// 유출된 키를 막고 같은 별칭·남은 예산으로 새 키를 만든다
app.post("/api/keys/reissue", requireAdmin, async (req, res) => {
  if (!req.body.token) return res.status(400).json({ error: "token이 필요합니다" });
  try {
    const out = await reissueKey(req.body.token, { litellm });
    // 막은 옛 키 원문은 더 둘 까닭이 없다. 새 키는 발급하면서 보관됐다.
    try { keyVault.remove([req.body.token]); } catch (e) { console.error("옛 키 보관 삭제 실패:", e.message); }
    record(req, "key.reissue", out.key_alias, { retired_alias: out.retired_alias, budget: out.max_budget },
      `키 폐기 후 재발급: ${out.key_alias} (이전 ${out.retired_alias})`);
    res.json(out);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// 키 차단/해제 (삭제하지 않고 일시 정지)
app.post("/api/keys/block", requireAdmin, async (req, res) => {
  if (!req.body.token) return res.status(400).json({ error: "token이 필요합니다" });
  try {
    const path = req.body.blocked ? "/key/block" : "/key/unblock";
    const data = await litellm(path, "POST", { key: req.body.token });
    record(req, req.body.blocked ? "key.block" : "key.unblock", req.body.alias || req.body.token.slice(0, 12), null,
      `키 ${req.body.blocked ? "차단" : "차단 해제"}`);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 키 삭제
app.post("/api/keys/delete", requireAdmin, async (req, res) => {
  const { keys } = req.body;
  if (!keys?.length) return res.status(400).json({ error: "keys가 필요합니다" });
  try {
    const all = await fetchAllKeys();
    const doomed = new Set(keys);
    const removedAliases = new Set(
      all.filter((k) => doomed.has(k.token) && k.key_alias).map((k) => k.key_alias)
    );
    for (const k of all) {
      if (!doomed.has(k.token) && k.key_alias) removedAliases.delete(k.key_alias);
    }
    const data = await litellm("/key/delete", "POST", { keys });
    try { keyVault.remove(keys); } catch (e) { console.error("키 보관 삭제 실패:", e.message); }
    if (removedAliases.size && !usersStore.isCorrupt()) {
      for (const u of usersStore.list()) {
        const next = (u.key_aliases || []).filter((a) => !removedAliases.has(a));
        if (next.length !== (u.key_aliases || []).length) {
          usersStore.update(u.email, { key_aliases: next });
        }
      }
    }
    record(req, "key.delete", [...removedAliases].join(", ") || `${keys.length}개`, {
      count: keys.length, aliases: [...removedAliases].slice(0, 50),
    }, `키 삭제: ${keys.length}개`);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 학기·캠프 종료 후 일괄 차단/회수. 개별 block·delete 와 같은 LiteLLM 경로.
app.post("/api/keys/revoke", requireAdmin, async (req, res) => {
  try {
    const out = await revokeKeys(req.body, { litellm });
    const n = out.results.length;
    const fail = out.results.filter((r) => r.error).length;
    const verb = out.action === "delete" ? "회수" : out.action === "unblock" ? "해제" : "차단";
    record(req, `keys.${out.action}`, (await teamLabel(out.team_id)) || out.filter || `${n}개`, {
      count: n, failed: fail, filter: out.filter, aliases: out.results.map((r) => r.alias).filter(Boolean).slice(0, 50),
    }, `일괄 ${verb}: ${n}개 (실패 ${fail})`);
    res.json(out);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// 선택한 키 또는 학급 전체를 한 번에 충전·연장한다. 이력은 키마다 남는다.
app.post("/api/keys/adjust/bulk", requireAdmin, async (req, res) => {
  try {
    const out = await adjustKeys(req.body, { litellm, actor: req.adminEmail });
    const n = out.results.length;
    const fail = out.results.filter((r) => r.error).length;
    const bits = [];
    if (out.add_budget != null) bits.push(`+$${out.add_budget}`);
    if (out.add_days != null) bits.push(`+${out.add_days}일`);
    if (out.expires) bits.push(`만료 ${out.expires}`);
    record(req, "keys.adjust", (await teamLabel(out.team_id)) || `${n}개`, {
      count: n, failed: fail, add_budget: out.add_budget, add_days: out.add_days, expires: out.expires,
      aliases: out.results.map((r) => r.alias).filter(Boolean).slice(0, 50),
    }, `일괄 충전·연장: ${n}개 ${bits.join(" ")} (실패 ${fail})`);
    res.json(out);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// 학급 봉쇄/해제. 해제는 봉쇄로 막은 키만 다시 연다.
app.post("/api/teams/lockdown", requireAdmin, async (req, res) => {
  const action = String(req.body.action || "lock");
  if (action !== "lock" && action !== "unlock") {
    return res.status(400).json({ error: "action은 lock 또는 unlock 이어야 합니다" });
  }
  try {
    const out = action === "lock"
      ? await lockdownTeam(req.body, { litellm, actor: req.adminEmail })
      : await liftLockdown(req.body, { litellm });
    const n = out.results.filter((r) => !r.skipped && !r.error).length;
    const fail = out.results.filter((r) => r.error).length;
    record(req, action === "lock" ? "team.lock" : "team.unlock", out.team_alias || out.team_id, {
      team_id: out.team_id, keys: n, failed: fail, reason: req.body.reason || null,
    }, `학급 ${action === "lock" ? "봉쇄" : "봉쇄 해제"}: ${out.team_alias || out.team_id} (${n}개, 실패 ${fail})`);
    res.json(out);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// 최근 호출. 키 상세에서는 한 키의 호출만 본다. LiteLLM 은 해시 토큰으로 거른다.
async function activityItems({ limit = 60, hours = 24, status = "", token = "" } = {}) {
  let query = activityQuery({ limit, hours, status });
  if (token) query += `&api_key=${encodeURIComponent(String(token))}`;
  const data = await litellm(query);
  const teams = await listTeams().catch(() => []);
  const teamsById = new Map(teams.map((t) => [t.team_id, t]));
  return rowsOf(data).map((row) => toActivity(row, { teamsById }));
}

// 최근 호출. 프롬프트와 응답은 주지 않는다.
app.get("/api/activity", requireAdmin, async (req, res) => {
  try {
    const items = await activityItems({
      limit: req.query.limit,
      hours: req.query.hours,
      status: String(req.query.status || ""),
      token: req.query.token ? String(req.query.token) : "",
    });
    res.json({ items, summary: summarizeActivity(items), at: new Date().toISOString() });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

app.get("/api/audit", requireAdmin, (req, res) => {
  res.json({
    entries: auditLog.list({
      limit: req.query.limit,
      action: String(req.query.action || ""),
      actor: String(req.query.actor || ""),
      q: String(req.query.q || ""),
    }),
    total: auditLog.size(),
  });
});

// 관제 화면 상단의 시스템 표시등. LiteLLM·DB·저장소 상태를 한 번에 본다.
app.get("/api/status", requireAdmin, async (_req, res) => {
  const t0 = Date.now();
  const litellmState = { live: false, db: null, latency_ms: null, error: null };
  try {
    const ready = await litellm("/health/readiness");
    litellmState.live = true;
    litellmState.db = ready && ready.db ? String(ready.db) : null;
    litellmState.version = ready && (ready.litellm_version || ready.version) ? String(ready.litellm_version || ready.version) : null;
  } catch (e) {
    litellmState.error = e.message;
  }
  litellmState.latency_ms = Date.now() - t0;
  res.json({
    version: APP_VERSION,
    now: new Date().toISOString(),
    uptime_s: Math.round((Date.now() - STARTED_AT) / 1000),
    litellm: litellmState,
    stores: {
      users: { ok: !usersStore.isCorrupt(), count: usersStore.isCorrupt() ? null : usersStore.list().length },
      providers: { ok: !providerStore.isCorrupt(), count: providerStore.isCorrupt() ? null : providerStore.list().length },
      audit: { count: auditLog.size() },
      assistant: { ok: !assistantStore.isCorrupt() },
      key_vault: { ok: !keyVault.isCorrupt(), count: keyVault.isCorrupt() ? null : keyVault.size() },
    },
    assistant: (() => {
      const a = assistantStore.publicView();
      return { enabled: a.enabled, ready: a.ready, model: a.mode === "proxy" ? a.proxy_model : a.model, mode: a.mode, provider: a.provider };
    })(),
    proxy_url: PUBLIC_PROXY_URL || null,
    proxy_port: Number(LITELLM_PORT) || 4000,
    auto_update: readAutoUpdate(),
  });
});

function readAutoUpdate() {
  try {
    const s = JSON.parse(fs.readFileSync(AUTO_UPDATE_STATUS_PATH, "utf8"));
    return s && typeof s === "object" ? s : null;
  } catch {
    return null;
  }
}

app.get("/api/me", requireRegistered, (req, res) => {
  res.json({
    email: req.user.email,
    name: req.user.name,
    role: req.user.role,
    key_aliases: req.user.key_aliases || [],
    proxy_url: PUBLIC_PROXY_URL || null,
    proxy_port: Number(LITELLM_PORT) || 4000,
    version: APP_VERSION,
  });
});

app.get("/api/my/keys", requireRegistered, async (req, res) => {
  if (req.user.role === "admin") return res.status(403).json({ error: "관리자는 /api/keys를 사용하세요" });
  try {
    const [allKeys, teams] = await Promise.all([fetchAllKeys(), listTeams()]);
    const names = new Map(teams.map((t) => [t.team_id, t.team_alias || t.team_id.slice(0, 8)]));
    const mine = allKeys.filter((k) => (req.user.key_aliases || []).includes(k.key_alias));
    // 키 원문은 싣지 않는다. 보관돼 있는지와 끝 네 글자만 준다. 원문은 /api/my/keys/reveal 로 누를 때만.
    res.json({
      keys: mine.map((k) => ({
        ...toPublicKey(k, names),
        secret_available: keyVault.has(k.token),
        key_hint: keyVault.hint(k.token) || (typeof k.key_name === "string" ? k.key_name.slice(-4) : null),
      })),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 등록 사용자가 자기 키 원문을 본다(가려진 키에 마우스를 올리거나 복사를 누를 때). 작업 기록에 남긴다.
app.post("/api/my/keys/reveal", requireRegistered, async (req, res) => {
  if (req.user.role === "admin") return res.status(403).json({ error: "관리자는 키 상세에서 보세요" });
  const alias = String((req.body && req.body.alias) || "");
  if (!alias || !(req.user.key_aliases || []).includes(alias)) return res.status(404).json({ error: "내 계정에 연결된 키가 아닙니다" });
  if (!revealLimiter.take(`reveal:${req.user.email}`, 120)) return res.status(429).json({ error: "잠시 뒤에 다시 시도하세요" });
  if (keyVault.isCorrupt()) return res.status(503).json({ error: "키 보관함 파일이 손상되었습니다. 선생님께 알려 주세요." });
  try {
    const key = (await fetchAllKeys()).find((k) => k.key_alias === alias);
    if (!key) return res.status(404).json({ error: "키를 찾을 수 없습니다" });
    const secret = keyVault.get(key.token);
    if (!secret) {
      return res.status(404).json({ error: "이 키는 발급할 때 보관되지 않아 여기서 볼 수 없어요. 선생님께 '새 키로 교체'를 부탁하세요.", code: "not_stored" });
    }
    const purpose = req.body.purpose === "copy" ? "copy" : "view";
    record(req, "key.reveal", alias, { purpose, by: "student" }, `학생 키 ${purpose === "copy" ? "복사" : "확인"}: ${alias}`);
    res.set("Cache-Control", "no-store");
    res.json({ key: secret });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// 관리자가 보관된 키 원문을 본다(학생을 도울 때). 작업 기록에 남긴다.
app.post("/api/keys/reveal", requireAdmin, async (req, res) => {
  const token = String((req.body && req.body.token) || "");
  if (!token) return res.status(400).json({ error: "token이 필요합니다" });
  if (keyVault.isCorrupt()) return res.status(503).json({ error: "key-vault.json 이 손상되었습니다" });
  const secret = keyVault.get(token);
  if (!secret) return res.status(404).json({ error: "보관된 키가 아닙니다. '새 키로 교체'하면 보관되어 학생 화면에도 보입니다.", code: "not_stored" });
  const alias = String((req.body && req.body.alias) || "") || token.slice(0, 12);
  record(req, "key.reveal", alias, { purpose: req.body.purpose === "copy" ? "copy" : "view", by: "admin" }, `관리자 키 확인: ${alias}`);
  res.set("Cache-Control", "no-store");
  res.json({ key: secret });
});

app.get("/api/my/analytics", requireRegistered, async (req, res) => {
  if (req.user.role === "admin") return res.status(403).json({ error: "관리자는 /api/analytics를 사용하세요" });
  const days = Math.min(180, Math.max(7, Number(req.query.days) || 30));
  const horizon = Math.min(90, Math.max(1, Number(req.query.horizon) || 14));
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * DAY_MS);
  try {
    const results = [];
    for (let page = 1; page <= 100; page++) {
      const d = await litellm(
        `/user/daily/activity?start_date=${ymd(start)}&end_date=${ymd(end)}&page=${page}&page_size=100`
      );
      results.push(...(d.results || []));
      const total = d.metadata?.total_pages || d.total_pages || 1;
      if (page >= total) break;
    }
    const [keyList, teams] = await Promise.all([fetchAllKeys(), listTeams()]);
    const mine = keyList.filter((k) => (req.user.key_aliases || []).includes(k.key_alias));
    const tokenFilter = new Set(mine.length ? mine.map((k) => k.token) : ["__none__"]);
    res.json({
      ...buildAnalytics({
        results, keyList, teams, start, end, horizon, tokenFilter, strictModels: true,
      }),
      assignedCount: mine.length,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 등록 사용자가 자기 키의 최근 호출과 실패 이유를 본다.
app.get("/api/my/activity", requireRegistered, async (req, res) => {
  if (req.user.role === "admin") return res.status(403).json({ error: "관리자는 /api/activity를 사용하세요" });
  try {
    const mine = (await fetchAllKeys()).filter((k) => (req.user.key_aliases || []).includes(k.key_alias));
    const items = [];
    for (const key of mine.slice(0, 10)) {
      const q = activityQuery({ limit: 20, hours: 24 * 7 }) + `&api_key=${encodeURIComponent(key.token)}`;
      items.push(...rowsOf(await litellm(q)).map((row) => toActivity(row)));
    }
    items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    // 학생 화면에는 IP·해시를 싣지 않는다.
    const clean = items.slice(0, 30).map(({ token, ip, ...rest }) => rest);
    res.json({ items: clean, summary: summarizeActivity(clean) });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

app.get("/api/users", requireAdmin, (req, res) => {
  if (!guardStore(res)) return;
  res.json({ users: usersStore.list() });
});

app.post("/api/users", requireAdmin, (req, res) => {
  if (!guardStore(res)) return;
  if (!req.body.email) return res.status(400).json({ error: "이메일이 필요합니다" });
  try {
    const user = usersStore.add({
      email: req.body.email,
      name: req.body.name,
      key_aliases: req.body.key_aliases,
    }, req.adminEmail);
    record(req, "user.create", user.email, { name: user.name, key_aliases: user.key_aliases },
      `사용자 등록: ${user.email}`);
    res.json(user);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/users/update", requireAdmin, (req, res) => {
  if (!guardStore(res)) return;
  if (!req.body.email) return res.status(400).json({ error: "이메일이 필요합니다" });
  try {
    const user = usersStore.update(req.body.email, {
      name: req.body.name,
      key_aliases: req.body.key_aliases,
    });
    record(req, "user.update", user.email, { name: user.name, key_aliases: user.key_aliases },
      `사용자 수정: ${user.email}`);
    res.json(user);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/users/delete", requireAdmin, (req, res) => {
  if (!guardStore(res)) return;
  if (!req.body.email) return res.status(400).json({ error: "이메일이 필요합니다" });
  try {
    usersStore.remove(req.body.email);
    record(req, "user.delete", String(req.body.email).toLowerCase(), null, `사용자 삭제: ${req.body.email}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

mountAssistant(app, {
  store: assistantStore,
  requireAdmin,
  requireRegistered,
  record,
  litellm,
  fetchAllKeys,
  listTeams,
  providersPublic,
  activityItems,
  analytics: analyticsFor,
  auditLog,
  usersStore,
  proxyBase: LITELLM_BASE_URL,
  masterKey: LITELLM_MASTER_KEY,
  publicProxyUrl: (req) => PUBLIC_PROXY_URL || `${req.protocol}://${req.hostname}:${Number(LITELLM_PORT) || 4000}`,
});

app.listen(PORT, () => console.log(`admin-ui listening on :${PORT}`));
