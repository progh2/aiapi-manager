const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeModels,
  effectiveAllowlist,
  isModelAllowed,
  assertModelAllowed,
  resolveIssueModels,
  teamModelsFor,
  simulateChatCompletion,
} = require("./model-allowlist");

describe("normalizeModels", () => {
  it("공백·중복을 제거하고 문자열로 만든다", () => {
    assert.deepEqual(
      normalizeModels([" gpt-4o-mini ", "gpt-4o", "gpt-4o-mini", "", null]),
      ["gpt-4o-mini", "gpt-4o"]
    );
  });

  it("배열이 아니면 빈 목록", () => {
    assert.deepEqual(normalizeModels(undefined), []);
    assert.deepEqual(normalizeModels("gpt-4o-mini"), []);
  });
});

describe("effectiveAllowlist", () => {
  it("키·학급 모두 비면 제한 없음", () => {
    assert.deepEqual(effectiveAllowlist({}), { models: [], unrestricted: true });
  });

  it("키만 있으면 키 목록", () => {
    assert.deepEqual(
      effectiveAllowlist({ keyModels: ["gpt-4o-mini"] }),
      { models: ["gpt-4o-mini"], unrestricted: false }
    );
  });

  it("학급만 있으면 학급 목록을 물려받는다", () => {
    assert.deepEqual(
      effectiveAllowlist({ teamModels: ["gpt-4o-mini", "gpt-4o"] }),
      { models: ["gpt-4o-mini", "gpt-4o"], unrestricted: false }
    );
  });

  it("둘 다 있으면 교집합", () => {
    assert.deepEqual(
      effectiveAllowlist({
        keyModels: ["gpt-4o-mini", "gpt-4o"],
        teamModels: ["gpt-4o-mini"],
      }),
      { models: ["gpt-4o-mini"], unrestricted: false }
    );
  });
});

describe("isModelAllowed / assertModelAllowed", () => {
  it("빈 목록은 모든 모델을 허용한다", () => {
    assert.equal(isModelAllowed("gpt-4o", []), true);
    assert.equal(isModelAllowed("gpt-4o-mini", { unrestricted: true, models: [] }), true);
  });

  it("허용 목록 밖 모델은 거부한다", () => {
    assert.equal(isModelAllowed("gpt-4o-mini", ["gpt-4o-mini"]), true);
    assert.equal(isModelAllowed("gpt-4o", ["gpt-4o-mini"]), false);
    assert.throws(
      () => assertModelAllowed("gpt-4o", ["gpt-4o-mini"]),
      (e) => e.status === 403 && e.code === "model_not_allowed"
        && /gpt-4o-mini/.test(e.message)
    );
  });

  it("모델 이름이 없으면 거부", () => {
    assert.equal(isModelAllowed("", ["gpt-4o-mini"]), false);
  });
});

describe("resolveIssueModels", () => {
  it("요청이 비면 학급 목록을 키에 복사한다", () => {
    assert.deepEqual(resolveIssueModels([], ["gpt-4o-mini"]), ["gpt-4o-mini"]);
  });

  it("학급도 없으면 빈 배열(제한 없음)", () => {
    assert.deepEqual(resolveIssueModels([], []), []);
  });

  it("겹치지 않으면 400", () => {
    assert.throws(
      () => resolveIssueModels(["gpt-4o"], ["gpt-4o-mini"]),
      (e) => e.status === 400 && /겹치지/.test(e.message)
    );
  });
});

describe("teamModelsFor", () => {
  it("team_id로 학급 models를 읽는다", async () => {
    const litellm = async (path) => {
      assert.equal(path, "/team/list");
      return { teams: [{ team_id: "team-1", models: ["gpt-4o-mini"] }] };
    };
    assert.deepEqual(await teamModelsFor(litellm, "team-1"), ["gpt-4o-mini"]);
    assert.deepEqual(await teamModelsFor(litellm, "missing"), []);
    assert.deepEqual(await teamModelsFor(litellm, ""), []);
  });
});

describe("simulateChatCompletion", () => {
  it("허용 모델은 성공하고 그 외는 거부한다", () => {
    const ok = simulateChatCompletion({
      model: "gpt-4o-mini",
      keyModels: ["gpt-4o-mini"],
      teamModels: ["gpt-4o-mini", "gpt-4o"],
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.model, "gpt-4o-mini");

    assert.throws(
      () => simulateChatCompletion({
        model: "gpt-4o",
        keyModels: ["gpt-4o-mini"],
        teamModels: ["gpt-4o-mini"],
      }),
      (e) => e.status === 403 && e.code === "model_not_allowed"
    );
  });

  it("키 목록이 비면 학급 목록으로 거부한다", () => {
    assert.throws(
      () => simulateChatCompletion({
        model: "gpt-4o",
        keyModels: [],
        teamModels: ["gpt-4o-mini"],
      }),
      (e) => e.status === 403
    );
  });
});
