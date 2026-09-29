// AI 엘피 설정과 이번 달 사용량. 비밀 값(API 키, 비서 전용 가상 키)은 이 파일에만 두고 응답에서는 뺀다.
const fs = require("fs");
const path = require("path");

const DEFAULTS = Object.freeze({
  enabled: false,
  mode: "direct", // direct: OpenAI·Ollama·호환 주소에 바로 / proxy: 이 프록시(LiteLLM)의 모델
  provider: "ollama", // openai | ollama | compatible
  base_url: "",
  api_key: "",
  model: "",
  proxy_model: "",
  proxy_key: "",
  proxy_key_alias: "aiapi-assistant",
  proxy_budget: 5,
  mask_names: true,
  allow_users: false,
  monthly_token_cap: 3000000,
  num_ctx: 8192,
  max_output_tokens: 700,
  // 빠른 응답: 생각(추론)을 끌 수 있는 모델은 끄고 묻는다. 생각만 하는 모델은 자동으로 켠 채 묻는다.
  fast_mode: true,
  last_test: null,
  usage: { month: "", prompt_tokens: 0, completion_tokens: 0, requests: 0 },
});

const PROVIDERS = new Set(["openai", "ollama", "compatible"]);
const MODES = new Set(["direct", "proxy"]);

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function seoulMonth(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit" }).format(date);
}

function hint(secret) {
  const s = String(secret || "");
  if (!s) return "";
  return s.length <= 4 ? "••••" : `••••${s.slice(-4)}`;
}

function numberIn(value, min, max, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw httpError(`${name}은(는) ${min}~${max} 사이여야 합니다`);
  return n;
}

function cleanUrl(value) {
  const s = String(value || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (!/^https?:\/\/[^\s/]+/i.test(s)) throw httpError("주소는 http:// 또는 https:// 로 시작해야 합니다");
  return s;
}

// 사설망·자기 자신 주소면 "로컬"로 본다. 학생 이름 가리기 안내에 쓴다.
function isPrivateHost(url) {
  const m = /^https?:\/\/([^/:]+)/i.exec(String(url || ""));
  if (!m) return false;
  const h = m[1].toLowerCase();
  return h === "localhost" || h === "host.docker.internal" || /^127\./.test(h) || /^10\./.test(h)
    || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith(".local");
}

class AssistantStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { ...DEFAULTS, usage: { ...DEFAULTS.usage } };
    this.corrupt = false;
    this.load();
  }

  load() {
    this.corrupt = false;
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!parsed || typeof parsed !== "object") throw new Error("형식이 올바르지 않습니다");
      this.data = { ...DEFAULTS, ...parsed, usage: { ...DEFAULTS.usage, ...(parsed.usage || {}) } };
    } catch (e) {
      console.error("assistant.json 로드 실패:", e.message);
      this.corrupt = true;
    }
  }

  isCorrupt() {
    return this.corrupt;
  }

  save() {
    if (this.corrupt) throw httpError("assistant.json 이 손상되어 저장할 수 없습니다", 503);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  get() {
    return JSON.parse(JSON.stringify(this.data));
  }

  // 외부 서비스(OpenAI 등)로 나가는지. 모르면 외부로 본다.
  isExternal(cfg = this.data) {
    if (cfg.mode === "proxy") return !/ollama/i.test(String(cfg.proxy_model || ""));
    if (cfg.provider === "ollama") return !cfg.base_url ? false : !isPrivateHost(cfg.base_url);
    if (cfg.provider === "compatible") return !isPrivateHost(cfg.base_url);
    return true;
  }

  ready(cfg = this.data) {
    if (!cfg.enabled) return false;
    if (cfg.mode === "proxy") return Boolean(cfg.proxy_model && cfg.proxy_key);
    if (!cfg.model) return false;
    if (cfg.provider === "openai") return Boolean(cfg.api_key);
    return Boolean(cfg.base_url);
  }

  publicView() {
    const d = this.get();
    const view = { ...d };
    delete view.api_key;
    delete view.proxy_key;
    view.api_key_hint = hint(d.api_key);
    view.has_api_key = Boolean(d.api_key);
    view.proxy_key_hint = hint(d.proxy_key);
    view.has_proxy_key = Boolean(d.proxy_key);
    view.external = this.isExternal(d);
    view.ready = this.ready(d);
    view.corrupt = this.corrupt;
    const month = seoulMonth();
    if (view.usage.month !== month) view.usage = { month, prompt_tokens: 0, completion_tokens: 0, requests: 0 };
    return view;
  }

  // 화면에서 온 값을 검증해 반영한다. api_key 는 새로 적었을 때만 바꾸고, clear_api_key 로 지운다.
  update(patch = {}) {
    if (this.corrupt) throw httpError("assistant.json 이 손상되어 저장할 수 없습니다", 503);
    const next = this.get();
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    if (patch.mode !== undefined) {
      if (!MODES.has(patch.mode)) throw httpError("연결 방식은 direct 또는 proxy 입니다");
      next.mode = patch.mode;
    }
    if (patch.provider !== undefined) {
      if (!PROVIDERS.has(patch.provider)) throw httpError("공급자는 openai, ollama, compatible 중 하나입니다");
      if (patch.provider !== next.provider) next.api_key = "";
      next.provider = patch.provider;
    }
    if (patch.base_url !== undefined) next.base_url = cleanUrl(patch.base_url);
    if (typeof patch.api_key === "string" && patch.api_key.trim()) next.api_key = patch.api_key.trim();
    if (patch.clear_api_key) next.api_key = "";
    if (patch.model !== undefined) next.model = String(patch.model || "").trim().slice(0, 200);
    if (patch.proxy_model !== undefined) next.proxy_model = String(patch.proxy_model || "").trim().slice(0, 200);
    if (patch.proxy_budget !== undefined) next.proxy_budget = numberIn(patch.proxy_budget, 0.5, 500, "비서 월 예산");
    if (patch.mask_names !== undefined) next.mask_names = Boolean(patch.mask_names);
    if (patch.allow_users !== undefined) next.allow_users = Boolean(patch.allow_users);
    if (patch.monthly_token_cap !== undefined) next.monthly_token_cap = Math.round(numberIn(patch.monthly_token_cap, 0, 1e9, "월 토큰 상한"));
    if (patch.num_ctx !== undefined) next.num_ctx = Math.round(numberIn(patch.num_ctx, 2048, 131072, "문맥 길이"));
    if (patch.max_output_tokens !== undefined) next.max_output_tokens = Math.round(numberIn(patch.max_output_tokens, 200, 4000, "답변 길이"));
    if (patch.fast_mode !== undefined) next.fast_mode = Boolean(patch.fast_mode);
    if (next.mode === "direct" && next.provider !== "openai" && next.enabled && !next.base_url) {
      throw httpError("Ollama·호환 연결은 주소가 필요합니다 (예: http://192.168.0.20:11434)");
    }
    this.data = next;
    this.save();
    return this.publicView();
  }

  setProxyKey(key) {
    this.data.proxy_key = key || "";
    this.save();
  }

  setLastTest(result) {
    this.data.last_test = { ...result, at: new Date().toISOString() };
    this.save();
  }

  addUsage({ prompt_tokens = 0, completion_tokens = 0 } = {}, now = new Date()) {
    const month = seoulMonth(now);
    const u = this.data.usage || {};
    if (u.month !== month) this.data.usage = { month, prompt_tokens: 0, completion_tokens: 0, requests: 0 };
    this.data.usage.prompt_tokens += Number(prompt_tokens) || 0;
    this.data.usage.completion_tokens += Number(completion_tokens) || 0;
    this.data.usage.requests += 1;
    try { this.save(); } catch (e) { console.error("assistant 사용량 저장 실패:", e.message); }
  }

  capReached(now = new Date()) {
    const cap = Number(this.data.monthly_token_cap) || 0;
    if (!cap) return false;
    const u = this.data.usage || {};
    if (u.month !== seoulMonth(now)) return false;
    return (u.prompt_tokens || 0) + (u.completion_tokens || 0) >= cap;
  }
}

module.exports = { AssistantStore, DEFAULTS, seoulMonth, isPrivateHost, hint };
