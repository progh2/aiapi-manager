// 유출된 학생 키를 막으면서 같은 별칭의 새 키를 만든다.
// LiteLLM 가상 키 재발급은 Enterprise 라 쓰지 않는다.
// 새 키의 예산은 이전 키에 남은 금액이다.
const { findKey, listAllKeys } = require("./key-adjust");

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function remainingBudget(key) {
  if (key.max_budget == null) return null;
  const left = Number(key.max_budget) - Number(key.spend || 0);
  if (!Number.isFinite(left)) return 0;
  return Math.max(0, Math.round(left * 10000) / 10000);
}

function retiredAlias(alias, existing) {
  const base = `${alias}-폐기`;
  if (!existing.has(base)) return base;
  for (let i = 2; i < 50; i++) {
    const name = `${base}-${i}`;
    if (!existing.has(name)) return name;
  }
  throw httpError("폐기된 키의 별칭을 만들지 못했습니다", 409);
}

function expiryDuration(key, now) {
  if (!key.expires) return null;
  const end = new Date(key.expires);
  if (Number.isNaN(end.getTime()) || end.getTime() <= now.getTime()) {
    throw httpError("만료된 키입니다. 만료일을 늘린 뒤 다시 만드세요", 400);
  }
  const seconds = Math.max(1, Math.floor((end.getTime() - now.getTime()) / 1000));
  return `${seconds}s`;
}

async function reissueKey(token, { litellm, now = new Date() }) {
  const key = await findKey(litellm, token);
  if (!key) throw httpError("키를 찾을 수 없습니다", 404);
  const alias = String(key.key_alias || "").trim();
  if (!alias) throw httpError("별칭이 없는 키는 다시 만들 수 없습니다", 400);
  const listed = await listAllKeys(litellm);
  const existing = new Set(listed.map((item) => item.key_alias).filter(Boolean));
  const retired = retiredAlias(alias, existing);
  const duration = expiryDuration(key, now);

  await litellm("/key/update", "POST", { key: token, key_alias: retired });
  try {
    await litellm("/key/block", "POST", { key: token });
  } catch (e) {
    try { await litellm("/key/update", "POST", { key: token, key_alias: alias }); } catch (_) { /* 별칭을 되돌린다 */ }
    if (!e.status) e.status = 502;
    throw e;
  }

  const metadata = { ...(key.metadata || {}) };
  const history = Array.isArray(metadata.aiapi_history) ? metadata.aiapi_history.slice() : [];
  history.push({ at: now.toISOString(), action: "reissue", replaces: retired });
  metadata.aiapi_history = history.slice(-30);
  const payload = {
    key_alias: alias,
    metadata,
  };
  if (Array.isArray(key.models) && key.models.length) payload.models = key.models;
  if (key.team_id) payload.team_id = key.team_id;
  if (key.user_id) payload.user_id = key.user_id;
  const budget = remainingBudget(key);
  if (budget != null) payload.max_budget = budget;
  if (key.budget_duration) payload.budget_duration = key.budget_duration;
  if (key.rpm_limit) payload.rpm_limit = key.rpm_limit;
  if (key.tpm_limit) payload.tpm_limit = key.tpm_limit;
  if (duration) payload.duration = duration;

  try {
    const created = await litellm("/key/generate", "POST", payload);
    return {
      key: created.key,
      key_alias: alias,
      retired_alias: retired,
      max_budget: budget,
      models: payload.models || [],
    };
  } catch (e) {
    try { await litellm("/key/unblock", "POST", { key: token }); } catch (_) { /* 새 키가 없으면 이전 키를 다시 연다 */ }
    try { await litellm("/key/update", "POST", { key: token, key_alias: alias }); } catch (_) { /* 동일 */ }
    if (!e.status) e.status = 502;
    throw e;
  }
}

module.exports = {
  remainingBudget,
  retiredAlias,
  expiryDuration,
  reissueKey,
};
