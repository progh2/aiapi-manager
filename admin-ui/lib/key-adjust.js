// 개별 키 예산 충전(top-up)·기간 연장.
// 기존 POST /api/keys/update 와 같은 LiteLLM /key/update 를 쓴다.
// 예산은 절대값이 아니라 가산하고, 만료는 지금부터가 아니라 기존 만료일 +N 이다.
// 이력은 LiteLLM 키 metadata.aiapi_history 에 남긴다 (Postgres에 같이 저장됨).

const { durationFromExpiryDate } = require("./roster");

const HISTORY_KEY = "aiapi_history";
const DAY_MS = 86400000;
const MAX_ADD_BUDGET = 10000;
const MAX_ADD_DAYS = 1095;

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function keyToken(key) {
  return (key && (key.token || key.key)) || "";
}

function historyFromMetadata(metadata) {
  const raw = metadata && metadata[HISTORY_KEY];
  return Array.isArray(raw) ? raw.slice() : [];
}

function unwrapKeyInfo(data) {
  if (!data || typeof data !== "object") return null;
  const info = data.info && typeof data.info === "object" ? data.info : data;
  const token = info.token || info.key || data.key || "";
  if (!token && info.key_alias == null && info.max_budget == null && info.expires == null) {
    return null;
  }
  return { ...info, token: token || info.token || "" };
}

async function listAllKeys(litellm) {
  const keys = [];
  for (let page = 1; ; page++) {
    const data = await litellm(`/key/list?return_full_object=true&size=100&page=${page}`);
    keys.push(...(data.keys || []));
    if (page >= (data.total_pages || 1)) break;
  }
  return keys;
}

async function findKey(litellm, token) {
  try {
    const data = await litellm(`/key/info?key=${encodeURIComponent(token)}`);
    const key = unwrapKeyInfo(data);
    if (key && (keyToken(key) === token || data.key === token || key.token)) {
      if (!key.token) key.token = token;
      return key;
    }
  } catch (_) {
    // /key/info 가 없는 구성이면 목록으로 찾는다
  }
  const keys = await listAllKeys(litellm);
  return keys.find((k) => keyToken(k) === token) || null;
}

function parseAddBudget(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw httpError("충전 금액은 0보다 커야 합니다", 400);
  }
  if (n > MAX_ADD_BUDGET) {
    throw httpError(`한 번에 $${MAX_ADD_BUDGET}까지 충전할 수 있습니다`, 400);
  }
  return n;
}

function parseAddDays(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw httpError("연장 일수는 1 이상의 정수여야 합니다", 400);
  }
  if (n > MAX_ADD_DAYS) {
    throw httpError(`연장 일수는 ${MAX_ADD_DAYS}일까지입니다`, 400);
  }
  return n;
}

/**
 * 기존 만료일이 미래면 그 시각에 일수를 더하고, 없거나 지났으면 지금부터 더한다.
 */
function nextExpiryFromAddDays(currentExpires, addDays, now = new Date()) {
  const days = parseAddDays(addDays);
  if (days == null) return null;
  const cur = currentExpires != null && currentExpires !== ""
    ? new Date(currentExpires)
    : null;
  const curOk = cur && !Number.isNaN(cur.getTime());
  const base = curOk && cur.getTime() > now.getTime() ? cur : now;
  return new Date(base.getTime() + days * DAY_MS);
}

function durationUntil(date, now = new Date()) {
  const ms = date.getTime() - now.getTime();
  if (ms <= 0) {
    throw httpError("연장 후 만료가 과거입니다", 400);
  }
  return `${Math.max(1, Math.floor(ms / 1000))}s`;
}

function remainingBudget(maxBudget, spend) {
  if (maxBudget == null) return null;
  const budget = Number(maxBudget);
  if (!Number.isFinite(budget)) return null;
  return budget - (Number(spend) || 0);
}

function buildUpdateAndEntry(key, body, now, actor) {
  const addBudget = parseAddBudget(body.add_budget);
  const addDays = parseAddDays(body.add_days);
  const expires = body.expires != null ? String(body.expires).trim() : "";

  if (addBudget == null && addDays == null && !expires) {
    throw httpError("충전 금액 또는 연장(만료일·일수)이 필요합니다", 400);
  }
  if (addDays != null && expires) {
    throw httpError("만료일과 연장 일수를 함께 지정할 수 없습니다", 400);
  }

  const update = { key: keyToken(key) };
  const entry = { at: now.toISOString(), by: actor || null };

  if (addBudget != null) {
    if (key.max_budget == null) {
      throw httpError("예산이 무제한인 키는 충전할 수 없습니다. 수정에서 한도를 먼저 정하세요", 400);
    }
    const before = Number(key.max_budget);
    if (!Number.isFinite(before)) {
      throw httpError("현재 예산을 읽을 수 없습니다", 400);
    }
    const after = before + addBudget;
    update.max_budget = after;
    entry.add_budget = addBudget;
    entry.max_budget_before = before;
    entry.max_budget_after = after;
  }

  if (expires) {
    update.duration = durationFromExpiryDate(expires, now);
    const m = expires.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
    entry.expires = expires;
    entry.expires_before = key.expires || null;
    entry.expires_after = end.toISOString();
  } else if (addDays != null) {
    const next = nextExpiryFromAddDays(key.expires, addDays, now);
    update.duration = durationUntil(next, now);
    entry.add_days = addDays;
    entry.expires = next.toISOString().slice(0, 10);
    entry.expires_before = key.expires || null;
    entry.expires_after = next.toISOString();
  }

  return { update, entry };
}

function mergeHistoryMetadata(metadata, entry) {
  const next = { ...(metadata && typeof metadata === "object" ? metadata : {}) };
  const history = historyFromMetadata(next);
  history.push(entry);
  next[HISTORY_KEY] = history;
  return { metadata: next, history };
}

/**
 * 한 키의 예산을 가산하고/또는 만료를 늘린 뒤 이력을 metadata 에 붙인다.
 * LiteLLM POST /key/update { key, max_budget?, duration?, metadata }
 */
async function adjustKey(body, { litellm, now = new Date(), actor, key: preloaded = null } = {}) {
  const token = String(body?.token || body?.key || "").trim();
  if (!token) throw httpError("token이 필요합니다", 400);
  if (!litellm) throw httpError("litellm 클라이언트가 필요합니다", 500);

  // 일괄 충전은 목록을 한 번 읽어 넘긴다. 키마다 /key/info 를 다시 부르지 않는다.
  const key = preloaded ? { ...preloaded } : await findKey(litellm, token);
  if (!key) throw httpError("키를 찾을 수 없습니다", 404);
  if (!keyToken(key)) key.token = token;

  const { update, entry } = buildUpdateAndEntry(key, body, now, actor);
  const { metadata, history } = mergeHistoryMetadata(key.metadata, entry);
  update.metadata = metadata;

  const updated = await litellm("/key/update", "POST", update);
  const maxBudget = updated?.max_budget ?? update.max_budget ?? key.max_budget ?? null;
  const expires = updated?.expires ?? entry.expires_after ?? key.expires ?? null;

  return {
    alias: key.key_alias || updated?.key_alias || null,
    token,
    team_id: key.team_id || null,
    add_budget: entry.add_budget ?? null,
    add_days: entry.add_days ?? null,
    max_budget: maxBudget,
    max_budget_before: entry.max_budget_before ?? key.max_budget ?? null,
    spend: key.spend ?? updated?.spend ?? 0,
    remaining: remainingBudget(maxBudget, key.spend ?? updated?.spend ?? 0),
    expires,
    expires_before: entry.expires_before ?? null,
    history,
    entry,
  };
}

const MAX_BULK_ADJUST = 500;
const RETIRED_RE = /-폐기(-\d+)?$/;

/**
 * 여러 키를 한 번에 충전·연장한다. tokens 가 있으면 그 키만, 없으면 team_id 학급 전체.
 * 폐기된 키(별칭 끝이 -폐기)는 학급 전체에서 뺀다. 부분 실패는 행마다 남긴다.
 */
async function adjustKeys(body, { litellm, now = new Date(), actor } = {}) {
  if (!litellm) throw httpError("litellm 클라이언트가 필요합니다", 500);
  const addBudget = parseAddBudget(body?.add_budget);
  const addDays = parseAddDays(body?.add_days);
  const expires = body?.expires != null ? String(body.expires).trim() : "";
  if (addBudget == null && addDays == null && !expires) {
    throw httpError("충전 금액 또는 연장(만료일·일수)이 필요합니다", 400);
  }
  if (addDays != null && expires) {
    throw httpError("만료일과 연장 일수를 함께 지정할 수 없습니다", 400);
  }
  const tokens = Array.isArray(body?.tokens)
    ? [...new Set(body.tokens.map((t) => String(t || "").trim()).filter(Boolean))]
    : [];
  const teamId = String(body?.team_id || "").trim();
  if (!tokens.length && !teamId) throw httpError("키를 고르거나 학급을 정하세요", 400);

  const all = await listAllKeys(litellm);
  let targets;
  if (tokens.length) {
    const byToken = new Map(all.map((k) => [keyToken(k), k]));
    targets = tokens.map((t) => byToken.get(t) || { token: t, missing: true });
  } else {
    targets = all.filter((k) => k.team_id === teamId && !RETIRED_RE.test(String(k.key_alias || "")));
  }
  if (!targets.length) throw httpError("조건에 맞는 키가 없습니다", 400);
  if (targets.length > MAX_BULK_ADJUST) {
    throw httpError(`한 번에 ${MAX_BULK_ADJUST}개까지 충전할 수 있습니다`, 400);
  }

  const payload = {};
  if (addBudget != null) payload.add_budget = addBudget;
  if (addDays != null) payload.add_days = addDays;
  if (expires) payload.expires = expires;

  const results = [];
  for (const k of targets) {
    const token = keyToken(k);
    if (k.missing || !token) {
      results.push({ alias: null, token: token || null, error: "키를 찾을 수 없습니다" });
      continue;
    }
    try {
      const out = await adjustKey({ token, ...payload }, { litellm, now, actor, key: k });
      results.push({
        alias: out.alias,
        token,
        team_id: out.team_id,
        max_budget_before: out.max_budget_before,
        max_budget: out.max_budget,
        remaining: out.remaining,
        expires: out.expires,
      });
    } catch (e) {
      results.push({ alias: k.key_alias || null, token, team_id: k.team_id || null, error: e.message });
    }
  }
  return {
    results,
    team_id: teamId || null,
    add_budget: addBudget,
    add_days: addDays,
    expires: expires || null,
  };
}

async function keyDetail(token, { litellm } = {}) {
  const tok = String(token || "").trim();
  if (!tok) throw httpError("token이 필요합니다", 400);
  if (!litellm) throw httpError("litellm 클라이언트가 필요합니다", 500);
  const key = await findKey(litellm, tok);
  if (!key) throw httpError("키를 찾을 수 없습니다", 404);
  return {
    key,
    history: historyFromMetadata(key.metadata),
    remaining: remainingBudget(key.max_budget, key.spend),
  };
}

module.exports = {
  HISTORY_KEY,
  MAX_ADD_BUDGET,
  MAX_ADD_DAYS,
  keyToken,
  historyFromMetadata,
  unwrapKeyInfo,
  findKey,
  listAllKeys,
  parseAddBudget,
  parseAddDays,
  nextExpiryFromAddDays,
  durationUntil,
  remainingBudget,
  buildUpdateAndEntry,
  mergeHistoryMetadata,
  adjustKey,
  adjustKeys,
  MAX_BULK_ADJUST,
  keyDetail,
};
