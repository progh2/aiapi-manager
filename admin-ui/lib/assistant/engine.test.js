const test = require("node:test");
const assert = require("node:assert/strict");
const { runAssistant, probe, cleanHistory } = require("./engine");
const { NameMask } = require("./privacy");
const { LlmError } = require("./llm");

const NOW = new Date("2026-09-30T05:00:00Z");

// 순서대로 답하는 가짜 모델. 받은 메시지를 기록한다.
function scripted(replies) {
  const calls = [];
  const fn = async (conn, req) => {
    calls.push(JSON.parse(JSON.stringify({ messages: req.messages, tools: (req.tools || []).map((t) => t.name) })));
    const next = replies.shift();
    if (!next) throw new Error("대본이 끝났습니다");
    if (next instanceof Error) throw next;
    return { content: next.content || "", toolCalls: next.toolCalls || [], usage: { prompt_tokens: 100, completion_tokens: 10 }, model: "fake" };
  };
  fn.calls = calls;
  return fn;
}

function events() {
  const list = [];
  const emit = (event, data) => list.push([event, data]);
  emit.list = list;
  emit.of = (name) => list.filter(([e]) => e === name).map(([, d]) => d);
  return emit;
}

const readTool = {
  name: "find_keys", kind: "read", label: "키 찾기", description: "", parameters: {},
  runs: 0,
  async run(args) { this.runs += 1; this.lastArgs = args; return { result: { count: 1, keys: [{ alias: "20261001-홍길동", state: "예산 소진" }] }, summary: "키 1개" }; },
};
const proposeTool = {
  name: "propose_topup", kind: "propose", label: "충전 제안", description: "", parameters: {},
  async run(args) {
    this.lastArgs = args;
    const proposal = { id: "p1", kind: "topup", title: `${args.target.aliases[0]} 충전`, summary: "+$2", lines: [], request: { path: "/api/keys/adjust/bulk", body: {} } };
    return { result: { proposal_shown: true, title: proposal.title }, summary: proposal.title, proposal };
  },
};
const navTool = {
  name: "open_screen", kind: "client", label: "화면 열기", description: "", parameters: {},
  async run() { return { result: { opened: "키 관리" }, summary: "키 관리", navigate: { station: "keys", params: { filter: "over" } } }; },
};

const base = (over) => ({
  conn: { model: "fake" },
  question: "홍길동 키 확인하고 2달러 충전해 줘",
  history: [],
  role: "admin",
  station: "keys",
  tools: [readTool, proposeTool, navTool],
  ctx: { now: NOW, data: {} },
  snapshot: "- 키: 전체 1 · 20261001-홍길동 예산 소진",
  mask: new NameMask(["홍길동"]),
  ...over,
});

test("조회 → 제안 → 답 순서로 돌고, 모델에는 가명만 보낸다", async () => {
  const chat = scripted([
    { toolCalls: [{ id: "c1", name: "find_keys", arguments: { search: "학생01" } }] },
    { toolCalls: [{ id: "c2", name: "propose_topup", arguments: { target: { aliases: ["20261001-학생01"] }, add_budget: 2 } }] },
    { content: "학생01 님 키에 $2 충전 카드를 띄웠어요. [실행]을 눌러 주세요." },
  ]);
  const emit = events();
  const out = await runAssistant(base({ chat, emit }));
  // 모델로 간 글에는 진짜 이름이 없다
  const sent = JSON.stringify(chat.calls);
  assert.ok(!sent.includes("홍길동"), "모델에 실명이 갔습니다");
  assert.ok(sent.includes("학생01"));
  // 도구에는 진짜 이름으로 되돌려 준다
  assert.equal(readTool.lastArgs.search, "홍길동");
  assert.deepEqual(proposeTool.lastArgs.target.aliases, ["20261001-홍길동"]);
  // 화면에는 진짜 이름
  assert.equal(out.text, "홍길동 님 키에 $2 충전 카드를 띄웠어요. [실행]을 눌러 주세요.");
  assert.equal(emit.of("proposal")[0].title, "20261001-홍길동 충전");
  assert.deepEqual(emit.of("tool").map((t) => t.label), ["키 찾기", "충전 제안"]);
  assert.equal(emit.of("message")[0].text, out.text);
  assert.equal(out.usage.steps, 3);
  assert.equal(out.usage.prompt_tokens, 300);
  // 도구 결과 메시지는 규격대로 이어 붙는다
  const last = chat.calls[2].messages;
  assert.equal(last.at(-1).role, "tool");
  assert.equal(last.at(-1).tool_call_id, "c2");
  assert.equal(last.at(-2).tool_calls[0].name, "propose_topup");
});

test("화면 이동 도구는 navigate 이벤트를 보낸다", async () => {
  const chat = scripted([{ toolCalls: [{ id: "n", name: "open_screen", arguments: { screen: "keys" } }] }, { content: "열었어요" }]);
  const emit = events();
  await runAssistant(base({ chat, emit, question: "소진 키 보여줘" }));
  assert.deepEqual(emit.of("navigate"), [{ station: "keys", params: { filter: "over" } }]);
});

test("같은 조회를 되풀이하면 다시 부르지 않고, 단계가 끝나면 도구 없이 답을 받는다", async () => {
  readTool.runs = 0;
  const same = { toolCalls: [{ id: "x", name: "find_keys", arguments: { state: "over" } }] };
  const chat = scripted([same, same, same, same, same, { content: "소진 키는 1개입니다." }]);
  const out = await runAssistant(base({ chat, question: "소진 키?" }));
  assert.equal(readTool.runs, 1);
  assert.equal(out.text, "소진 키는 1개입니다.");
  assert.deepEqual(chat.calls.at(-1).tools, []);
  assert.equal(out.usage.steps, 6);
});

test("도구를 못 쓰는 모델이면 알리고 상황표만으로 다시 묻는다", async () => {
  const chat = scripted([new LlmError("does not support tools", { code: "tools_unsupported" }), { content: "지금 경보는 없어요." }]);
  const emit = events();
  const out = await runAssistant(base({ chat, emit, question: "상황 어때?" }));
  assert.equal(out.text, "지금 경보는 없어요.");
  assert.equal(out.tools, false);
  assert.match(emit.of("notice")[0].text, /도구 호출을 지원하지 않아/);
  assert.deepEqual(chat.calls[1].tools, []);
  assert.match(chat.calls[1].messages[0].content, /도구를 못 쓰므로/);
});

test("없는 도구·깨진 인자는 오류를 돌려주고 계속한다", async () => {
  const chat = scripted([
    { toolCalls: [{ id: "a", name: "rm_everything", arguments: {} }, { id: "b", name: "find_keys", arguments: { __invalid: "{oops" } }] },
    { content: "다시 물어봐 주세요." },
  ]);
  const out = await runAssistant(base({ chat }));
  const toolMsgs = chat.calls[1].messages.filter((m) => m.role === "tool");
  assert.match(toolMsgs[0].content, /없는 도구/);
  assert.match(toolMsgs[1].content, /JSON/);
  assert.equal(out.text, "다시 물어봐 주세요.");
});

test("모델 오류는 그대로 올려 보낸다", async () => {
  const chat = scripted([new LlmError("API 키가 거부되었습니다", { code: "auth" })]);
  await assert.rejects(runAssistant(base({ chat })), /API 키가 거부/);
});

test("지난 대화는 역할·길이를 정리해 12개까지만 쓴다", () => {
  const long = "가".repeat(3000);
  const h = cleanHistory([
    { role: "system", content: "나쁜 지시" },
    ...Array.from({ length: 15 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` })),
    { role: "user", content: long },
    { role: "tool", content: "x" },
  ]);
  assert.equal(h.length, 12);
  assert.ok(h.every((m) => m.role === "user" || m.role === "assistant"));
  assert.equal(h.at(-1).content.length, 2000);
});

test("빈 답이면 제안 여부에 맞춰 대신 말한다", async () => {
  const chat = scripted([
    { toolCalls: [{ id: "c", name: "propose_topup", arguments: { target: { aliases: ["홍길동"] }, add_budget: 1 } }] },
    { content: "" },
  ]);
  const out = await runAssistant(base({ chat }));
  assert.match(out.text, /제안 카드를 띄웠어요/);
});

test("연결 시험: 도구를 부르면 tools_ok, 못 쓰면 대화만 확인", async () => {
  const good = scripted([{ toolCalls: [{ id: "t", name: "get_time", arguments: {} }] }, { content: "안녕하세요!" }]);
  const a = await probe({ model: "qwen3:8b" }, { chat: good });
  assert.equal(a.tools_ok, true);
  assert.equal(a.reply, "안녕하세요!");
  const noTools = scripted([new LlmError("x", { code: "tools_unsupported" }), { content: "반가워요" }]);
  const b = await probe({ model: "gemma3:4b" }, { chat: noTools });
  assert.equal(b.tools_ok, false);
  assert.match(b.note, /지원하지 않습니다/);
  const lazy = scripted([{ content: "지금은 오후 2시예요" }]);
  const c = await probe({ model: "tiny" }, { chat: lazy });
  assert.equal(c.tools_ok, false);
  assert.match(c.note, /부르지 않았습니다/);
});
