// 기간 만료 키 일괄 차단·회수.
// 개별 POST /api/keys/block · /api/keys/delete 와 같은 LiteLLM 경로를 쓴다.
// 서버(require)와 브라우저(<script src="/key-revoke.js">)에서 필터 규칙을 공유한다.

const MAX_REVOKE = 500;
const DAY_MS = 86400000;
const FILTERS = new Set(["expired", "expiring", "all", "blocked", "active"]);

function parseExpires(key) {
  if (!key || key.expires == null || key.expires === "") return null;
  const d = new Date(key.expires);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isExpired(key, now = new Date()) {
  const d = parseExpires(key);
  return !!(d && d.getTime() < now.getTime());
}

function isExpiringSoon(key, withinDays = 7, now = new Date()) {
  const days = Number(withinDays);
  const windowMs = (Number.isFinite(days) && days > 0 ? days : 7) * DAY_MS;
  const d = parseExpires(key);
  if (!d) return false;
  const t = d.getTime();
  const n = now.getTime();
  return t >= n && t <= n + windowMs;
}

function keyToken(key) {
  return (key && (key.token || key.key)) || "";
}

function matchesFilter(key, filter, opts = {}) {
  const now = opts.now || new Date();
  const teamId = opts.team_id || "";
  if (teamId && key.team_id !== teamId) return false;
  switch (filter) {
    case "all":
    case "":
    case undefined:
    case null:
      return true;
    case "expired":
      return isExpired(key, now);
    case "expiring":
      return isExpiringSoon(key, opts.within_days, now);
    case "blocked":
      return !!key.blocked;
    case "active":
      return !key.blocked && !isExpired(key, now);
    default:
      return false;
  }
}

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function normalizeTokens(tokens) {
  if (!Array.isArray(tokens)) return [];
  return [...new Set(tokens.map((t) => String(t || "").trim()).filter(Boolean))];
}

function effectiveFilter(body, hasTokens) {
  if (hasTokens) return null;
  if (body.filter) return String(body.filter);
  if (body.team_id) return "all";
  return "expired";
}

function selectKeysForRevoke(body, keys, now = new Date()) {
  const tokens = normalizeTokens(body.tokens);
  if (tokens.length) {
    const byToken = new Map();
    for (const k of keys) {
      const tok = keyToken(k);
      if (tok) byToken.set(tok, k);
    }
    return tokens.map((token) => {
      const k = byToken.get(token);
      if (!k) return { token, key_alias: null, missing: true };
      return k;
    });
  }

  const filter = effectiveFilter(body, false);
  if (!FILTERS.has(filter)) {
    throw httpError("filter는 expired, expiring, all, blocked, active 중 하나여야 합니다", 400);
  }
  if (filter === "all" && !String(body.team_id || "").trim()) {
    throw httpError("전체 키 일괄 회수는 그룹을 고르거나 만료 필터를 쓰세요", 400);
  }

  return keys.filter((k) => matchesFilter(k, filter, {
    team_id: String(body.team_id || "").trim(),
    within_days: body.within_days,
    now,
  }));
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

function resultRow(key, extra) {
  return {
    alias: key.key_alias || null,
    token: keyToken(key),
    team_id: key.team_id || null,
    expires: key.expires || null,
    blocked: !!key.blocked,
    ...extra,
  };
}

async function revokeOne(litellm, action, key) {
  const token = keyToken(key);
  if (key.missing || !token) {
    return resultRow(key, { error: "키를 찾을 수 없습니다" });
  }
  try {
    if (action === "block") {
      if (key.blocked) {
        return resultRow(key, { blocked: true, skipped: true });
      }
      await litellm("/key/block", "POST", { key: token });
      return resultRow(key, { blocked: true });
    }
    await litellm("/key/delete", "POST", { keys: [token] });
    return resultRow(key, { deleted: true, blocked: true });
  } catch (e) {
    return resultRow(key, { error: e.message });
  }
}

/**
 * LiteLLM 키를 순차 차단(/key/block) 또는 삭제(/key/delete)한다.
 * tokens[] 가 있으면 그 키만, 없으면 team_id / filter 로 고른다.
 * 부분 실패는 나머지를 계속 진행하고 results[].error 로 남긴다.
 */
async function revokeKeys(body, { litellm, now = new Date() } = {}) {
  const action = String(body?.action || "").trim();
  if (action !== "block" && action !== "delete") {
    throw httpError("action은 block 또는 delete 여야 합니다", 400);
  }
  if (!litellm) {
    throw httpError("litellm 클라이언트가 필요합니다", 500);
  }

  const tokens = normalizeTokens(body.tokens);
  if (!tokens.length && !body.filter && !body.team_id) {
    // 아무 조건도 없으면 만료된 키만 (학기 종료 기본 동작)
  }

  const keys = await listAllKeys(litellm);
  const selected = selectKeysForRevoke(body, keys, now);

  if (!selected.length) {
    throw httpError("조건에 맞는 키가 없습니다", 400);
  }
  if (selected.length > MAX_REVOKE) {
    throw httpError(`한 번에 ${MAX_REVOKE}개까지 회수할 수 있습니다`, 400);
  }

  const results = [];
  for (const k of selected) {
    results.push(await revokeOne(litellm, action, k));
  }

  return {
    action,
    results,
    filter: effectiveFilter(body, tokens.length > 0),
    team_id: body.team_id || null,
  };
}

const KeyRevoke = {
  MAX_REVOKE,
  FILTERS,
  parseExpires,
  isExpired,
  isExpiringSoon,
  keyToken,
  matchesFilter,
  effectiveFilter,
  selectKeysForRevoke,
  listAllKeys,
  revokeKeys,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = KeyRevoke;
}
if (typeof window !== "undefined") {
  window.KeyRevoke = KeyRevoke;
}
