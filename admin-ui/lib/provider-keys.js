// 관리 화면에서 등록한 공급자 API 키.
// 비밀 키는 이 JSON에만 두고, API 응답에서는 뺀다.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { PROVIDERS, providerOf, publicModelId, ollamaRoot } = require("./provider-catalog");
const { normalizeSchedule } = require("./schedule");

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function litellmUserId(slug) {
  return `provider:${slug}`;
}

function callName(slug, model) {
  return `${slug}/${model}`;
}

class ProviderKeyStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { keys: [] };
    this.load();
  }

  load() {
    this.corrupt = false;
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!parsed || !Array.isArray(parsed.keys)) throw new Error("keys 배열이 없습니다");
      this.data = parsed;
    } catch (e) {
      console.error("provider-keys.json 로드 실패:", e.message);
      this.corrupt = true;
      this.data = { keys: [] };
    }
  }

  isCorrupt() {
    return Boolean(this.corrupt);
  }

  save() {
    if (this.corrupt) {
      throw httpError("provider-keys.json이 손상되어 저장할 수 없습니다", 503);
    }
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  list() {
    return this.data.keys.slice();
  }

  get(id) {
    return this.data.keys.find((k) => k.id === id || k.slug === id) || null;
  }

  add(record) {
    this.data.keys.push(record);
    this.save();
    return record;
  }

  remove(id) {
    const before = this.data.keys.length;
    this.data.keys = this.data.keys.filter((k) => k.id !== id);
    if (this.data.keys.length === before) throw httpError("공급자 키를 찾을 수 없습니다", 404);
    this.save();
  }
}

function hintOf(apiKey) {
  const s = String(apiKey || "");
  return s.length <= 4 ? "••••" : `••••${s.slice(-4)}`;
}

function toPublic(record, spend) {
  return {
    id: record.id,
    slug: record.slug,
    label: record.label,
    provider: record.provider,
    provider_label: (PROVIDERS[record.provider] || {}).label || record.provider,
    key_hint: record.key_hint,
    api_base: record.api_base || null,
    max_budget: record.max_budget,
    budget_duration: record.budget_duration || "",
    spend: spend == null ? null : spend,
    models: (record.models || []).map((m) => ({
      name: m.name,
      call_name: m.call_name,
    })),
    members: record.kind === "pool"
      ? (record.members || []).map((m) => ({
        provider_key_id: m.provider_key_id,
        provider_slug: m.provider_slug || "",
        label: m.label,
        model: m.model,
        weight: m.weight,
      }))
      : undefined,
    kind: record.kind || "key",
    builtin: false,
  };
}

function envProvider() {
  return {
    id: "env",
    slug: "",
    label: "기본 OpenAI (.env)",
    provider: "openai",
    provider_label: "OpenAI",
    key_hint: ".env",
    api_base: null,
    max_budget: null,
    budget_duration: "",
    spend: null,
    models: [
      { name: "gpt-4o-mini", call_name: "gpt-4o-mini" },
      { name: "gpt-4o", call_name: "gpt-4o" },
    ],
    builtin: true,
    note: "한도는 이 화면에 없습니다. OpenAI 사이트에서 월 한도를 거세요.",
  };
}

function normalizeSlug(slug) {
  const s = String(slug || "").trim().toLowerCase();
  if (!SLUG_RE.test(s)) {
    throw httpError("슬러그는 영문 소문자, 숫자, 하이픈만 쓸 수 있습니다 (예: openai-a)", 400);
  }
  return s;
}

function normalizeBudget(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw httpError("사용 한도(USD)는 0보다 커야 합니다", 400);
  return n;
}

function normalizeDuration(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (!["1d", "7d", "30d"].includes(v)) throw httpError("리셋 주기는 없음, 1d, 7d, 30d 중 하나여야 합니다", 400);
  return v;
}

function normalizeModelSelection(record, requested) {
  const known = new Map();
  for (const m of record.models || []) {
    known.set(m.name, m.call_name);
    known.set(m.call_name, m.call_name);
  }
  const out = [];
  const seen = new Set();
  for (const raw of requested || []) {
    const name = String(raw || "").trim();
    const call = known.get(name);
    if (!call || seen.has(call)) continue;
    seen.add(call);
    out.push(call);
  }
  return out;
}

function attachProvider(body, store, { bindUser = true } = {}) {
  const id = String(body.provider_key_id || "").trim();
  const hasSchedule = body.schedule !== undefined;
  const schedule = hasSchedule ? normalizeSchedule(body.schedule) : null;
  const metadata = { ...(body.metadata && typeof body.metadata === "object" ? body.metadata : {}) };
  if (hasSchedule) metadata.aiapi_schedule = schedule;

  if (!id || id === "env") {
    const next = { ...body };
    if (hasSchedule) next.metadata = metadata;
    delete next.provider_key_id;
    delete next.schedule;
    return next;
  }

  if (!store || store.isCorrupt()) throw httpError("공급자 키 저장소를 읽을 수 없습니다", 503);
  const record = store.get(id);
  if (!record) throw httpError("공급자 키를 찾을 수 없습니다", 400);
  let models = normalizeModelSelection(record, body.models);
  if (!models.length) {
    if (bindUser) throw httpError("이 공급자 키에서 쓸 모델을 하나 이상 고르세요", 400);
    models = (record.models || []).map((m) => m.call_name);
  }
  metadata.aiapi_provider_key_id = record.id;
  const next = {
    ...body,
    models,
    provider_key_id: record.id,
  };
  if (bindUser) {
    next.user_id = record.litellm_user_id;
    next.metadata = metadata;
  } else {
    delete next.metadata;
  }
  delete next.schedule;
  return next;
}

function modelIdsOf(record) {
  const ids = [];
  for (const m of record.models || []) {
    if (m.model_id) ids.push(m.model_id);
    for (const id of m.model_ids || []) if (id) ids.push(id);
  }
  return [...new Set(ids)];
}

function poolsUsing(record, store) {
  if (!store || record.kind === "pool") return [];
  return store.list().filter((item) => item.kind === "pool"
    && (item.members || []).some((m) => m.provider_key_id === record.id));
}

function keysUsing(record, keys) {
  const prefix = `${record.slug}/`;
  return (keys || []).filter((key) => {
    const models = Array.isArray(key.models) ? key.models : [];
    const meta = key.metadata || {};
    return meta.aiapi_provider_key_id === record.id || models.some((m) => String(m).startsWith(prefix));
  });
}

function spendFor(record, keys) {
  const sum = keysUsing(record, keys).reduce((acc, key) => acc + (Number(key.spend) || 0), 0);
  return Math.round(sum * 1000) / 1000;
}

async function registerProvider(input, { litellm, store }) {
  if (!store || store.isCorrupt()) throw httpError("공급자 키 저장소를 읽을 수 없습니다", 503);
  const provider = String(input.provider || "").trim();
  const spec = providerOf(provider);
  const slug = normalizeSlug(input.slug);
  const label = String(input.label || "").trim();
  if (!label) throw httpError("표시 이름이 필요합니다", 400);
  if (store.get(slug)) throw httpError("이미 있는 슬러그입니다", 409);
  const apiKey = String(input.api_key || "").trim();
  if (!apiKey && !spec.optionalKey) throw httpError("API 키가 필요합니다", 400);
  let apiBase = String(input.api_base || "").trim().replace(/\/$/, "");
  if (provider === "ollama") apiBase = ollamaRoot(apiBase);
  if (spec.needsBase && !apiBase) throw httpError("API 주소가 필요합니다", 400);
  const budgetBlank = input.max_budget === "" || input.max_budget == null;
  const maxBudget = spec.optionalBudget && budgetBlank ? null : normalizeBudget(input.max_budget);
  const budgetDuration = normalizeDuration(input.budget_duration);
  const names = [];
  const seen = new Set();
  for (const raw of input.models || []) {
    const name = publicModelId(provider, raw);
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  if (!names.length) throw httpError("모델을 하나 이상 고르세요", 400);

  const id = `pk_${crypto.randomBytes(4).toString("hex")}`;
  const userId = litellmUserId(slug);
  const userPayload = {
    user_id: userId,
    user_alias: label,
  };
  if (maxBudget != null) userPayload.max_budget = maxBudget;
  if (budgetDuration) userPayload.budget_duration = budgetDuration;
  await litellm("/user/new", "POST", userPayload);

  const models = [];
  try {
    for (const name of names) {
      const created = await litellm("/model/new", "POST", {
        model_name: callName(slug, name),
        litellm_params: {
          model: spec.backend(name),
          ...(apiKey ? { api_key: apiKey } : {}),
          ...(apiBase ? { api_base: apiBase } : {}),
        },
        model_info: { access_groups: [slug], aiapi_provider_key_id: id },
      });
      models.push({
        name,
        call_name: callName(slug, name),
        backend: spec.backend(name),
        model_id: created.model_id || created.model_info?.id || null,
      });
    }
  } catch (e) {
    for (const m of models) {
      if (m.model_id) {
        try { await litellm("/model/delete", "POST", { id: m.model_id }); } catch (_) { /* 이미 실패한 등록을 치운다 */ }
      }
    }
    try { await litellm("/user/delete", "POST", { user_ids: [userId] }); } catch (_) { /* 동일 */ }
    if (!e.status) e.status = 502;
    throw e;
  }

  const record = {
    id,
    slug,
    label,
    kind: "key",
    provider,
    api_key: apiKey,
    api_base: apiBase || null,
    key_hint: apiKey ? hintOf(apiKey) : "로컬",
    max_budget: maxBudget,
    budget_duration: budgetDuration,
    litellm_user_id: userId,
    models,
    created_at: new Date().toISOString(),
  };
  store.add(record);
  return toPublic(record, 0);
}

async function deleteProvider(id, { litellm, store, keys = [] }) {
  if (!store || store.isCorrupt()) throw httpError("공급자 키 저장소를 읽을 수 없습니다", 503);
  const record = store.get(id);
  if (!record || record.id === "env") throw httpError("공급자 키를 찾을 수 없습니다", 404);
  if (keysUsing(record, keys).length) {
    const message = record.kind === "pool"
      ? "이 묶음을 쓰는 학생 키가 있습니다. 학생 키를 먼저 삭제하세요"
      : "이 공급자 키를 쓰는 학생 키가 있습니다. 학생 키를 먼저 삭제하세요";
    throw httpError(message, 409);
  }
  if (poolsUsing(record, store).length) {
    throw httpError("이 공급자 키를 쓰는 묶음이 있습니다. 묶음을 먼저 삭제하세요", 409);
  }
  for (const modelId of modelIdsOf(record)) {
    try { await litellm("/model/delete", "POST", { id: modelId }); } catch (_) { /* 이미 없으면 계속 */ }
  }
  try { await litellm("/user/delete", "POST", { user_ids: [record.litellm_user_id] }); } catch (_) { /* 동일 */ }
  store.remove(record.id);
  return { ok: true };
}

function normalizeWeight(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    throw httpError("비율은 1부터 1000 사이의 정수입니다. 2와 1이면 2인 쪽이 약 두 배 자주 선택됩니다", 400);
  }
  return n;
}

function normalizePoolModelName(raw, fallback) {
  const name = String(raw || "").trim() || fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(name)) {
    throw httpError("학생에게 보일 모델 이름은 영문, 숫자, 점, 밑줄, 콜론, 하이픈만 쓸 수 있습니다", 400);
  }
  return name;
}

function envMemberSource() {
  return {
    id: "env",
    slug: "",
    label: "기본 OpenAI (.env)",
    provider: "openai",
    api_key: "os.environ/OPENAI_API_KEY",
    api_base: null,
    models: [
      { name: "gpt-4o-mini", backend: "openai/gpt-4o-mini" },
      { name: "gpt-4o", backend: "openai/gpt-4o" },
    ],
  };
}

function memberSource(store, providerKeyId) {
  const id = String(providerKeyId || "").trim();
  if (id === "env") return envMemberSource();
  const record = store.get(id);
  if (!record || record.kind === "pool") throw httpError("묶음에 넣을 공급자 키를 찾을 수 없습니다", 400);
  return record;
}

function backendOf(source, model) {
  if (model.backend) return model.backend;
  return providerOf(source.provider).backend(model.name);
}

// 같은 model_name 으로 배포를 여러 개 만들면 LiteLLM simple-shuffle 이 weight 비율로 고른다.
// 학생 모델 이름은 하나다. 키를 묶음에 넣기 전에는 슬러그가 달라 섞이지 않는다.
async function registerPool(input, { litellm, store }) {
  if (!store || store.isCorrupt()) throw httpError("공급자 키 저장소를 읽을 수 없습니다", 503);
  const slug = normalizeSlug(input.slug);
  const label = String(input.label || "").trim();
  if (!label) throw httpError("표시 이름이 필요합니다", 400);
  if (store.get(slug)) throw httpError("이미 있는 슬러그입니다", 409);
  const maxBudget = normalizeBudget(input.max_budget);
  const budgetDuration = normalizeDuration(input.budget_duration);
  const rows = Array.isArray(input.members) ? input.members : [];
  if (rows.length < 2) throw httpError("묶음에는 공급자 키를 둘 이상 넣으세요", 400);

  const seen = new Set();
  const resolved = [];
  for (const raw of rows) {
    const source = memberSource(store, raw.provider_key_id);
    if (seen.has(source.id)) throw httpError("같은 공급자 키를 묶음에 두 번 넣을 수 없습니다", 400);
    seen.add(source.id);
    const modelName = String(raw.model || "").trim();
    const found = (source.models || []).find((m) => m.name === modelName || m.call_name === modelName);
    if (!found) throw httpError(`'${source.label}'에서 고른 모델이 없습니다`, 400);
    resolved.push({ source, found, weight: normalizeWeight(raw.weight ?? 1) });
  }

  const shared = [...new Set(resolved.map((row) => row.found.name))];
  const sharedOk = shared.length === 1 && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(shared[0]);
  const publicName = normalizePoolModelName(input.model_name, sharedOk ? shared[0] : "chat");
  const id = `pool_${crypto.randomBytes(4).toString("hex")}`;
  const userId = `pool:${slug}`;
  const call = callName(slug, publicName);
  const userPayload = { user_id: userId, user_alias: label, max_budget: maxBudget };
  if (budgetDuration) userPayload.budget_duration = budgetDuration;
  await litellm("/user/new", "POST", userPayload);

  const createdIds = [];
  try {
    for (const row of resolved) {
      const params = { model: backendOf(row.source, row.found), weight: row.weight };
      if (row.source.api_key) params.api_key = row.source.api_key;
      if (row.source.api_base) params.api_base = row.source.api_base;
      const created = await litellm("/model/new", "POST", {
        model_name: call,
        litellm_params: params,
        model_info: { access_groups: [slug], aiapi_pool_id: id, aiapi_member_id: row.source.id },
      });
      createdIds.push(created.model_id || created.model_info?.id || null);
    }
  } catch (e) {
    for (const modelId of createdIds) {
      if (modelId) {
        try { await litellm("/model/delete", "POST", { id: modelId }); } catch (_) { /* 실패한 묶음을 치운다 */ }
      }
    }
    try { await litellm("/user/delete", "POST", { user_ids: [userId] }); } catch (_) { /* 동일 */ }
    if (!e.status) e.status = 502;
    throw e;
  }

  const record = {
    id,
    kind: "pool",
    slug,
    label,
    provider: "pool",
    api_key: "",
    api_base: null,
    key_hint: resolved.map((row) => String(row.weight)).join(":"),
    max_budget: maxBudget,
    budget_duration: budgetDuration,
    litellm_user_id: userId,
    models: [{
      name: publicName,
      call_name: call,
      model_id: createdIds.find(Boolean) || null,
      model_ids: createdIds.filter(Boolean),
    }],
    members: resolved.map((row, index) => ({
      provider_key_id: row.source.id,
      provider_slug: row.source.slug || "",
      label: row.source.label,
      model: row.found.name,
      weight: row.weight,
      model_id: createdIds[index] || null,
    })),
    created_at: new Date().toISOString(),
  };
  store.add(record);
  return toPublic(record, 0);
}

module.exports = {
  SLUG_RE,
  ProviderKeyStore,
  litellmUserId,
  callName,
  toPublic,
  envProvider,
  normalizeSlug,
  normalizeModelSelection,
  attachProvider,
  keysUsing,
  spendFor,
  registerProvider,
  registerPool,
  deleteProvider,
};
