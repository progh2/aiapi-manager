const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildAnalytics } = require("./analytics");

function sampleInput() {
  const teams = [
    { team_id: "team-a", team_alias: "1반", max_budget: 10 },
    { team_id: "team-b", team_alias: "2반", max_budget: 8 },
  ];
  const keyList = [
    { token: "tok-a1", key_alias: "홍길동", team_id: "team-a", max_budget: 4 },
    { token: "tok-a2", key_alias: "김철수", team_id: "team-a", max_budget: 6 },
    { token: "tok-b1", key_alias: "이영희", team_id: "team-b", max_budget: 8 },
    { token: "tok-free", key_alias: "교사", team_id: null, max_budget: null },
  ];
  const results = [
    {
      date: "2026-09-01",
      metrics: { spend: 10, api_requests: 100, total_tokens: 1000 },
      breakdown: {
        api_keys: {
          "tok-a1": { metrics: { spend: 1, api_requests: 10, total_tokens: 100 } },
          "tok-a2": { metrics: { spend: 2, api_requests: 20, total_tokens: 200 } },
          "tok-b1": { metrics: { spend: 3, api_requests: 30, total_tokens: 300 } },
          "tok-free": { metrics: { spend: 4, api_requests: 40, total_tokens: 400 } },
        },
        models: { "gpt-4o-mini": { metrics: { spend: 10 } } },
      },
    },
    {
      date: "2026-09-02",
      metrics: { spend: 4, api_requests: 40, total_tokens: 400 },
      breakdown: {
        api_keys: {
          "tok-a1": { metrics: { spend: 2, api_requests: 20, total_tokens: 200 } },
          "tok-a2": { metrics: { spend: 1, api_requests: 10, total_tokens: 100 } },
          "tok-b1": { metrics: { spend: 1, api_requests: 10, total_tokens: 100 } },
        },
        models: { "gpt-4o-mini": { metrics: { spend: 4 } } },
      },
    },
    {
      date: "2026-09-03",
      metrics: { spend: 3, api_requests: 30, total_tokens: 300 },
      breakdown: {
        api_keys: {
          "tok-a2": { metrics: { spend: 2, api_requests: 20, total_tokens: 200 } },
          "tok-free": { metrics: { spend: 1, api_requests: 10, total_tokens: 100 } },
        },
        models: { "gpt-4o-mini": { metrics: { spend: 3 } } },
      },
    },
  ];
  return {
    results,
    keyList,
    teams,
    start: new Date("2026-09-01T00:00:00.000Z"),
    end: new Date("2026-09-03T00:00:00.000Z"),
    horizon: 2,
  };
}

describe("buildAnalytics", () => {
  it("전체 대시보드용 집계와 학급 잔여를 만든다", () => {
    const out = buildAnalytics(sampleInput());
    assert.deepEqual(out.daily, [10, 4, 3]);
    assert.deepEqual(out.cumulative, [10, 14, 17]);
    assert.equal(out.totalSpend, 17);
    assert.deepEqual(out.requests, [100, 40, 30]);
    assert.equal(out.budget.total, 18);
    assert.equal(out.budget.remaining, 1);
    assert.equal(out.forecast.future.length, 2);

    assert.deepEqual(out.teamStats, [
      { name: "1반", spend: 8, budget: 10, max_budget: 10, remaining: 2 },
      { name: "학급 없음", spend: 5, budget: null, max_budget: null, remaining: null },
      { name: "2반", spend: 4, budget: 8, max_budget: 8, remaining: 4 },
    ]);
    assert.equal(out.keyStats.find((k) => k.alias === "홍길동").remaining, 1);
    assert.equal(out.keyStats.find((k) => k.alias === "김철수").remaining, 1);
    assert.equal(out.keyStats.find((k) => k.alias === "이영희").remaining, 4);
    assert.equal(out.keyStats.find((k) => k.alias === "교사").remaining, null);
  });

  it("선택한 학급만 일별·누적·학생·학급 차트로 좁힌다", () => {
    const out = buildAnalytics({ ...sampleInput(), teamId: "team-a" });
    assert.deepEqual(out.daily, [3, 3, 2]);
    assert.deepEqual(out.cumulative, [3, 6, 8]);
    assert.deepEqual(out.requests, [30, 30, 20]);
    assert.equal(out.totalSpend, 8);
    assert.deepEqual(out.keyStats.map((k) => k.alias), ["김철수", "홍길동"]);
    assert.deepEqual(out.teamStats, [
      { name: "1반", spend: 8, budget: 10, max_budget: 10, remaining: 2 },
    ]);
    assert.equal(out.budget.team, "1반");
    assert.equal(out.budget.total, 10);
    assert.equal(out.budget.remaining, 2);
    assert.deepEqual(out.modelStats, []);
  });
});
