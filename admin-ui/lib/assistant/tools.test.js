const test = require("node:test");
const assert = require("node:assert/strict");
const { ADMIN_TOOLS, USER_TOOLS, resolveTargets } = require("./tools");
const { createDataView } = require("./data");
const F = require("./facts");

const NOW = new Date("2026-09-30T05:00:00Z"); // 서울 수요일 14:00
const DAY = 86400000;
const TEAMS = [
  { team_id: "t-a", team_alias: "3학년A반", spend: 8.5, max_budget: 10, metadata: { aiapi_schedule: [{ days: [3], start: "13:00", end: "15:00" }] } },
  { team_id: "t-b", team_alias: "3학년B반", spend: 1, max_budget: 10, metadata: { aiapi_schedule: [{ days: [1], start: "09:00", end: "10:00" }] } },
  { team_id: "t-c", team_alias: "AI 동아리", spend: 0, max_budget: null, metadata: { aiapi_lockdown: { reason: "시험", keys: 1 } } },
];
const KEYS = [
  { token: "h1", key_alias: "20261001-홍길동", team_id: "t-a", spend: 2, max_budget: 2, models: ["gpt-4o-mini"] },
  { token: "h2", key_alias: "20261002-김철수", team_id: "t-a", spend: 1.7, max_budget: 2, expires: new Date(NOW.getTime() + 3 * DAY).toISOString() },
  { token: "h3", key_alias: "20261003-이영희", team_id: "t-a", spend: 0.2, max_budget: 2, blocked: true },
  { token: "h4", key_alias: "20261004-박민수", team_id: "t-b", spend: 0, max_budget: 2 },
  { token: "h5", key_alias: "20261005-최지우", team_id: "t-c", spend: 0, max_budget: 2, blocked: true, metadata: { aiapi_lockdown: { at: "x" } } },
  { token: "h6", key_alias: "20261001-홍길동-폐기", team_id: "t-a", spend: 0.5, max_budget: 2, blocked: true },
  { token: "h7", key_alias: "aiapi-assistant", spend: 0.1, max_budget: 5, metadata: { aiapi_system: "assistant" } },
];

function ctx(extra = {}) {
  return {
    now: NOW,
    proxyUrl: "http://192.168.0.10:4000",
    data: createDataView({
      keys: async () => KEYS,
      teams: async () => TEAMS,
      providers: async () => [{ id: "env", label: ".env 기본 키", builtin: true }, { id: "p1", label: "학교 OpenAI", max_budget: 20, remaining: 3 }],
      activity: async () => [
        { at: NOW.toISOString(), alias: "20261001-홍길동", team: "3학년A반", team_id: "t-a", model: "gpt-4o-mini", ok: false, reason: "예산 초과" },
        { at: NOW.toISOString(), alias: "20261002-김철수", team: "3학년A반", team_id: "t-a", model: "gpt-4o-mini", ok: true },
        { at: NOW.toISOString(), alias: "20261004-박민수", team: "3학년B반", team_id: "t-b", model: "gpt-4o-mini", ok: false, reason: "수업 시간대 밖" },
      ],
      audit: () => [{ at: NOW.toISOString(), actor: "teacher@school.kr", action: "key.adjust", target: "20261001-홍길동", detail: { via: "elfy" } }],
      myKeys: async () => KEYS.filter((k) => k.token === "h1"),
      myActivity: async () => [{ at: NOW.toISOString(), model: "gpt-4o-mini", ok: false, reason: "예산 초과" }],
      ...extra,
    }),
  };
}
const tool = (name, list = ADMIN_TOOLS) => list.find((t) => t.name === name);

test("키 상태는 화면과 같은 규칙으로 센다", () => {
  const c = F.keyCounts(KEYS, NOW);
  assert.deepEqual(c, { total: 5, active: 2, blocked: 1, locked: 1, over: 1, warn: 1, expired: 0, expiring_7d: 1, camp_today: 0 });
  assert.equal(F.sessionOf(TEAMS[0], NOW).label, "수업 중");
  assert.equal(F.sessionOf(TEAMS[1], NOW).label, "수업 외");
  assert.equal(F.sessionOf(TEAMS[2], NOW).label, "봉쇄 중");
});

test("상황표에 경보·학급·실패 이유가 들어간다", () => {
  const text = F.snapshotText({ keys: KEYS, teams: TEAMS, providers: [{ label: "학교 OpenAI", max_budget: 20, remaining: 3, spend: 17 }], activity: [{ ok: false, reason: "예산 초과" }] }, NOW);
  assert.match(text, /\[경보\] AI 동아리 봉쇄 중 \(시험\)/);
  assert.match(text, /\[주의\] 3학년A반 학급 예산 85% 사용/);
  assert.match(text, /공급자 "학교 OpenAI" 잔액 \$3\.00/);
  assert.match(text, /학교 OpenAI\(사용 \$17\.00 \/ 한도 \$20\.00\)/);
  assert.match(text, /3학년A반\(수업 중, \$8\.50\/\$10\.00, 키 3\)/);
  assert.match(text, /실패 1 \(예산 초과 1\)/);
});

test("대상 찾기: 학급·상태·이름으로 고르고 폐기·시스템 키는 뺀다", () => {
  const all = { keys: KEYS, teams: TEAMS };
  assert.deepEqual(resolveTargets({ class: "3학년 a반" }, all, NOW).keys.map((k) => k.token), ["h1", "h2", "h3"]);
  assert.deepEqual(resolveTargets({ class: "A반", state: "over" }, all, NOW).keys.map((k) => k.token), ["h1"]);
  assert.deepEqual(resolveTargets({ aliases: ["홍길동"] }, all, NOW).keys.map((k) => k.token), ["h1"]);
  assert.equal(resolveTargets({ class: "3학년A반" }, all, NOW).wholeClass, true);
  assert.throws(() => resolveTargets({ class: "3학년" }, all, NOW), /여러 개/);
  assert.throws(() => resolveTargets({ class: "5학년" }, all, NOW), /찾지 못했습니다/);
  assert.throws(() => resolveTargets({ aliases: ["없는사람"] }, all, NOW), /키를 찾지 못했습니다/);
  assert.throws(() => resolveTargets({}, all, NOW), /대상이 없습니다/);
  assert.throws(() => resolveTargets({ aliases: ["2026100"] }, all, NOW), /여러 개/);
});

test("충전 제안: 학급 전체면 team_id 로, 일부면 tokens 로 요청을 만든다", async () => {
  const whole = await tool("propose_topup").run({ target: { class: "3학년A반" }, add_budget: 2 }, ctx());
  assert.equal(whole.proposal.request.path, "/api/keys/adjust/bulk");
  assert.deepEqual(whole.proposal.request.body, { team_id: "t-a", add_budget: 2, add_days: undefined });
  assert.equal(whole.proposal.count, 3);
  assert.match(whole.proposal.summary, /합계 \$6\.00/);
  assert.equal(whole.result.proposal_shown, true);
  assert.match(whole.result.status, /아직 실행 전/);

  const some = await tool("propose_topup").run({ target: { class: "3학년A반", state: "over" }, add_budget: 1, add_days: 7 }, ctx());
  assert.deepEqual(some.proposal.request.body.tokens, ["h1"]);
  assert.match(some.proposal.lines[0], /\$2\.00 \/ \$2\.00 → \$3\.00/);
});

test("충전 제안: 금액이 없거나 너무 크면 거절하고, 큰 합계는 입력 확인을 요구한다", async () => {
  await assert.rejects(tool("propose_topup").run({ target: { class: "3학년A반" } }, ctx()), /add_budget/);
  await assert.rejects(tool("propose_topup").run({ target: { class: "3학년A반" }, add_budget: 500 }, ctx()), /0\.01~50/);
  const many = Array.from({ length: 30 }, (_, i) => ({ token: `m${i}`, key_alias: `2026${i}-학생`, team_id: "t-b", spend: 0, max_budget: 1 }));
  const big = await tool("propose_topup").run({ target: { class: "3학년B반" }, add_budget: 5 }, ctx({ keys: async () => many }));
  assert.equal(big.proposal.typed, "충전");
  assert.equal(big.proposal.lines.at(-1), "…외 22개");
});

test("차단 제안은 이미 막힌 키를 빼고, 해제 제안은 봉쇄 키를 봉쇄 해제로 안내한다", async () => {
  const block = await tool("propose_block_keys").run({ action: "block", target: { class: "3학년A반" } }, ctx());
  assert.deepEqual(block.proposal.request.body, { action: "block", tokens: ["h1", "h2"] });
  assert.equal(block.proposal.tone, "danger");
  await assert.rejects(tool("propose_block_keys").run({ action: "unblock", target: { class: "AI 동아리" } }, ctx()), /봉쇄 해제/);
  const unblock = await tool("propose_block_keys").run({ action: "unblock", target: { aliases: ["이영희"] } }, ctx());
  assert.deepEqual(unblock.proposal.request.body.tokens, ["h3"]);
});

test("봉쇄 제안은 입력 확인을 요구하고, 봉쇄 중이 아닌 학급의 해제는 거절한다", async () => {
  const lock = await tool("propose_lockdown").run({ class: "3학년A반", action: "lock", reason: "중간고사" }, ctx());
  assert.equal(lock.proposal.typed, "봉쇄");
  assert.deepEqual(lock.proposal.request, { path: "/api/teams/lockdown", body: { team_id: "t-a", action: "lock", reason: "중간고사" } });
  assert.equal(lock.proposal.count, 2);
  await assert.rejects(tool("propose_lockdown").run({ class: "AI 동아리", action: "lock" }, ctx()), /이미 봉쇄/);
  await assert.rejects(tool("propose_lockdown").run({ class: "3학년B반", action: "unlock" }, ctx()), /봉쇄 중이 아닙니다/);
  const unlock = await tool("propose_lockdown").run({ class: "AI 동아리", action: "unlock" }, ctx());
  assert.equal(unlock.proposal.count, 1);
});

test("학급 예산 변경 제안은 시간표를 그대로 실어 보낸다", async () => {
  const out = await tool("propose_class_budget").run({ class: "3학년A반", budget: 20 }, ctx());
  assert.deepEqual(out.proposal.request.body, { team_id: "t-a", alias: "3학년A반", budget: 20, schedule: TEAMS[0].metadata.aiapi_schedule });
  const low = await tool("propose_class_budget").run({ class: "3학년A반", budget: 5 }, ctx());
  assert.equal(low.proposal.tone, "warn");
  assert.match(low.proposal.lines.join(" "), /바로 막힙니다/);
});

test("조회 도구는 키 해시를 내보내지 않는다", async () => {
  const keys = await tool("find_keys").run({ class: "3학년A반" }, ctx());
  assert.equal(keys.result.count, 3);
  assert.ok(!JSON.stringify(keys.result).includes("\"h1\""));
  assert.equal(keys.result.keys[0].alias, "20261001-홍길동");
  const calls = await tool("recent_calls").run({ only_failed: true, class: "3학년A반" }, ctx());
  assert.equal(calls.result.total, 1);
  assert.equal(calls.result.calls[0].reason, "예산 초과");
  const audit = await tool("recent_admin_actions").run({}, ctx());
  assert.equal(audit.result.entries[0].by, "teacher");
  assert.equal(audit.result.entries[0].via, "엘피 제안");
  const over = await tool("get_overview").run({}, ctx());
  assert.equal(over.result.keys.total, 5);
  assert.equal(over.result.calls_24h.failed, 2);
});

test("화면 열기는 학급 이름을 id 로 바꿔 보낸다", async () => {
  const out = await tool("open_screen").run({ screen: "keys", class: "3학년B반", filter: "over" }, ctx());
  assert.deepEqual(out.navigate, { station: "keys", params: { team: "t-b", filter: "over" } });
  const log = await tool("open_screen").run({ screen: "log", tab: "audit" }, ctx());
  assert.deepEqual(log.navigate, { station: "log", params: { tab: "audit" } });
  await assert.rejects(tool("open_screen").run({ screen: "danger" }, ctx()), /screen/);
});

test("학생 도구는 자기 키만 보고 지금 쓸 수 있는지 알려 준다", async () => {
  const mine = await tool("my_keys", USER_TOOLS).run({}, ctx());
  assert.equal(mine.result.count, 1);
  assert.equal(mine.result.keys[0].alias, "20261001-홍길동");
  assert.equal(typeof mine.result.keys[0].usable_now, "boolean");
  const guide = await tool("connection_guide", USER_TOOLS).run({}, ctx());
  assert.equal(guide.result.base_url, "http://192.168.0.10:4000");
  assert.match(guide.result.python, /gpt-4o-mini/);
  assert.ok(!USER_TOOLS.some((t) => t.kind === "propose"));
});
