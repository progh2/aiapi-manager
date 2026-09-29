const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  explainFailure, toActivity, summarizeActivity, activityQuery, redact, rowsOf,
} = require("./activity");

function failRow(message, extra = {}) {
  return {
    request_id: "r1",
    api_key: "hash-1",
    status: "failure",
    startTime: "2026-09-29T01:02:03.000Z",
    metadata: { error_information: { error_message: message, error_class: extra.klass || "Exception" } },
  };
}

describe("실패 이유", () => {
  const cases = [
    ["지금은 이 키를 쓸 수 있는 시간이 아닙니다. 수업 시간대는 한국(서울) 시각 기준입니다.", "schedule"],
    ["Key is blocked. Update via `/key/unblock` if you're an admin.", "blocked"],
    ["Authentication Error - Expired Key. Key Expiry time 2026-09-01", "expired"],
    ["Budget has been exceeded! Current cost: 2.1, Max budget: 2.0", "budget"],
    ["Team=3A over budget. Spend=51, Budget=50", "team_budget"],
    ["ExceededBudget: User=provider:openai-a over budget. Spend=20.1, Budget=20", "provider_budget"],
    ["ExceededBudget: User=pool:class-mix over budget. Spend=5, Budget=5", "provider_budget"],
    ["key not allowed to access model. This key can only access models=['gpt-4o-mini']. Tried to access gpt-4o", "model_denied"],
    ["Authentication Error, Invalid proxy server token passed. Received API Key = sk-..., Key Hash (Token) =c8c2", "invalid_key"],
    ["Rate limit exceeded: Crossed RPM limit", "rate_limit"],
    ["AuthenticationError: OpenAIException - Incorrect API key provided: sk-test-*ummy", "provider_auth"],
    ["You exceeded your current quota, please check your plan and billing details", "provider_quota"],
    ["This model's maximum context length is 128000 tokens", "context_length"],
    ["Request timed out", "timeout"],
  ];
  for (const [msg, code] of cases) {
    it(`${code}: ${msg.slice(0, 40)}`, () => {
      assert.equal(explainFailure(failRow(msg)).reason_code, code);
    });
  }
  it("알 수 없는 오류는 오류 종류를 보여 준다", () => {
    const out = explainFailure(failRow("weird", { klass: "WeirdError" }));
    assert.equal(out.reason_code, "other");
    assert.equal(out.reason, "WeirdError");
  });
});

describe("호출 행 변환", () => {
  const keysByToken = new Map([["hash-1", { token: "hash-1", key_alias: "20261001-홍길동", team_id: "t1" }]]);
  const teamsById = new Map([["t1", { team_id: "t1", team_alias: "3학년A반" }]]);

  it("성공 행은 별칭·학급·모델·토큰·금액만 옮기고 본문은 버린다", () => {
    const out = toActivity({
      request_id: "r9",
      api_key: "hash-1",
      status: "success",
      model: "openai/gpt-4o-mini",
      model_group: "gpt-4o-mini",
      total_tokens: 812,
      prompt_tokens: 700,
      completion_tokens: 112,
      spend: 0.00042,
      startTime: "2026-09-29T01:00:00.000Z",
      endTime: "2026-09-29T01:00:01.250Z",
      messages: [{ role: "user", content: "비밀 과제" }],
      response: { choices: [] },
      metadata: {},
    }, { keysByToken, teamsById });
    assert.equal(out.alias, "20261001-홍길동");
    assert.equal(out.team, "3학년A반");
    assert.equal(out.model, "gpt-4o-mini");
    assert.equal(out.tokens, 812);
    assert.equal(out.duration_ms, 1250);
    assert.equal(out.ok, true);
    assert.equal("messages" in out, false);
    assert.equal("response" in out, false);
    assert.equal(JSON.stringify(out).includes("비밀 과제"), false);
  });

  it("삭제된 키도 로그 메타의 별칭으로 보인다", () => {
    const out = toActivity({
      api_key: "gone",
      status: "success",
      metadata: { user_api_key_alias: "CAMP-A7K2", user_api_key_team_alias: "캠프1일차" },
    });
    assert.equal(out.alias, "CAMP-A7K2");
    assert.equal(out.team, "캠프1일차");
  });

  it("실패 행은 이유와 가려진 오류 문구를 준다", () => {
    const out = toActivity(failRow("Incorrect API key provided: sk-proj-abcdef123456"), { keysByToken, teamsById });
    assert.equal(out.ok, false);
    assert.equal(out.reason_code, "provider_auth");
    assert.equal(out.error.includes("abcdef123456"), false);
  });
});

describe("요약과 질의", () => {
  it("성공·실패·금액·활동 키를 센다", () => {
    const s = summarizeActivity([
      { ok: true, spend: 0.001, tokens: 10, alias: "a" },
      { ok: true, spend: 0.002, tokens: 20, alias: "b" },
      { ok: false, reason_code: "budget", alias: "a" },
      { ok: false, reason_code: "budget", alias: "c" },
    ]);
    assert.equal(s.total, 4);
    assert.equal(s.failed, 2);
    assert.equal(s.active_keys, 3);
    assert.equal(s.by_reason.budget, 2);
    assert.equal(s.spend, 0.003);
  });

  it("v2 질의는 최신순·UTC 날짜·최대 100건이다", () => {
    const q = activityQuery({ limit: 500, hours: 2, now: new Date("2026-09-29T10:00:00Z"), modelGroup: "mix/gpt-4o-mini", status: "failure" });
    const u = new URL("http://x" + q);
    assert.equal(u.pathname, "/spend/logs/v2");
    assert.equal(u.searchParams.get("page_size"), "100");
    assert.equal(u.searchParams.get("sort_order"), "desc");
    assert.equal(u.searchParams.get("start_date"), "2026-09-29 08:00:00");
    assert.equal(u.searchParams.get("model_group"), "mix/gpt-4o-mini");
    assert.equal(u.searchParams.get("status_filter"), "failure");
  });

  it("응답 모양이 달라도 행 배열을 꺼낸다", () => {
    assert.deepEqual(rowsOf([{ a: 1 }]), [{ a: 1 }]);
    assert.deepEqual(rowsOf({ data: [{ b: 2 }] }), [{ b: 2 }]);
    assert.deepEqual(rowsOf(null), []);
  });

  it("오류 문구의 키와 해시를 가린다", () => {
    const out = redact("bad sk-proj-SECRET123 hash c8c22e019061cdf8237b46aedb1024ccff1cb6433d88389c96ad1c36d9dbae92 Bearer abc.def");
    assert.equal(out.includes("SECRET123"), false);
    assert.equal(out.includes("c8c22e0190"), false);
    assert.equal(out.includes("abc.def"), false);
  });
});
