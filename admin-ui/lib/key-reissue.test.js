const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { remainingBudget, retiredAlias, reissueKey } = require("./key-reissue");

describe("remainingBudget", () => {
  it("전체에서 이미 쓴 금액을 뺀다", () => {
    assert.equal(remainingBudget({ max_budget: 2, spend: 0.4 }), 1.6);
    assert.equal(remainingBudget({ max_budget: 1, spend: 3 }), 0);
    assert.equal(remainingBudget({ max_budget: null, spend: 1 }), null);
  });
});

describe("retiredAlias", () => {
  it("같은 폐기 별칭이 있으면 번호를 붙인다", () => {
    assert.equal(retiredAlias("홍길동", new Set()), "홍길동-폐기");
    assert.equal(retiredAlias("홍길동", new Set(["홍길동-폐기"])), "홍길동-폐기-2");
  });
});

describe("reissueKey", () => {
  it("이전 키를 막고 남은 예산으로 같은 별칭을 다시 만든다", async () => {
    const calls = [];
    const current = {
      token: "sk-old",
      key_alias: "홍길동",
      spend: 0.5,
      max_budget: 2,
      budget_duration: "30d",
      models: ["openai-a/gpt-4o-mini"],
      team_id: "t1",
      user_id: "provider:openai-a",
      expires: "2099-01-02T14:59:59.000Z",
      metadata: { aiapi_schedule: [{ days: [2], start: "09:00", end: "10:50" }], aiapi_schedule_from: "team" },
    };
    const litellm = async (path, method, body) => {
      calls.push({ path, body });
      if (path.startsWith("/key/info")) return { info: current };
      if (path.startsWith("/key/list")) return { keys: [current], total_pages: 1 };
      if (path === "/key/generate") return { key: "sk-new" };
      return {};
    };
    const out = await reissueKey("sk-old", { litellm, now: new Date("2099-01-01T00:00:00.000Z") });
    assert.equal(out.key, "sk-new");
    assert.equal(out.retired_alias, "홍길동-폐기");
    assert.equal(out.max_budget, 1.5);
    assert.equal(calls[2].path, "/key/update");
    assert.equal(calls[2].body.key_alias, "홍길동-폐기");
    assert.equal(calls[3].path, "/key/block");
    const created = calls.find((c) => c.path === "/key/generate").body;
    assert.equal(created.key_alias, "홍길동");
    assert.equal(created.max_budget, 1.5);
    assert.equal(created.user_id, "provider:openai-a");
    assert.equal(created.metadata.aiapi_schedule_from, "team");
    assert.equal(created.metadata.aiapi_history[0].action, "reissue");
    assert.equal(JSON.stringify(calls).includes("sk-new"), false);
  });

  it("새 키 발급이 실패하면 이전 키 별칭을 되돌린다", async () => {
    const current = { token: "sk-old", key_alias: "홍길동", spend: 0, max_budget: 2, models: ["gpt-4o-mini"] };
    const calls = [];
    const litellm = async (path, method, body) => {
      calls.push(path);
      if (path.startsWith("/key/info")) return { info: current };
      if (path.startsWith("/key/list")) return { keys: [current], total_pages: 1 };
      if (path === "/key/generate") throw new Error("generate failed");
      return {};
    };
    await assert.rejects(() => reissueKey("sk-old", { litellm }), /generate failed/);
    assert.ok(calls.includes("/key/unblock"));
    assert.equal(calls.filter((p) => p === "/key/update").length, 2);
  });
});
