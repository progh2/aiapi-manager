// 개발용 흉내 LLM. 진짜 모델 없이 AI 엘피 화면을 돌려 보려고 낱말 규칙으로 도구를 부르고 답한다.
// Ollama(/api/tags·/api/show·/api/chat)와 OpenAI 호환(/v1/models·/v1/chat/completions)을 흉내 낸다.
// 배포에 쓰지 않는다. dev-mock.js 가 띄운다.
const http = require("http");
const crypto = require("crypto");

const OLLAMA_MODELS = [
  { name: "qwen3:8b", size: 5.2e9, details: { family: "qwen3", parameter_size: "8.2B", quantization_level: "Q4_K_M" }, caps: ["completion", "tools", "thinking"] },
  { name: "qwen3:14b", size: 9.3e9, details: { family: "qwen3", parameter_size: "14.8B", quantization_level: "Q4_K_M" }, caps: ["completion", "tools", "thinking"] },
  { name: "gpt-oss:20b", size: 13.8e9, details: { family: "gptoss", parameter_size: "20.9B", quantization_level: "MXFP4" }, caps: ["completion", "tools", "thinking"] },
  { name: "llama3.2:3b", size: 2.0e9, details: { family: "llama", parameter_size: "3.2B", quantization_level: "Q4_K_M" }, caps: ["completion", "tools"] },
  { name: "gemma3:4b", size: 3.3e9, details: { family: "gemma3", parameter_size: "4.3B", quantization_level: "Q4_K_M" }, caps: ["completion", "vision"] },
];
const OPENAI_MODELS = ["gpt-4.1-mini", "gpt-4o-mini", "gpt-5-mini", "gpt-5-nano", "gpt-4.1", "text-embedding-3-small", "whisper-1"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const callId = () => `call_${crypto.randomBytes(5).toString("hex")}`;

// ---------------------------------------------------------------- 낱말 규칙 두뇌
function classNames(system) {
  const line = /학급\/조 \d+개: (.*)/.exec(system || "");
  if (!line) return [];
  return [...line[1].matchAll(/([^·()]+?)\(/g)].map((m) => m[1].trim()).filter(Boolean);
}

function findClass(q, system) {
  const names = classNames(system).sort((a, b) => b.length - a.length);
  const compact = q.replace(/\s+/g, "");
  return names.find((n) => compact.includes(n.replace(/\s+/g, ""))) || names.find((n) => /[A-Z]반$/.test(n) && compact.includes(n.slice(-2))) || null;
}

function findName(q) {
  const m = /([가-힣]{2,4}|학생\d{2,3})\s*(?:학생)?\s*(?:의\s*)?키/.exec(q);
  const stop = /^(소진|임박|만료|차단|전체|모든|학급|예산|캠프|이|그|저|내|우리)/;
  return m && !stop.test(m[1]) ? m[1] : null;
}

function amountOf(q) {
  const m = /\$\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:달러|불|usd)/i.exec(q);
  return m ? Number(m[1] || m[2]) : null;
}

function stateOf(q) {
  if (/소진|다 쓴|바닥/.test(q)) return "over";
  if (/임박|80|거의/.test(q)) return "warn";
  if (/만료\s*(임박|예정|곧)|곧 만료/.test(q)) return "expiring";
  if (/만료/.test(q)) return "expired";
  if (/차단된|막힌/.test(q)) return "blocked";
  return null;
}

function screenOf(q) {
  const map = [[/사용량|그래프|텔레메트리/, "telemetry"], [/키 ?관리|키 목록|키들|키를? 보여/, "keys"], [/학급|반 목록/, "classes"], [/발급/, "launch"], [/공급자/, "engines"], [/사용자|계정/, "crew"], [/기록|로그|호출/, "log"], [/개요|처음/, "bridge"]];
  const hit = map.find(([re]) => re.test(q));
  return hit ? hit[1] : "bridge";
}

function decide(q, system, tools) {
  const has = (n) => tools.includes(n);
  const cls = findClass(q, system);
  const name = findName(q);
  const state = stateOf(q);
  const target = { ...(cls ? { class: cls } : {}), ...(name ? { aliases: [name] } : {}), ...(state && state !== "blocked" ? { state } : {}) };
  const amount = amountOf(q);
  const days = (/(\d+)\s*일\s*(?:더|연장|늘)/.exec(q) || [])[1];

  if (has("propose_lockdown") && /봉쇄/.test(q) && cls) return { name: "propose_lockdown", arguments: { class: cls, action: /해제|풀/.test(q) ? "unlock" : "lock", reason: (/(시험|고사|평가|대회)/.exec(q) || [])[1] } };
  if (has("propose_class_budget") && /학급\s*예산/.test(q) && cls && amount != null && /(바꿔|올려|늘려|설정|로)/.test(q)) return { name: "propose_class_budget", arguments: { class: cls, budget: amount } };
  if (has("propose_topup") && /(충전|올려|채워|연장)/.test(q)) {
    if (!Object.keys(target).length) return { ask: "어느 학급이나 어떤 키를 충전할까요? 예: \"3학년A반 소진된 키에 2달러 충전해 줘\"" };
    if (amount == null && !days) return { ask: "키마다 얼마를 더 넣을까요? 예: \"2달러씩\"" };
    return { name: "propose_topup", arguments: { target, ...(amount != null ? { add_budget: amount } : {}), ...(days ? { add_days: Number(days) } : {}) } };
  }
  if (has("propose_block_keys") && /(막아|차단|풀어|해제)/.test(q) && (cls || name)) {
    return { name: "propose_block_keys", arguments: { action: /(풀어|해제)/.test(q) ? "unblock" : "block", target: { ...(cls ? { class: cls } : {}), ...(name ? { aliases: [name] } : {}) } } };
  }
  if (has("open_screen") && /(보여|열어|이동|가 ?줘)/.test(q) && !/(왜|요약|상황)/.test(q)) {
    const screen = screenOf(q);
    return { name: "open_screen", arguments: { screen, ...(screen === "keys" && state ? { filter: state } : {}), ...(cls && (screen === "keys" || screen === "classes") ? { class: cls } : {}) } };
  }
  if (has("recent_calls") && /(왜|실패|막혔|안 ?돼|오류|에러)/.test(q)) return { name: "recent_calls", arguments: { only_failed: true, ...(cls ? { class: cls } : {}), ...(name ? { alias: name } : {}) } };
  if (has("usage_report") && /(사용량|얼마나 썼|예측|추이|많이 쓴|비용|지출)/.test(q)) return { name: "usage_report", arguments: { days: 30, ...(cls ? { class: cls } : {}) } };
  if (has("list_providers") && /(공급자|잔액|openai 키)/i.test(q)) return { name: "list_providers", arguments: {} };
  if (has("recent_admin_actions") && /(누가|작업 기록|최근 작업)/.test(q)) return { name: "recent_admin_actions", arguments: {} };
  if (has("find_keys") && state) return { name: "find_keys", arguments: { state, ...(cls ? { class: cls } : {}) } };
  if (has("list_classes") && cls && /(어때|상태|알려)/.test(q)) return { name: "list_classes", arguments: { name: cls } };
  // 학생
  if (has("my_recent_calls") && /(왜|실패|안 ?돼|오류|막)/.test(q)) return { name: "my_recent_calls", arguments: { only_failed: true } };
  if (has("connection_guide") && /(코드|base_url|파이썬|python|연결|사용법|어떻게 써)/i.test(q)) return { name: "connection_guide", arguments: {} };
  if (has("my_keys") && /(예산|남았|만료|언제|키|시간)/.test(q)) return { name: "my_keys", arguments: {} };
  return null;
}

const ADVICE = {
  "예산 초과": "키 예산을 조금 충전하면 바로 풀려요",
  "학급 예산 초과": "학급 예산을 늘리거나 다음 초기화를 기다려야 해요",
  "수업 시간대 밖": "학급 시간표 밖이라 막힌 거예요. 필요하면 시간표를 넓혀 주세요",
  "차단된 키": "키 차단을 풀어 주면 돼요",
  "허용 안 된 모델": "학생이 허용되지 않은 모델 이름을 썼어요. 키에 모델을 추가하거나 학생 코드를 고치게 하세요",
  "만료된 키": "만료일을 연장해 주세요",
  "속도 제한(RPM/TPM)": "잠깐 쉬었다 다시 보내면 돼요",
};

function compose(results, question) {
  const out = [];
  for (const { name, data } of results) {
    if (data && data.error) { out.push(`확인해 보니 이런 문제가 있어요: ${data.error}`); continue; }
    if (name === "get_overview") out.push(`지금 경보는 ${data.alerts.length}건이고, 키는 ${data.keys.total}개 중 ${data.keys.active}개가 쓸 수 있어요.`);
    else if (name === "find_keys") {
      out.push(`조건에 맞는 키가 **${data.count}개** 있어요.`);
      for (const k of data.keys.slice(0, 5)) out.push(`- ${k.alias} · ${k.state} · ${k.spend} / ${k.budget}`);
    } else if (name === "recent_calls" || name === "my_recent_calls") {
      if (!data.failed) out.push(`최근 호출 ${data.total}건 중 실패한 건 없어요.`);
      else {
        out.push(`최근 호출 중 **${data.failed}건**이 실패했어요.`);
        for (const r of data.top_reasons.slice(0, 3)) out.push(`- ${r.reason} ${r.count}건${ADVICE[r.reason] ? ` → ${ADVICE[r.reason]}` : ""}`);
      }
    } else if (name === "usage_report") {
      out.push(`최근 ${data.days}일 동안 **${data.total_spend}**를 썼고, 요즘 하루 평균은 ${data.daily_avg_last7}예요.`);
      if (data.forecast_next_14d) out.push(`지금 속도면 앞으로 2주 동안 ${data.forecast_next_14d} 정도 더 쓸 것 같아요.`);
      if (data.top_classes && data.top_classes[0]) out.push(`가장 많이 쓴 학급은 ${data.top_classes[0].class}(${data.top_classes[0].spend})예요.`);
      if (data.soonest_exhaust && data.soonest_exhaust.days_left <= 30) out.push(`${data.soonest_exhaust.class} 예산은 약 ${data.soonest_exhaust.days_left}일 뒤 바닥날 수 있어요.`);
    } else if (name === "list_providers") {
      for (const p of data.providers.slice(0, 5)) out.push(`- ${p.name}: ${p.remaining == null ? p.budget : `잔액 ${p.remaining} / ${p.budget}`}`);
    } else if (name === "list_classes") {
      for (const c of data.classes.slice(0, 3)) out.push(`${c.class}은(는) 지금 **${c.session}**이고 ${c.spend} / ${c.budget} 썼어요 (키 ${c.keys}개).`);
    } else if (name === "open_screen") out.push(`${data.opened} 화면을 열었어요.`);
    else if (name === "recent_admin_actions") out.push(`최근 작업 ${data.entries.length}건을 확인했어요.${data.entries[0] ? ` 마지막은 ${data.entries[0].time} ${data.entries[0].action} (${data.entries[0].target})예요.` : ""}`);
    else if (data && data.proposal_shown) out.push(`**${data.title}** 제안 카드를 띄웠어요. ${String(data.summary || "").replace(/\.$/, "")}. 내용을 확인하고 [실행]을 눌러 주시면 진행할게요.`);
    else if (name === "my_keys") {
      for (const k of data.keys) out.push(`- ${k.alias}: ${k.spend} / ${k.budget}${k.expires ? `, 만료 ${k.expires}` : ""}${k.usable_now ? " · 지금 쓸 수 있어요" : " · 지금은 쓸 수 없어요"}`);
    } else if (name === "connection_guide") out.push(`코드에서 base_url 을 **${data.base_url}** 로 두고, 모델은 ${data.models.join(", ") || "gpt-4o-mini"} 중에서 쓰면 돼요.`);
  }
  if (!out.length) out.push(`"${question}"에 대해 확인해 봤지만 특별한 게 없어요.`);
  return out.join("\n");
}

function fromSnapshot(system, question) {
  const pick = (label) => (new RegExp(`- ${label}[^\\n]*`).exec(system) || [""])[0].replace(/^- /, "");
  if (/\[내 키 요약\]/.test(system)) {
    const mine = (/\[내 키 요약\]\n([\s\S]*?)\n\n/.exec(system) || [])[1] || "";
    return `안녕하세요! 제가 볼 수 있는 내 키 상태예요.\n${mine}\n"왜 호출이 안 돼?"나 "코드에 어떻게 써?"처럼 물어봐 주세요.`;
  }
  if (/안녕|반가|누구/.test(question)) return "안녕하세요, AI 엘피예요! 키·학급·사용량 상황을 요약하거나, 충전·차단·봉쇄를 제안 카드로 준비해 드려요. 무엇을 도와드릴까요?";
  return `지금 상황을 정리해 드릴게요.\n- ${pick("경보")}\n- ${pick("키")}\n- ${pick("최근 24시간 호출")}\n더 자세히 볼 학급이나 키를 말씀해 주세요.`;
}

function brain(messages, tools) {
  const names = (tools || []).map((t) => (t.function ? t.function.name : t.name));
  const system = (messages.find((m) => m.role === "system") || {}).content || "";
  let lastUser = -1;
  messages.forEach((m, i) => { if (m.role === "user") lastUser = i; });
  const question = lastUser >= 0 ? String(messages[lastUser].content || "") : "";
  const after = messages.slice(lastUser + 1);
  // OpenAI 규격의 도구 결과에는 이름이 없어 앞선 호출 id 로 찾는다.
  const idToName = new Map();
  for (const m of messages) for (const c of m.tool_calls || []) if (c.id) idToName.set(c.id, c.function ? c.function.name : c.name);
  if (/도구는 더 부르지 마세요/.test(question) || after.some((m) => m.role === "tool")) {
    const results = messages.filter((m, i) => m.role === "tool" && i > (/도구는 더 부르지 마세요/.test(question) ? 0 : lastUser)).map((m) => {
      let data = null;
      try { data = JSON.parse(m.content); } catch { data = { error: m.content }; }
      return { name: m.name || m.tool_name || idToName.get(m.tool_call_id) || "", data };
    });
    const q = /도구는 더 부르지 마세요/.test(question) ? String((messages.filter((m) => m.role === "user").at(-2) || {}).content || "") : question;
    return { content: compose(results, q) };
  }
  if (names.includes("get_time")) return { tool: { name: "get_time", arguments: { city: "서울" } } };
  if (/인사/.test(question)) return { content: "안녕하세요, AI 엘피예요! 오늘도 수업 운영을 든든하게 도와드릴게요." };
  const d = names.length ? decide(question, system, names) : null;
  if (d && d.ask) return { content: d.ask };
  if (d) return { tool: { name: d.name, arguments: Object.fromEntries(Object.entries(d.arguments).filter(([, v]) => v !== undefined)) } };
  return { content: fromSnapshot(system, question) };
}

const tokens = (messages) => Math.round(JSON.stringify(messages).length / 3);

// ---------------------------------------------------------------- HTTP
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function openaiReply(body) {
  const out = brain(body.messages || [], body.tools);
  const message = out.tool
    ? { role: "assistant", content: null, tool_calls: [{ id: callId(), type: "function", function: { name: out.tool.name, arguments: JSON.stringify(out.tool.arguments) } }] }
    : { role: "assistant", content: out.content };
  return {
    id: `chatcmpl-${crypto.randomBytes(4).toString("hex")}`,
    object: "chat.completion",
    model: body.model,
    choices: [{ index: 0, message, finish_reason: out.tool ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: tokens(body.messages), completion_tokens: out.tool ? 25 : Math.round(String(out.content).length / 2) },
  };
}

function createFakeLlm({ delay = [350, 900] } = {}) {
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", async () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: "bad json" }); }
      const p = new URL(req.url, "http://llm").pathname;
      if (p === "/api/tags") return send(res, 200, { models: OLLAMA_MODELS.map(({ caps, ...m }) => ({ ...m, model: m.name })) });
      if (p === "/api/show") {
        const m = OLLAMA_MODELS.find((x) => x.name === body.model);
        return m ? send(res, 200, { capabilities: m.caps, details: m.details }) : send(res, 404, { error: `model '${body.model}' not found` });
      }
      if (p === "/api/chat") {
        const m = OLLAMA_MODELS.find((x) => x.name === body.model);
        if (!m) return send(res, 404, { error: `model '${body.model}' not found` });
        if (body.tools && body.tools.length && !m.caps.includes("tools")) return send(res, 400, { error: `registry.ollama.ai/library/${m.name} does not support tools` });
        await sleep(delay[0] + Math.random() * (delay[1] - delay[0]));
        const out = brain(body.messages || [], body.tools);
        return send(res, 200, {
          model: m.name,
          message: out.tool ? { role: "assistant", content: "", tool_calls: [{ function: { name: out.tool.name, arguments: out.tool.arguments } }] } : { role: "assistant", content: out.content },
          done: true,
          prompt_eval_count: tokens(body.messages),
          eval_count: out.tool ? 20 : Math.round(String(out.content).length / 2),
        });
      }
      const auth = String(req.headers.authorization || "");
      if (p.startsWith("/v1/") && (!auth.startsWith("Bearer sk-") || auth === "Bearer sk-bad")) {
        return send(res, 401, { error: { message: "Incorrect API key provided", type: "invalid_request_error" } });
      }
      if (p === "/v1/models") return send(res, 200, { data: OPENAI_MODELS.map((id) => ({ id, object: "model" })) });
      if (p === "/v1/chat/completions") {
        await sleep(delay[0] + Math.random() * (delay[1] - delay[0]));
        return send(res, 200, openaiReply(body));
      }
      send(res, 404, { error: "not found" });
    });
  });
}

module.exports = { createFakeLlm, brain, openaiReply };
