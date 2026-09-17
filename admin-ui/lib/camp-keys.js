// 캠프용 짧은 랜덤 키 N개.
// 명단 없이 인원만 받아, 칠판·타이핑용 짧은 코드와 LiteLLM 가상 키를 만든다.
// 캠프 발급은 저가 모델 필수·당일 종료 강제. 스케줄/수동 회수는 revokeCampKeys.

const crypto = require("crypto");
const { durationFromExpiryDate } = require("./roster");
const { keyGenerateParams, resolveTeam } = require("./class-assign");
const { normalizeModels, resolveIssueModels, teamModelsFor } = require("./model-allowlist");
const { revokeKeys } = require("./key-revoke");

const MAX_CAMP = 200;
const DEFAULT_PREFIX = "CAMP";
const DEFAULT_BUDGET = 1;
const CODE_BODY_LEN = 4;
// 0/O, 1/I/L 제외 — 칠판·타이핑에서 헷갈리지 않게.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
// 이 프록시에 있는 저가 모델. 이름에 mini/nano/flash/haiku 가 있어도 허용.
const CAMP_LOW_COST_MODELS = ["gpt-4o-mini"];
const LOW_COST_RE = /(mini|nano|flash|haiku|small)/i;

function todayYmd(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function normalizePrefix(raw) {
  const s = String(raw == null || raw === "" ? DEFAULT_PREFIX : raw)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  return s || DEFAULT_PREFIX;
}

function randomBody(len = CODE_BODY_LEN, randomInt) {
  const pick = typeof randomInt === "function"
    ? randomInt
    : (n) => crypto.randomInt(n);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[pick(ALPHABET.length) % ALPHABET.length];
  return out;
}

function formatCode(prefix, body) {
  return `${normalizePrefix(prefix)}-${String(body || "").toUpperCase()}`;
}

function litellmKeyFor(code) {
  return `sk-${code}`;
}

function isCampCode(value) {
  return /^[A-Z0-9]{1,8}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/.test(String(value || "").toUpperCase());
}

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isLowCostModel(name) {
  const m = String(name == null ? "" : name).trim();
  if (!m) return false;
  if (CAMP_LOW_COST_MODELS.includes(m)) return true;
  return LOW_COST_RE.test(m);
}

function campScheduleRevoke() {
  return {
    at: "end_of_day",
    filter: "camp_due",
    action: "block",
    endpoint: "/api/keys/revoke",
    camp_endpoint: "/api/keys/camp/revoke",
  };
}

/**
 * 캠프 발급 정책. 저가 모델 필수, 당일 종료 강제, 자정 회수 훅.
 */
function campIssuePolicy(_body = {}) {
  return {
    require_models: true,
    force_same_day_expiry: true,
    low_cost_models_only: true,
    low_cost_models: CAMP_LOW_COST_MODELS.slice(),
    schedule_revoke: campScheduleRevoke(),
  };
}

function defaultCampExpires(body, now = new Date()) {
  const policy = campIssuePolicy(body);
  return campExpires(body, now, policy);
}

function campExpires(body, now = new Date(), policy = campIssuePolicy(body)) {
  const today = todayYmd(now);
  const raw = body && body.expires != null ? String(body.expires).trim() : "";
  if (policy.force_same_day_expiry) {
    if (raw && raw !== today) {
      throw httpError("캠프 키는 당일 종료만 가능합니다 (오늘 23:59)", 400);
    }
    return today;
  }
  return raw || today;
}

function resolveCampModels(requested, teamModels, policy = campIssuePolicy()) {
  const want = normalizeModels(requested);
  if (policy.require_models && !want.length) {
    throw httpError("캠프 키는 허용 모델을 반드시 고르세요", 400);
  }
  const expensive = want.filter((m) => !isLowCostModel(m));
  if (expensive.length) {
    throw httpError(
      `캠프 키는 저가 모델만 허용합니다 (불가: ${expensive.join(", ")}, 허용 예: ${CAMP_LOW_COST_MODELS.join(", ")})`,
      400
    );
  }
  const resolved = resolveIssueModels(want, teamModels);
  const cheap = resolved.filter(isLowCostModel);
  if (policy.require_models && !cheap.length) {
    throw httpError(
      resolved.length
        ? "캠프 키는 저가 모델만 허용합니다. 학급 허용 목록에 저가 모델이 없습니다"
        : "캠프 키는 허용 모델을 반드시 고르세요",
      400
    );
  }
  return cheap;
}

function campMetadata({ code, prefix, expires, policy, models }) {
  return {
    aiapi_camp: {
      kind: "camp",
      code,
      prefix,
      expires_ymd: expires,
      models: models || [],
      schedule_revoke: (policy && policy.schedule_revoke) || campScheduleRevoke(),
    },
  };
}

function generateCampCodes(count, opts = {}) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) {
    const err = new Error("인원 N은 1 이상의 정수여야 합니다");
    err.status = 400;
    throw err;
  }
  if (n > MAX_CAMP) {
    const err = new Error(`한 번에 ${MAX_CAMP}개까지 만들 수 있습니다`);
    err.status = 400;
    throw err;
  }
  const prefix = normalizePrefix(opts.prefix);
  const taken = new Set(
    (opts.existing || []).map((c) => String(c || "").trim().toUpperCase()).filter(Boolean)
  );
  const codes = [];
  let guard = 0;
  while (codes.length < n) {
    if (++guard > n * 80 + 200) {
      const err = new Error("짧은 코드를 더 만들 수 없습니다. prefix를 바꾸거나 인원을 줄이세요");
      err.status = 400;
      throw err;
    }
    const code = formatCode(prefix, randomBody(CODE_BODY_LEN, opts.randomInt));
    if (taken.has(code)) continue;
    taken.add(code);
    codes.push(code);
  }
  return codes;
}

function printList(results, extras = {}) {
  const ok = (results || []).filter((r) => r && r.code && !r.error);
  const expires = extras.expires || "";
  const lines = ok.map((r, i) => `${i + 1}. ${r.code}`);
  const csv = ["no,code,api_key,alias,expires"]
    .concat(ok.map((r, i) => [
      i + 1,
      r.code,
      r.key || "",
      r.alias || r.code,
      extras.expires || r.expires_ymd || "",
    ].join(",")))
    .join("\n");
  return {
    lines,
    csv,
    text: ok.map((r) => r.code).join("\n"),
    count: ok.length,
    expires,
  };
}

function isCustomKeyRejected(err) {
  const msg = String(err && err.message ? err.message : err || "").toLowerCase();
  return /custom|minimum|length|must start|invalid key|disable_custom|sk-/.test(msg);
}

function existingCodesFromKeys(keys) {
  const out = [];
  for (const k of keys || []) {
    if (k.key_alias) out.push(k.key_alias);
    const code = k.metadata && k.metadata.aiapi_camp && k.metadata.aiapi_camp.code;
    if (code) out.push(code);
  }
  return out;
}

async function listExistingKeys(litellm) {
  if (!litellm) return [];
  const keys = [];
  for (let page = 1; ; page++) {
    const data = await litellm(`/key/list?return_full_object=true&size=100&page=${page}`);
    keys.push(...(data.keys || []));
    if (page >= (data.total_pages || 1)) break;
  }
  return keys;
}

async function generateCampVirtualKey(litellm, { code, teamId, params, metadata }) {
  const base = {
    key_alias: code,
    team_id: teamId || undefined,
    metadata,
    ...params,
  };
  try {
    const data = await litellm("/key/generate", "POST", {
      ...base,
      key: litellmKeyFor(code),
    });
    return { data, mapped: data.key !== litellmKeyFor(code) };
  } catch (e) {
    if (!isCustomKeyRejected(e)) throw e;
    const data = await litellm("/key/generate", "POST", base);
    return { data, mapped: true };
  }
}

/**
 * 명단 없이 N개의 짧은 캠프 코드를 만들고 LiteLLM 가상 키에 붙인다.
 * 저가 모델 필수. 만료는 오늘(로컬 달력) 23:59:59 강제.
 */
async function issueCampKeys(body, { litellm, now } = {}) {
  const when = now || new Date();
  const n = Number(body && body.count);
  if (!Number.isInteger(n) || n < 1) {
    const err = new Error("인원 N은 1 이상의 정수여야 합니다");
    err.status = 400;
    throw err;
  }
  if (n > MAX_CAMP) {
    const err = new Error(`한 번에 ${MAX_CAMP}개까지 만들 수 있습니다`);
    err.status = 400;
    throw err;
  }

  const policy = campIssuePolicy(body);
  let expires;
  try {
    expires = campExpires(body, when, policy);
  } catch (e) {
    if (!e.status) e.status = 400;
    throw e;
  }
  const prefix = normalizePrefix(body && body.prefix);

  let params;
  try {
    params = keyGenerateParams({
      ...body,
      expires,
      budget: body.budget === undefined || body.budget === "" ? DEFAULT_BUDGET : body.budget,
    });
  } catch (e) {
    if (!e.status) e.status = 400;
    throw e;
  }
  try {
    // keyGenerateParams 는 프로세스 시각을 쓰므로, 캠프는 주입된 now 로 다시 계산한다.
    params.duration = durationFromExpiryDate(expires, when);
  } catch (e) {
    if (!e.status) e.status = 400;
    throw e;
  }

  let teamId = (body && body.team_id) || "";
  let teamCreated = false;
  let teamAlias = null;
  let teamModels = [];
  const teamName = String((body && body.team) || "").trim();
  if (!teamId && teamName) {
    const resolved = await resolveTeam(litellm, teamName, body.team_budget, {
      models: body.models,
    });
    teamId = resolved.team_id;
    teamCreated = resolved.created;
    teamAlias = resolved.team_alias;
    teamModels = resolved.models || [];
  } else if (teamId) {
    teamModels = await teamModelsFor(litellm, teamId);
  }

  try {
    const models = resolveCampModels((params.models || (body && body.models)), teamModels, policy);
    if (models.length) params.models = models;
    else delete params.models;
  } catch (e) {
    if (!e.status) e.status = 400;
    throw e;
  }

  const existingKeys = await listExistingKeys(litellm);
  const codes = generateCampCodes(n, {
    prefix,
    existing: existingCodesFromKeys(existingKeys),
    randomInt: body && body.randomInt,
  });

  const results = [];
  for (const code of codes) {
    const metadata = campMetadata({
      code, prefix, expires, policy, models: params.models || [],
    });
    try {
      const { data, mapped } = await generateCampVirtualKey(litellm, {
        code, teamId, params, metadata,
      });
      results.push({
        code,
        alias: code,
        key: data.key,
        litellm_key: data.key,
        mapped: !!mapped,
        max_budget: data.max_budget ?? params.max_budget ?? null,
        duration: params.duration || null,
        expires: data.expires || null,
        expires_ymd: expires,
      });
    } catch (e) {
      results.push({
        code,
        alias: code,
        expires_ymd: expires,
        error: e.message,
      });
    }
  }

  return {
    results,
    count: n,
    prefix,
    expires,
    duration: params.duration || null,
    max_budget: params.max_budget ?? null,
    models: params.models || [],
    team_id: teamId || null,
    team_created: teamCreated,
    team_alias: teamAlias,
    policy,
    print: printList(results, { expires, prefix }),
  };
}

function campWhenToFilter(when) {
  const w = String(when || "due").trim();
  if (w === "today" || w === "camp_today") return "camp_today";
  if (w === "all" || w === "camp") return "camp";
  return "camp_due";
}

/**
 * 캠프 키 수동/스케줄 회수.
 * when=due (기본, 자정 지난 캠프) · today (오늘 발급한 캠프) · all.
 * 기존 POST /api/keys/revoke 의 filter=camp_* 와 같다.
 */
async function revokeCampKeys(body = {}, { litellm, now } = {}) {
  return revokeKeys({
    action: body.action || "block",
    filter: body.filter || campWhenToFilter(body.when),
    team_id: body.team_id,
    tokens: body.tokens,
  }, { litellm, now });
}

const CampKeys = {
  MAX_CAMP,
  DEFAULT_PREFIX,
  DEFAULT_BUDGET,
  CODE_BODY_LEN,
  ALPHABET,
  CAMP_LOW_COST_MODELS,
  todayYmd,
  normalizePrefix,
  formatCode,
  litellmKeyFor,
  isCampCode,
  isLowCostModel,
  campIssuePolicy,
  campScheduleRevoke,
  defaultCampExpires,
  campExpires,
  resolveCampModels,
  campMetadata,
  generateCampCodes,
  printList,
  isCustomKeyRejected,
  existingCodesFromKeys,
  issueCampKeys,
  campWhenToFilter,
  revokeCampKeys,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = CampKeys;
}
if (typeof window !== "undefined") {
  window.CampKeys = CampKeys;
}
