// 공급자별 모델 목록 조회와 LiteLLM 백엔드 이름.
// API 키는 이 모듈이 저장하지 않는다. 오류 문구에도 키를 넣지 않는다.

const PROVIDERS = {
  openai: {
    label: "OpenAI",
    backend: (id) => `openai/${id}`,
  },
  anthropic: {
    label: "Anthropic",
    backend: (id) => (id.startsWith("anthropic/") ? id : `anthropic/${id}`),
  },
  gemini: {
    label: "Google Gemini",
    backend: (id) => (id.startsWith("gemini/") ? id : `gemini/${id}`),
  },
  groq: {
    label: "Groq",
    backend: (id) => (id.startsWith("groq/") ? id : `groq/${id}`),
  },
  openrouter: {
    label: "OpenRouter",
    backend: (id) => (id.startsWith("openrouter/") ? id : `openrouter/${id}`),
  },
  ollama: {
    label: "Ollama (로컬)",
    needsBase: true,
    optionalKey: true,
    optionalBudget: true,
    basePlaceholder: "http://192.168.0.10:11434",
    // LiteLLM ollama 호출은 루트 주소에 /api/chat 을 붙인다.
    backend: (id) => (id.startsWith("ollama/") ? id : `ollama/${id}`),
  },
  custom: {
    label: "OpenAI 호환 (직접 주소)",
    needsBase: true,
    backend: (id) => (id.startsWith("openai/") ? id : `openai/${id}`),
  },
};

const CHAT_SKIP = /(embed|whisper|tts|transcri|dall-e|moderation|image|audio|realtime|sora|davinci|babbage|ada\b)/i;

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function ollamaRoot(apiBase) {
  return String(apiBase || "").trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function providerOf(name) {
  const spec = PROVIDERS[String(name || "").trim()];
  if (!spec) throw httpError("지원하지 않는 공급자입니다", 400);
  return spec;
}

function publicModelId(provider, raw) {
  let id = String(raw || "").trim();
  if (provider === "gemini") id = id.replace(/^models\//, "");
  if (!id) throw httpError("모델 이름이 필요합니다", 400);
  if (/\s/.test(id)) throw httpError(`모델 이름이 올바르지 않습니다: ${id}`, 400);
  const slashOk = provider === "openrouter" || provider === "custom" || provider === "ollama";
  if (id.includes("/") && !slashOk) throw httpError(`모델 이름이 올바르지 않습니다: ${id}`, 400);
  return id;
}

function parseModelIds(provider, payload) {
  const body = payload && typeof payload === "object" ? payload : {};
  let ids = [];
  if (provider === "gemini") {
    ids = (body.models || []).map((m) => String(m.name || "").replace(/^models\//, ""));
  } else if (provider === "ollama") {
    ids = (body.models || []).map((m) => m.name || m.model);
  } else if (provider === "anthropic") {
    ids = (body.data || []).map((m) => m.id);
  } else if (provider === "openrouter") {
    ids = (body.data || []).map((m) => m.id);
  } else {
    ids = (body.data || []).map((m) => m.id);
  }
  const out = [];
  const seen = new Set();
  for (const raw of ids) {
    const id = String(raw || "").trim();
    if (!id || seen.has(id) || CHAT_SKIP.test(id)) continue;
    seen.add(id);
    out.push(id);
  }
  out.sort();
  return out;
}

async function listProviderModels({ provider, apiKey, apiBase, fetchImpl = fetch } = {}) {
  const name = String(provider || "").trim();
  const spec = providerOf(name);
  const key = String(apiKey || "").trim();
  if (!key && !spec.optionalKey) throw httpError("API 키가 필요합니다", 400);
  const base = name === "ollama" ? ollamaRoot(apiBase) : String(apiBase || "").trim().replace(/\/$/, "");
  if (spec.needsBase && !base) throw httpError("API 주소가 필요합니다", 400);

  let url;
  const headers = { Accept: "application/json" };
  if (name === "openai") url = "https://api.openai.com/v1/models";
  else if (name === "groq") url = "https://api.groq.com/openai/v1/models";
  else if (name === "openrouter") url = "https://openrouter.ai/api/v1/models";
  else if (name === "anthropic") url = "https://api.anthropic.com/v1/models";
  else if (name === "gemini") url = "https://generativelanguage.googleapis.com/v1beta/models";
  else if (name === "ollama") url = `${base}/api/tags`;
  else url = `${base}/models`;

  if (name === "anthropic") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else if (name === "gemini") {
    headers["x-goog-api-key"] = key;
  } else if (key) {
    headers.Authorization = `Bearer ${key}`;
  }

  let resp;
  try {
    resp = await fetchImpl(url, { headers });
  } catch {
    throw httpError("모델 목록 서버에 연결하지 못했습니다", 502);
  }
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw httpError("모델 목록을 가져오지 못했습니다. 키와 공급자를 확인하세요", 502);
  }
  const models = parseModelIds(name, payload);
  if (!models.length) throw httpError("채팅에 쓸 모델이 목록에 없습니다. 모델 이름을 직접 입력하세요", 502);
  return models;
}

module.exports = {
  PROVIDERS,
  CHAT_SKIP,
  ollamaRoot,
  providerOf,
  publicModelId,
  parseModelIds,
  listProviderModels,
};
