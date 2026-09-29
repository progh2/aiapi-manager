const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const llm = require("./llm");

// 요청을 기록하고 정해 둔 응답을 돌려주는 가짜 모델 서버
function fakeServer(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const out = handler(req, body) || { status: 404, json: { error: "not found" } };
      res.writeHead(out.status || 200, { "Content-Type": "application/json" });
      res.end(typeof out.json === "string" ? out.json : JSON.stringify(out.json));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

const TOOLS = [{ name: "find_keys", description: "키 찾기", parameters: { type: "object", properties: { state: { type: "string" } } } }];

test("OpenAI 방식: 도구 명세를 보내고 도구 호출을 읽는다", async (t) => {
  const f = await fakeServer((req) => {
    if (req.url === "/v1/chat/completions") {
      return { json: {
        model: "gpt-4.1-mini",
        choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "find_keys", arguments: "{\"state\":\"over\"}" } }] } }],
        usage: { prompt_tokens: 120, completion_tokens: 15 },
      } };
    }
  });
  t.after(() => f.server.close());
  const conn = { kind: "openai", flavor: "compatible", base: `${f.base}/v1`, apiKey: "sk-test-secret", model: "gpt-4.1-mini" };
  const out = await llm.chat(conn, { messages: [{ role: "user", content: "소진 키?" }], tools: TOOLS, maxTokens: 500 });
  assert.deepEqual(out.toolCalls, [{ id: "call_1", name: "find_keys", arguments: { state: "over" } }]);
  assert.deepEqual(out.usage, { prompt_tokens: 120, completion_tokens: 15 });
  const req = f.seen[0];
  assert.equal(req.headers.authorization, "Bearer sk-test-secret");
  assert.equal(req.body.tools[0].type, "function");
  assert.equal(req.body.tools[0].function.name, "find_keys");
  assert.equal(req.body.tool_choice, "auto");
  assert.equal(req.body.max_tokens, 500);
  assert.equal(req.body.temperature, 0.3);
});

test("OpenAI 방식: 도구 결과 메시지를 규격대로 바꿔 보낸다", async (t) => {
  const f = await fakeServer(() => ({ json: { choices: [{ message: { content: "소진 키는 2개예요." } }], usage: {} } }));
  t.after(() => f.server.close());
  const conn = { kind: "openai", flavor: "openai", base: `${f.base}/v1`, apiKey: "k", model: "gpt-5-mini" };
  const out = await llm.chat(conn, {
    messages: [
      { role: "user", content: "소진 키?" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", name: "find_keys", arguments: { state: "over" } }] },
      { role: "tool", tool_call_id: "call_1", name: "find_keys", content: "{\"count\":2}" },
    ],
    tools: TOOLS,
    maxTokens: 700,
  });
  assert.equal(out.content, "소진 키는 2개예요.");
  const body = f.seen[0].body;
  assert.equal(body.messages[1].tool_calls[0].function.arguments, "{\"state\":\"over\"}");
  assert.equal(body.messages[1].content, null);
  assert.deepEqual(body.messages[2], { role: "tool", tool_call_id: "call_1", content: "{\"count\":2}" });
  // 추론형(gpt-5)은 temperature 를 빼고 max_completion_tokens 에 여유를 둔다
  assert.equal(body.temperature, undefined);
  assert.equal(body.max_completion_tokens, 3700);
  assert.equal(body.reasoning_effort, "low");
});

test("Ollama 방식: /api/chat 에 num_ctx·think 를 주고 객체 인자를 읽는다", async (t) => {
  const f = await fakeServer((req) => {
    if (req.url === "/api/chat") {
      return { json: {
        model: "qwen3:8b",
        message: { role: "assistant", content: "", tool_calls: [{ function: { name: "find_keys", arguments: { state: "warn" } } }] },
        prompt_eval_count: 900, eval_count: 30, done: true,
      } };
    }
  });
  t.after(() => f.server.close());
  const conn = llm.connectionFrom({ mode: "direct", provider: "ollama", base_url: `${f.base}/v1`, model: "qwen3:8b" });
  assert.equal(conn.base, f.base);
  const out = await llm.chat(conn, {
    messages: [
      { role: "system", content: "sys" },
      { role: "assistant", content: "", tool_calls: [{ id: "c0", name: "find_keys", arguments: { state: "over" } }] },
      { role: "tool", tool_call_id: "c0", name: "find_keys", content: "{}" },
      { role: "user", content: "임박 키?" },
    ],
    tools: TOOLS,
    numCtx: 16384,
  });
  assert.equal(out.toolCalls[0].name, "find_keys");
  assert.deepEqual(out.toolCalls[0].arguments, { state: "warn" });
  assert.match(out.toolCalls[0].id, /^call_/);
  assert.deepEqual(out.usage, { prompt_tokens: 900, completion_tokens: 30 });
  const body = f.seen[0].body;
  assert.equal(body.stream, false);
  assert.equal(body.options.num_ctx, 16384);
  assert.equal(body.think, false);
  assert.deepEqual(body.messages[1].tool_calls, [{ function: { name: "find_keys", arguments: { state: "over" } } }]);
  assert.deepEqual(body.messages[2], { role: "tool", content: "{}", tool_name: "find_keys" });
});

test("Ollama: 생각 기능이 없는 모델이면 think 를 빼고 다시 묻는다", async (t) => {
  let n = 0;
  const f = await fakeServer((req, body) => {
    n += 1;
    if (body.think !== undefined) return { status: 400, json: { error: "\"llama3.1:8b\" does not support thinking" } };
    return { json: { message: { content: "<think>음</think>안녕하세요!" }, prompt_eval_count: 1, eval_count: 2 } };
  });
  t.after(() => f.server.close());
  const conn = { kind: "ollama", base: f.base, model: "llama3.1:8b" };
  const out = await llm.chat(conn, { messages: [{ role: "user", content: "hi" }] });
  assert.equal(out.content, "안녕하세요!");
  assert.equal(n, 2);
});

test("도구를 지원하지 않는 모델 오류를 알아본다", async (t) => {
  const f = await fakeServer(() => ({ status: 400, json: { error: "registry.ollama.ai/library/gemma3:4b does not support tools" } }));
  t.after(() => f.server.close());
  const conn = { kind: "ollama", base: f.base, model: "gemma3:4b" };
  await assert.rejects(llm.chat(conn, { messages: [{ role: "user", content: "x" }], tools: TOOLS }), (e) => e.code === "tools_unsupported");
});

test("인증 오류·없는 모델은 한국어로 알리고 키를 드러내지 않는다", async (t) => {
  const f = await fakeServer((req) => (req.url.includes("chat")
    ? { status: 401, json: { error: { message: "Incorrect API key provided: sk-live-abcdefghijk" } } }
    : { status: 404, json: { error: "model 'qwen3:8b' not found" } }));
  t.after(() => f.server.close());
  const conn = { kind: "openai", flavor: "compatible", base: `${f.base}/v1`, apiKey: "sk-live-abcdefghijk", model: "m" };
  await assert.rejects(llm.chat(conn, { messages: [{ role: "user", content: "x" }] }), (e) => {
    assert.equal(e.code, "auth");
    assert.ok(!e.message.includes("abcdefghijk"));
    return true;
  });
  const oc = { kind: "ollama", base: f.base, model: "qwen3:8b" };
  await assert.rejects(llm.listModels(oc), (e) => e.code === "model_not_found" && /ollama pull qwen3:8b/.test(e.message));
});

test("연결이 안 되면 방화벽·OLLAMA_HOST 를 알려 준다", async () => {
  const conn = { kind: "ollama", base: "http://127.0.0.1:9", model: "qwen3:8b" };
  await assert.rejects(llm.chat(conn, { messages: [{ role: "user", content: "x" }] }), (e) => e.code === "unreachable" && /OLLAMA_HOST/.test(e.message));
});

test("응답이 늦으면 시간 초과로 끊는다", async (t) => {
  const server = http.createServer(() => { /* 답하지 않는다 */ });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const conn = { kind: "openai", flavor: "compatible", base: `http://127.0.0.1:${server.address().port}/v1`, model: "m" };
  await assert.rejects(llm.chat(conn, { messages: [{ role: "user", content: "x" }], timeoutMs: 300 }), (e) => e.code === "timeout");
});

test("Ollama 모델 목록에 크기와 도구 지원을 붙인다", async (t) => {
  const f = await fakeServer((req, body) => {
    if (req.url === "/api/tags") {
      return { json: { models: [
        { name: "qwen3:8b", size: 5.2e9, details: { family: "qwen3", parameter_size: "8.2B", quantization_level: "Q4_K_M" } },
        { name: "gemma3:4b", size: 3.3e9, details: { family: "gemma3", parameter_size: "4.3B" } },
      ] } };
    }
    if (req.url === "/api/show") {
      return { json: { capabilities: body.model === "qwen3:8b" ? ["completion", "tools", "thinking"] : ["completion", "vision"] } };
    }
  });
  t.after(() => f.server.close());
  const list = await llm.listModels({ kind: "ollama", base: f.base });
  assert.deepEqual(list.map((m) => [m.id, m.tools, m.params_b, m.size_gb]), [["qwen3:8b", true, 8.2, 5.2], ["gemma3:4b", false, 4.3, 3.3]]);
});

test("OpenAI 모델 목록은 대화 모델만 남긴다", async (t) => {
  const f = await fakeServer(() => ({ json: { data: ["gpt-4.1-mini", "gpt-4o-mini-2024-07-18", "text-embedding-3-small", "whisper-1", "gpt-5-mini", "chatgpt-4o-latest", "gpt-4o-realtime-preview", "dall-e-3", "o4-mini"].map((id) => ({ id })) } }));
  t.after(() => f.server.close());
  const list = await llm.listModels({ kind: "openai", flavor: "openai", base: `${f.base}/v1`, apiKey: "k" });
  assert.deepEqual(list.map((m) => m.id), ["chatgpt-4o-latest", "gpt-4.1-mini", "gpt-5-mini", "o4-mini"]);
  assert.equal(list.find((m) => m.id === "chatgpt-4o-latest").tools, false);
});

test("글로 적힌 도구 호출도 알아듣는다 (아는 도구만)", () => {
  const names = ["find_keys"];
  assert.deepEqual(llm.inlineToolCalls('<tool_call>{"name":"find_keys","arguments":{"state":"over"}}</tool_call>', names).map((c) => [c.name, c.arguments]), [["find_keys", { state: "over" }]]);
  assert.deepEqual(llm.inlineToolCalls('```json\n{"name":"find_keys","parameters":{"state":"warn"}}\n```', names).map((c) => c.arguments), [{ state: "warn" }]);
  assert.deepEqual(llm.inlineToolCalls('{"name":"rm_rf","arguments":{}}', names), []);
  assert.deepEqual(llm.inlineToolCalls("그냥 답입니다", names), []);
  // 작은 모델이 파이썬처럼 적은 호출
  const py = llm.inlineToolCalls('충전을 제안할게요.\n\nfind_keys(state="over", limit=5)\n\n카드를 눌러 주세요.', names);
  assert.deepEqual(py.map((c) => [c.name, c.arguments]), [["find_keys", { state: "over", limit: 5 }]]);
  assert.deepEqual(llm.inlineToolCalls("find_keys(target={class: '3학년A반'}, only=True)", names)[0].arguments, { target: { class: "3학년A반" }, only: true });
  assert.deepEqual(llm.inlineToolCalls("print(x) 와 rm(y)", names), []);
});

test("주소 정리와 추론형 모델 판별", () => {
  assert.equal(llm.openaiBase("http://192.168.0.5:1234"), "http://192.168.0.5:1234/v1");
  assert.equal(llm.openaiBase("https://openrouter.ai/api/v1/"), "https://openrouter.ai/api/v1");
  assert.equal(llm.ollamaRoot("http://pc:11434/api/"), "http://pc:11434");
  assert.equal(llm.isReasoningModel("gpt-5-mini"), true);
  assert.equal(llm.isReasoningModel("pk_a/o4-mini"), true);
  assert.equal(llm.isReasoningModel("gpt-4.1-mini"), false);
  const proxy = llm.connectionFrom({ mode: "proxy", proxy_model: "gpt-4o-mini", proxy_key: "sk-a" }, { proxyBase: "http://litellm:4000/" });
  assert.deepEqual([proxy.base, proxy.apiKey, proxy.model], ["http://litellm:4000/v1", "sk-a", "gpt-4o-mini"]);
});

test("Ollama: 생각을 끌 수 없는 모델이면 생각을 켠 채 다시 묻고 기억한다", async (t) => {
  const bodies = [];
  const f = await fakeServer((req, body) => {
    bodies.push(body);
    if (body.think === false) return { json: { message: { content: "Okay, the user is asking for the time. Let me check" }, done_reason: "stop" } };
    return { json: { message: { content: "", thinking: "음…", tool_calls: [{ id: "call_x", function: { name: "find_keys", arguments: { state: "over" } } }] } } };
  });
  t.after(() => f.server.close());
  const conn = { kind: "ollama", base: f.base, model: "qwen3:30b-thinking" };
  const a = await llm.chat(conn, { messages: [{ role: "user", content: "소진 키?" }], tools: TOOLS, maxTokens: 300 });
  assert.equal(a.toolCalls[0].id, "call_x");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].think, undefined);
  assert.equal(bodies[1].options.num_predict, 2348);
  await llm.chat(conn, { messages: [{ role: "user", content: "또?" }], tools: TOOLS, maxTokens: 300 });
  assert.equal(bodies.length, 3);
  assert.equal(bodies[2].think, undefined, "두 번째부터는 think:false 를 보내지 않는다");
  assert.equal(llm.leakedThinking({ content: "안녕하세요!" }), false);
  assert.equal(llm.leakedThinking({ content: "음 </think>안녕" }), true);
  assert.equal(llm.leakedThinking({ content: "Okay, so", thinking: "x" }), false);
});

test("Ollama 목록에 capabilities 가 있으면 /api/show 를 부르지 않는다", async (t) => {
  const f = await fakeServer((req) => {
    if (req.url === "/api/tags") return { json: { models: [{ name: "gemma4:latest", size: 9.6e9, details: { parameter_size: "8.0B" }, capabilities: ["completion", "tools", "thinking"] }] } };
    return { status: 500, json: { error: "show 를 부르면 안 됩니다" } };
  });
  t.after(() => f.server.close());
  const list = await llm.listModels({ kind: "ollama", base: f.base });
  assert.equal(list[0].tools, true);
  assert.equal(f.seen.length, 1);
});
