// 캠프용 짧은 랜덤 키 N개.
// 명단 없이 인원만 받아, 칠판·타이핑용 짧은 코드와 LiteLLM 가상 키를 만든다.
// #20 모델 제한 필수·당일 스케줄 회수는 campIssuePolicy 훅만 연다.

const crypto = require("crypto");
const { durationFromExpiryDate } = require("./roster");
const { keyGenerateParams, resolveTeam } = require("./class-assign");
const { resolveIssueModels, teamModelsFor } = require("./model-allowlist");

const MAX_CAMP = 200;
const DEFAULT_PREFIX = "CAMP";
const DEFAULT_BUDGET = 1;
const CODE_BODY_LEN = 4;
// 0/O, 1/I/L 제외 — 칠판·타이핑에서 헷갈리지 않게.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

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

/**
 * #20에서 채울 캠프 발급 정책.
 * require_models / schedule_revoke 는 이 이슈에서 켜지 않는다.
 */
function campIssuePolicy(_body = {}) {
  return {
    require_models: false,
    force_same_day_expiry: true,
    schedule_revoke: null,
  };
}

function defaultCampExpires(body, now = new Date()) {
  const raw = body && body.expires != null ? String(body.expires).trim() : "";
  return raw || todayYmd(now);
}

function campMetadata({ code, prefix, expires, policy }) {
  return {
    aiapi_camp: {
      kind: "camp",
      code,
      prefix,
      expires_ymd: expires,
      // #20: 당일 자동 회수 스케줄이 이 필드를 본다.
      schedule_revoke: (policy && policy.schedule_revoke) || null,
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
 * expires 가 없으면 오늘(로컬 달력) 23:59:59.
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
  const expires = defaultCampExpires(body, when);
  const prefix = normalizePrefix(body && body.prefix);

  if (policy.require_models) {
    const models = Array.isArray(body.models) ? body.models.filter(Boolean) : [];
    if (!models.length) {
      const err = new Error("캠프 키는 허용 모델을 반드시 고르세요");
      err.status = 400;
      throw err;
    }
  }

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
    const models = resolveIssueModels((params.models || (body && body.models)), teamModels);
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
    const metadata = campMetadata({ code, prefix, expires, policy });
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

const CampKeys = {
  MAX_CAMP,
  DEFAULT_PREFIX,
  DEFAULT_BUDGET,
  CODE_BODY_LEN,
  ALPHABET,
  todayYmd,
  normalizePrefix,
  formatCode,
  litellmKeyFor,
  isCampCode,
  campIssuePolicy,
  defaultCampExpires,
  campMetadata,
  generateCampCodes,
  printList,
  isCustomKeyRejected,
  existingCodesFromKeys,
  issueCampKeys,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = CampKeys;
}
if (typeof window !== "undefined") {
  window.CampKeys = CampKeys;
}
