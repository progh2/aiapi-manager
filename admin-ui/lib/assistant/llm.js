// AI 엘피가 쓰는 언어 모델 연결. OpenAI(/v1/responses·/v1/chat/completions)와 Ollama(/api/chat).
// 안에서는 메시지를 한 모양으로 다룬다:
//   { role: "system" | "user" | "assistant", content }
//   { role: "assistant", content, tool_calls: [{ id, name, arguments: {} }] }
//   { role: "tool", tool_call_id, name, content }
// 오류 문구에 API 키를 넣지 않는다.
const crypto = require("crypto");

const DEFAULT_TIMEOUT_MS = 180000;
const LIST_TIMEOUT_MS = 15000;

class LlmError extends Error {
  constructor(message, { status = 502, code = "llm_error" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function scrub(text) {
  return String(text || "")
    .replace(/sk-[A-Za-z0-9_\-*.]{4,}/g, "sk-…")
    .replace(/Bearer\s+\S+/gi, "Bearer …")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function trimSlash(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

// 주소에 경로가 없으면 OpenAI 호환 서버의 기본 경로 /v1 을 붙인다.
function openaiBase(url) {
  const s = trimSlash(url);
  if (!s) return "https://api.openai.com/v1";
  try {
    const u = new URL(s);
    if (!u.pathname || u.pathname === "/") return `${s}/v1`;
  } catch {
    /* 주소 검사는 저장할 때 한다 */
  }
  return s;
}

function ollamaRoot(url) {
  return trimSlash(url).replace(/\/v1$/i, "").replace(/\/api$/i, "");
}

// o 시리즈와 gpt-5 이후(gpt-5.x·gpt-6 …)는 추론 모델이다. temperature 를 받지 않고, 출력 한도에 추론 토큰이 들어간다.
// "-chat" 판은 추론하지 않는다.
function isReasoningModel(model) {
  const id = String(model || "").split("/").pop().toLowerCase();
  if (/^o\d/.test(id)) return true;
  const m = /^gpt-(\d+)/.exec(id);
  return Boolean(m && Number(m[1]) >= 5 && !/-chat(-latest)?$/.test(id));
}

function connectionFrom(cfg, { proxyBase = "" } = {}) {
  if (cfg.mode === "proxy") {
    return { kind: "openai", flavor: "proxy", base: `${trimSlash(proxyBase)}/v1`, apiKey: cfg.proxy_key || "", model: cfg.proxy_model };
  }
  if (cfg.provider === "ollama") {
    return { kind: "ollama", flavor: "ollama", base: ollamaRoot(cfg.base_url), apiKey: cfg.api_key || "", model: cfg.model };
  }
  if (cfg.provider === "openai") {
    return { kind: "openai", flavor: "openai", base: "https://api.openai.com/v1", apiKey: cfg.api_key || "", model: cfg.model };
  }
  return { kind: "openai", flavor: "compatible", base: openaiBase(cfg.base_url), apiKey: cfg.api_key || "", model: cfg.model };
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url || "모델 서버"); }
}

function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function classify(status, message, conn) {
  const msg = scrub(message);
  // GPT-5.x·GPT-6: "Function tools with reasoning_effort are not supported … use /v1/responses …",
  // "This model is only supported in v1/responses and not in v1/chat/completions."
  if (status >= 400 && status < 500 && /(use|only supported in|supported only in)\s+(the\s+)?\/?v1\/responses|responses api only/i.test(msg)) {
    return new LlmError(`이 모델은 Responses API(/v1/responses)로 불러야 합니다: ${msg}`, { status: 400, code: "use_responses" });
  }
  if (/does not support tools|tools? (are|is)? ?not supported|not support(ed)? (function|tool)|tool_choice|function.?calling (is )?not/i.test(msg)) {
    return new LlmError(`이 모델은 도구 호출을 지원하지 않습니다: ${msg}`, { status: 400, code: "tools_unsupported" });
  }
  if (/does not support thinking|think.*not supported/i.test(msg)) {
    return new LlmError(msg, { status: 400, code: "think_unsupported" });
  }
  if (status === 401 || status === 403) {
    return new LlmError(`API 키가 거부되었습니다 (HTTP ${status}). 키가 맞는지, 결제·권한이 켜져 있는지 확인하세요.`, { status: 502, code: "auth" });
  }
  if (status === 404 || /not found|does not exist|no such model/i.test(msg)) {
    const pull = conn && conn.kind === "ollama" ? ` 모델이 없다면 Ollama PC 에서 \`ollama pull ${conn.model}\` 로 받으세요.` : "";
    return new LlmError(`모델을 찾을 수 없습니다 (${msg || `HTTP ${status}`}).${pull}`, { status: 502, code: "model_not_found" });
  }
  if (status === 429) {
    return new LlmError(`요청 한도를 넘었거나 크레딧이 부족합니다 (HTTP 429). ${msg}`, { status: 429, code: "rate_limit" });
  }
  if (/context|too long|maximum.*tokens|num_ctx/i.test(msg) && status === 400) {
    return new LlmError(`대화가 모델의 문맥 길이를 넘었습니다. 새 대화를 시작하거나 문맥 길이를 늘리세요. (${msg})`, { status: 400, code: "context_length" });
  }
  return new LlmError(`모델 서버 오류 (HTTP ${status})${msg ? `: ${msg}` : ""}`, { status: 502, code: "server" });
}

async function request(conn, path, { method = "GET", body, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = `${conn.base}${path}`;
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (conn.apiKey) headers.Authorization = `Bearer ${conn.apiKey}`;
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: withTimeout(signal, timeoutMs),
    });
  } catch (e) {
    if (signal && signal.aborted) throw new LlmError("요청을 취소했습니다", { status: 499, code: "aborted" });
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw new LlmError(`모델 응답이 ${Math.round(timeoutMs / 1000)}초 안에 오지 않았습니다. 더 작은 모델이나 GPU 가 있는 PC 를 쓰세요.`, { status: 504, code: "timeout" });
    }
    const code = (e.cause && (e.cause.code || e.cause.name)) || e.code || "";
    const hint = conn.kind === "ollama"
      ? " Ollama PC 에서 OLLAMA_HOST=0.0.0.0 으로 띄웠는지, 방화벽이 11434 포트를 막지 않는지 확인하세요."
      : " 주소와 인터넷 연결을 확인하세요.";
    throw new LlmError(`${hostOf(url)} 에 연결하지 못했습니다${code ? ` (${code})` : ""}.${hint}`, { status: 502, code: "unreachable" });
  }
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!resp.ok) {
    const raw = data && (typeof data.error === "string" ? data.error : data.error && data.error.message) || data && data.message || text;
    const err = classify(resp.status, raw, conn);
    // 모델이 받지 않는 매개변수(예: temperature)는 빼고 다시 물을 수 있게 남긴다.
    err.param = (data && data.error && typeof data.error === "object" && data.error.param) || null;
    err.detail = scrub(raw);
    throw err;
  }
  if (data == null) throw new LlmError(`모델 서버가 JSON 이 아닌 응답을 보냈습니다: ${scrub(text).slice(0, 80)}`, { code: "bad_response" });
  return data;
}

// ---------------------------------------------------------------- 메시지 변환
function newCallId() {
  return `call_${crypto.randomBytes(6).toString("hex")}`;
}

function parseArgs(raw) {
  if (raw && typeof raw === "object") return raw;
  const s = String(raw || "").trim();
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return { __invalid: s.slice(0, 200) };
  }
}

function toOpenAi(m) {
  if (m.role === "assistant" && m.tool_calls && m.tool_calls.length) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) } })),
    };
  }
  if (m.role === "tool") return { role: "tool", tool_call_id: m.tool_call_id, content: String(m.content ?? "") };
  return { role: m.role, content: String(m.content ?? "") };
}

function toOllama(m) {
  if (m.role === "assistant" && m.tool_calls && m.tool_calls.length) {
    return {
      role: "assistant",
      content: m.content || "",
      tool_calls: m.tool_calls.map((c) => ({ function: { name: c.name, arguments: c.arguments || {} } })),
    };
  }
  if (m.role === "tool") return { role: "tool", content: String(m.content ?? ""), tool_name: m.name };
  return { role: m.role, content: String(m.content ?? "") };
}

function toolSpecs(tools) {
  return (tools || []).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters || { type: "object", properties: {} } },
  }));
}

// 생각 과정(<think>…</think>)은 답에서 뺀다.
function stripThinking(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}

// 작은 모델이나 설정이 덜 된 서버는 도구 호출을 글로 적어 보낸다. 아는 도구 이름일 때만 호출로 본다.
function inlineToolCalls(text, toolNames) {
  const names = new Set(toolNames || []);
  if (!names.size) return [];
  const found = [];
  const push = (obj) => {
    if (!obj || typeof obj !== "object") return;
    const name = obj.name || (obj.function && obj.function.name);
    const args = obj.arguments ?? obj.parameters ?? (obj.function && obj.function.arguments);
    if (names.has(name)) found.push({ id: newCallId(), name, arguments: parseArgs(args) });
  };
  const tagged = [...String(text || "").matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)];
  for (const m of tagged) {
    try { push(JSON.parse(m[1])); } catch { /* 깨진 JSON 은 무시 */ }
  }
  if (found.length) return found;
  const body = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (body.startsWith("{") && body.endsWith("}")) {
    try { push(JSON.parse(body)); } catch { /* 글로 된 답 */ }
  }
  if (found.length) return found;
  // 파이썬처럼 적은 호출: propose_topup(target={"class": "3학년A반"}, add_budget=2)
  for (const m of String(text || "").matchAll(/(?:^|[\s`])([a-z_][a-z0-9_]*)\(([^()\n]*(?:\{[^\n]*\})?[^()\n]*)\)/gim)) {
    if (!names.has(m[1])) continue;
    const args = parseCallArgs(m[2]);
    if (args) found.push({ id: newCallId(), name: m[1], arguments: args });
  }
  return found;
}

// k=v 모양 인자를 JSON 으로 바꿔 읽는다. 따옴표 없는 키·작은따옴표·True/False 도 받는다.
function parseCallArgs(src) {
  const s = String(src || "").trim();
  if (!s) return {};
  const json = (s.startsWith("{") ? s : `{${s}}`)
    .replace(/'/g, '"')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*/g, '$1"$2":')
    .replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null");
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// 도구 호출 목록을 읽는다. 글로 적힌 호출을 찾았으면 그 글은 답에서 뺀다.
function readToolCalls(rawCalls, content, names) {
  const toolCalls = (rawCalls || []).map((c) => ({
    id: c.id || newCallId(),
    name: c.function && c.function.name,
    arguments: parseArgs(c.function && c.function.arguments),
  })).filter((c) => c.name);
  if (toolCalls.length) return { toolCalls, text: content };
  const inline = inlineToolCalls(content, names);
  return inline.length ? { toolCalls: inline, text: "" } : { toolCalls: [], text: content };
}

// 생각을 끌 수 없는 모델(예: Qwen3 "Thinking" 판)은 think:false 를 주면 추론 글이 답에 섞여 나온다.
// 한 번 그런 모델을 보면 기억해 두고 다음부터는 생각을 켠 채로 묻는다.
const thinkOnly = new Set();
const LEAK_RE = /^(okay|ok,|alright|so,|so the|let me|let's|we need|first,|hmm|the user|i need|i should|i will|wait,)/i;

function leakedThinking(msg) {
  const text = String((msg && msg.content) || "").trim();
  if (!text || (msg && msg.thinking)) return false;
  return /<\/think>/i.test(text) || LEAK_RE.test(text);
}

// ---------------------------------------------------------------- 대화
/**
 * 한 번 묻고 답을 받는다.
 * @returns {{ content: string, toolCalls: Array<{id,name,arguments}>, usage: {prompt_tokens, completion_tokens}, model: string, reasoning?: Array }}
 */
async function chat(conn, { messages, tools = [], maxTokens = 700, temperature = 0.3, numCtx = 8192, fast = true, signal, timeoutMs } = {}) {
  if (!conn || !conn.model) throw new LlmError("모델이 정해지지 않았습니다. AI 엘피 설정에서 모델을 고르세요.", { status: 400, code: "no_model" });
  const names = tools.map((t) => t.name);
  if (conn.kind === "ollama") {
    const body = {
      model: conn.model,
      messages: messages.map(toOllama),
      stream: false,
      keep_alive: "30m",
      options: { num_ctx: numCtx, temperature, num_predict: maxTokens + 2048 },
    };
    if (tools.length) body.tools = toolSpecs(tools);
    const key = `${conn.base}|${conn.model}`;
    if (fast && !thinkOnly.has(key)) {
      body.think = /gpt-oss/i.test(conn.model) ? "low" : false;
      if (body.think === false) body.options.num_predict = maxTokens;
    }
    const again = () => {
      delete body.think;
      body.options.num_predict = maxTokens + 2048;
      return request(conn, "/api/chat", { method: "POST", body, signal, timeoutMs });
    };
    let data;
    try {
      data = await request(conn, "/api/chat", { method: "POST", body, signal, timeoutMs });
    } catch (e) {
      if (e.code !== "think_unsupported") throw e;
      data = await again();
    }
    if (body.think === false && leakedThinking(data.message)) {
      thinkOnly.add(key);
      data = await again();
    }
    const msg = data.message || {};
    const content = stripThinking(msg.content);
    const { toolCalls, text } = readToolCalls(msg.tool_calls, content, names);
    return {
      content: text,
      toolCalls,
      usage: { prompt_tokens: Number(data.prompt_eval_count) || 0, completion_tokens: Number(data.eval_count) || 0 },
      model: data.model || conn.model,
    };
  }

  const opts = { messages, tools, maxTokens, temperature, fast, signal, timeoutMs, names };
  const key = `${conn.base}|${conn.model}`;
  // OpenAI 직접 연결은 Responses API 로 묻는다(새 모델의 도구 호출 + 추론이 여기서만 된다).
  if (conn.flavor === "openai" || responsesModels.has(key)) return chatResponses(conn, opts);
  if (noReasoningChat.has(key)) return chatCompletions(conn, { ...opts, effort: "none" });
  try {
    return await chatCompletions(conn, opts);
  } catch (e) {
    if (e.code !== "use_responses") throw e;
    try {
      const out = await chatResponses(conn, opts);
      responsesModels.add(key);
      return out;
    } catch (e2) {
      // 호환 서버에 /v1/responses 가 없으면 추론을 끄고(Chat Completions 가 도구를 허용하는 길) 다시 묻는다.
      if (!(e2.status === 404 || e2.status === 405 || e2.code === "model_not_found")) throw e2;
      noReasoningChat.add(key);
      return chatCompletions(conn, { ...opts, effort: "none" });
    }
  }
}

// OpenAI 는 GPT-5.x·GPT-6 부터 "도구 호출 + 추론"을 /v1/responses 에서만 받는다. 호환 서버·프록시는
// Chat Completions 로 묻다가 그런 오류가 나면 Responses 로 바꾸고, 바꾼 모델은 기억한다.
const responsesModels = new Set();
const noReasoningChat = new Set();

function unsupportedParam(e) {
  if (e.param) return String(e.param);
  const m = /unsupported (?:parameter|value)[^']*'([A-Za-z_.]+)'/i.exec(e.detail || "") || /'([A-Za-z_.]+)' is not supported/i.exec(e.detail || "");
  return m ? m[1] : null;
}

// 모델마다 받는 매개변수가 다르다(temperature·reasoning·max_tokens 등). 거절된 것만 빼거나 바꿔 다시 묻는다.
async function postAdaptive(conn, path, body, opts) {
  for (let tries = 0; ; tries++) {
    try {
      return await request(conn, path, { method: "POST", body, ...opts });
    } catch (e) {
      const p = tries < 3 && e.status !== 499 && e.code !== "use_responses" ? unsupportedParam(e) : null;
      const top = p && p.split(".")[0];
      if (!top || !(top in body) || ["model", "messages", "input", "tools"].includes(top)) throw e;
      if (top === "max_tokens") { body.max_completion_tokens = body.max_tokens; delete body.max_tokens; }
      else if (top === "max_completion_tokens") { body.max_tokens = body.max_completion_tokens; delete body.max_completion_tokens; }
      else delete body[top];
    }
  }
}

async function chatCompletions(conn, { messages, tools, maxTokens, temperature, fast, signal, timeoutMs, names, effort }) {
  const reasoning = isReasoningModel(conn.model);
  const limit = reasoning ? maxTokens + 3000 : maxTokens;
  const body = { model: conn.model, messages: messages.map(toOpenAi) };
  if (conn.flavor === "openai") body.max_completion_tokens = limit;
  else body.max_tokens = limit;
  if (!reasoning) body.temperature = temperature;
  else if (effort) body.reasoning_effort = effort;
  else if (fast) body.reasoning_effort = "low";
  if (tools.length) {
    body.tools = toolSpecs(tools);
    body.tool_choice = "auto";
  }
  const data = await postAdaptive(conn, "/chat/completions", body, { signal, timeoutMs });
  const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
  const rawContent = Array.isArray(msg.content)
    ? msg.content.map((p) => (typeof p === "string" ? p : p.text || "")).join("")
    : msg.content;
  const content = stripThinking(rawContent);
  const { toolCalls, text } = readToolCalls(msg.tool_calls, content, names);
  const usage = data.usage || {};
  return {
    content: text,
    toolCalls,
    usage: { prompt_tokens: Number(usage.prompt_tokens) || 0, completion_tokens: Number(usage.completion_tokens) || 0 },
    model: data.model || conn.model,
  };
}

// 안쪽 메시지 → Responses API 입력. 첫 system 은 instructions 로, 도구 호출은 function_call / function_call_output 항목으로.
function toResponsesInput(messages) {
  let instructions = "";
  const input = [];
  for (const m of messages) {
    if (m.role === "system") {
      if (!instructions) instructions = String(m.content || "");
      else input.push({ role: "developer", content: String(m.content || "") });
    } else if (m.role === "assistant" && m.tool_calls && m.tool_calls.length) {
      // 저장하지 않는(store:false) 대화에서는 추론 항목(암호화)을 함께 돌려줘야 모델이 앞 생각을 잇는다.
      const withReasoning = Array.isArray(m.reasoning) && m.reasoning.length > 0;
      if (withReasoning) input.push(...m.reasoning);
      if (m.content) input.push({ role: "assistant", content: String(m.content) });
      for (const c of m.tool_calls) {
        const item = { type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.arguments || {}) };
        if (withReasoning && c.item_id) item.id = c.item_id;
        input.push(item);
      }
    } else if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: m.tool_call_id, output: String(m.content ?? "") });
    } else {
      input.push({ role: m.role, content: String(m.content ?? "") });
    }
  }
  return { instructions, input };
}

async function chatResponses(conn, { messages, tools, maxTokens, temperature, fast, signal, timeoutMs, names }) {
  const reasoning = isReasoningModel(conn.model);
  const { instructions, input } = toResponsesInput(messages);
  // store:false — 학교 대화를 OpenAI 쪽에 남기지 않는다.
  const body = { model: conn.model, input, store: false, max_output_tokens: reasoning ? maxTokens + 3000 : maxTokens };
  if (instructions) body.instructions = instructions;
  if (tools.length) {
    // Responses API 의 함수 도구는 strict 가 기본이라 선택 인자가 있는 우리 스키마를 거절한다. 끈다.
    body.tools = tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters || { type: "object", properties: {} }, strict: false }));
    body.tool_choice = "auto";
  }
  if (reasoning) {
    body.reasoning = { effort: fast ? "low" : "medium" };
    body.include = ["reasoning.encrypted_content"];
  } else body.temperature = temperature;
  const data = await postAdaptive(conn, "/responses", body, { signal, timeoutMs });
  const items = Array.isArray(data.output) ? data.output : [];
  const calls = [];
  const kept = [];
  let text = "";
  for (const it of items) {
    if (it.type === "function_call" && it.name) {
      calls.push({ id: it.call_id || it.id || newCallId(), item_id: it.id, name: it.name, arguments: parseArgs(it.arguments) });
    } else if (it.type === "message") {
      text += (it.content || []).map((p) => (typeof p === "string" ? p : p.text || "")).join("");
    } else if (it.type === "reasoning" && it.encrypted_content) {
      kept.push(it);
    }
  }
  if (!text && typeof data.output_text === "string") text = data.output_text;
  const read = calls.length ? { toolCalls: calls, text: stripThinking(text) } : readToolCalls([], stripThinking(text), names);
  if (!read.toolCalls.length && !read.text && data.status === "incomplete") {
    const why = data.incomplete_details && data.incomplete_details.reason;
    throw new LlmError(`모델이 답을 끝내지 못했습니다${why ? ` (${why})` : ""}. 설정에서 답변 길이를 늘리거나 빠른 응답을 켜 보세요.`, { status: 502, code: "incomplete" });
  }
  const usage = data.usage || {};
  return {
    content: read.text,
    toolCalls: read.toolCalls,
    usage: { prompt_tokens: Number(usage.input_tokens) || 0, completion_tokens: Number(usage.output_tokens) || 0 },
    model: data.model || conn.model,
    reasoning: kept,
  };
}

// ---------------------------------------------------------------- 모델 목록
const OPENAI_SKIP = /(embed|whisper|tts|transcri|dall-e|moderation|image|audio|realtime|search|sora|davinci|babbage|instruct|computer-use|codex|deep-research|-diarize)/i;
const SNAPSHOT = /-\d{4}-\d{2}-\d{2}$|-\d{4}$/;

function parseParams(text) {
  const m = /([\d.]+)\s*([BM])/i.exec(String(text || ""));
  if (!m) return null;
  const n = Number(m[1]);
  return m[2].toUpperCase() === "M" ? n / 1000 : n;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function listModels(conn, { signal } = {}) {
  if (conn.kind === "ollama") {
    const data = await request(conn, "/api/tags", { signal, timeoutMs: LIST_TIMEOUT_MS });
    const models = (data.models || []).slice(0, 60);
    return mapLimit(models, 4, async (m) => {
      const id = m.name || m.model;
      const details = m.details || {};
      // 새 Ollama 는 목록에 capabilities 를 싣는다. 없으면 /api/show 로 묻는다.
      let caps = Array.isArray(m.capabilities) ? m.capabilities : null;
      if (!caps) {
        try {
          const info = await request(conn, "/api/show", { method: "POST", body: { model: id }, signal, timeoutMs: 8000 });
          caps = Array.isArray(info.capabilities) ? info.capabilities : null;
        } catch {
          caps = null;
        }
      }
      return {
        id,
        family: details.family || "",
        params: details.parameter_size || "",
        params_b: parseParams(details.parameter_size) ?? parseParams(id),
        quant: details.quantization_level || "",
        size_gb: m.size ? Math.round((m.size / 1e9) * 10) / 10 : null,
        tools: caps ? caps.includes("tools") : null,
        thinking: caps ? caps.includes("thinking") : null,
        vision: caps ? caps.includes("vision") : null,
      };
    });
  }
  const data = await request(conn, "/models", { signal, timeoutMs: LIST_TIMEOUT_MS });
  let ids = (data.data || data.models || []).map((m) => (typeof m === "string" ? m : m.id || m.name)).filter(Boolean);
  if (conn.flavor === "openai") {
    ids = ids.filter((id) => /^(gpt-|o\d|chatgpt-)/i.test(id) && !OPENAI_SKIP.test(id) && !SNAPSHOT.test(id));
  } else {
    ids = ids.filter((id) => !/(embed|whisper|tts|rerank)/i.test(id));
  }
  return [...new Set(ids)].sort().map((id) => ({
    id,
    tools: conn.flavor === "openai" ? !/^(chatgpt-|o1-mini|o1-preview|gpt-3\.5-turbo-instruct)/i.test(id) : null,
    params_b: conn.flavor === "openai" ? null : parseParams(id),
  }));
}

module.exports = {
  LlmError,
  leakedThinking,
  toResponsesInput,
  chat,
  listModels,
  connectionFrom,
  isReasoningModel,
  openaiBase,
  ollamaRoot,
  stripThinking,
  inlineToolCalls,
  parseArgs,
  scrub,
};
