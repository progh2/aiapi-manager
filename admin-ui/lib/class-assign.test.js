const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { assignClassBudgets, keyGenerateParams } = require("./class-assign");

function mockLiteLLM({ generate, teams = [], createdTeamId = "team-new" } = {}) {
  const calls = [];
  async function litellm(path, method, body) {
    calls.push({ path, method, body });
    if (path === "/team/list") return { teams };
    if (path === "/team/new") return { team_id: createdTeamId };
    if (path === "/key/generate") {
      if (generate) return generate(body);
      if (String(body.key_alias).includes("fail")) throw new Error("alias already exists");
      return {
        key: `sk-${body.key_alias}`,
        expires: "2026-12-31T14:59:59.000Z",
        max_budget: body.max_budget,
      };
    }
    throw new Error(`unexpected ${path}`);
  }
  return { litellm, calls };
}

describe("keyGenerateParams", () => {
  it("models 배열을 정규화해 넣는다", () => {
    const p = keyGenerateParams({ models: [" gpt-4o-mini ", "gpt-4o-mini"] });
    assert.deepEqual(p.models, ["gpt-4o-mini"]);
  });

  it("expires 가 있으면 duration 으로 바꾼다", () => {
    const now = new Date(2026, 8, 15, 12, 0, 0);
    const p = keyGenerateParams({
      budget: "2",
      expires: "2026-12-31",
      duration: "90d",
    });
    // durationFromExpiryDate 는 현재 시각을 쓰므로 초 단위만 확인
    assert.equal(p.max_budget, 2);
    assert.match(p.duration, /^\d+s$/);
    assert.notEqual(p.duration, "90d");
  });
});

describe("assignClassBudgets", () => {
  it("동일 예산·만료로 행별 성공/실패를 돌려준다", async () => {
    const { litellm, calls } = mockLiteLLM();
    const out = await assignClassBudgets({
      csv: "학번,이름\n20261001,홍길동\n20261002,fail학생\n20261003,이영희",
      team_id: "team-a",
      budget: 2,
      expires: "2026-12-31",
    }, { litellm });

    assert.equal(out.results.length, 3);
    assert.equal(out.results[0].key, "sk-20261001-홍길동");
    assert.equal(out.results[0].max_budget, 2);
    assert.ok(out.results[0].expires);
    assert.equal(out.results[1].error, "alias already exists");
    assert.equal(out.results[1].key, undefined);
    assert.equal(out.results[2].key, "sk-20261003-이영희");
    assert.equal(out.max_budget, 2);
    assert.equal(out.expires, "2026-12-31");
    assert.match(out.duration, /^\d+s$/);
    assert.equal(out.team_id, "team-a");
    assert.equal(out.team_created, false);

    const gens = calls.filter((c) => c.path === "/key/generate");
    assert.equal(gens.length, 3);
    assert.equal(gens[0].body.max_budget, 2);
    assert.equal(gens[0].body.team_id, "team-a");
    assert.match(gens[0].body.duration, /^\d+s$/);
    assert.equal(gens[0].body.key_alias, "20261001-홍길동");
  });

  it("기존 {students:[{alias}]} 요청을 그대로 받는다", async () => {
    const { litellm } = mockLiteLLM();
    const out = await assignClassBudgets({
      students: [{ alias: "20261001-홍길동" }],
      budget: 2,
      duration: "90d",
    }, { litellm });
    assert.equal(out.results[0].key, "sk-20261001-홍길동");
    assert.equal(out.duration, "90d");
  });

  it("없는 그룹 이름은 만들고 키에 붙인다", async () => {
    const { litellm, calls } = mockLiteLLM({
      teams: [{ team_id: "old", team_alias: "1반" }],
      createdTeamId: "team-created",
    });
    const out = await assignClassBudgets({
      students: [{ student_id: "20261001", name: "홍길동" }],
      team: "3학년A반",
      team_budget: 60,
      budget: 2,
    }, { litellm });
    assert.equal(out.team_id, "team-created");
    assert.equal(out.team_created, true);
    const created = calls.find((c) => c.path === "/team/new");
    assert.equal(created.body.team_alias, "3학년A반");
    assert.equal(created.body.max_budget, 60);
    const gen = calls.find((c) => c.path === "/key/generate");
    assert.equal(gen.body.team_id, "team-created");
  });

  it("이미 있는 그룹 이름은 재사용한다", async () => {
    const { litellm, calls } = mockLiteLLM({
      teams: [{ team_id: "tid-1", team_alias: "3학년A반" }],
    });
    const out = await assignClassBudgets({
      csv: "20261001,홍길동",
      team: "3학년A반",
      budget: 2,
    }, { litellm });
    assert.equal(out.team_id, "tid-1");
    assert.equal(out.team_created, false);
    assert.ok(!calls.some((c) => c.path === "/team/new"));
  });

  it("명단이 없으면 400", async () => {
    const { litellm } = mockLiteLLM();
    await assert.rejects(
      () => assignClassBudgets({ students: [] }, { litellm }),
      (e) => e.status === 400
    );
  });

  it("models 를 키 발급에 그대로 넣는다", async () => {
    const { litellm, calls } = mockLiteLLM();
    const out = await assignClassBudgets({
      students: [{ alias: "20261001-홍길동" }],
      team_id: "team-a",
      budget: 2,
      models: ["gpt-4o-mini"],
    }, { litellm });
    assert.deepEqual(out.models, ["gpt-4o-mini"]);
    const gen = calls.find((c) => c.path === "/key/generate");
    assert.deepEqual(gen.body.models, ["gpt-4o-mini"]);
  });

  it("발급 때 모델을 안 고르면 학급 허용 목록을 물려받는다", async () => {
    const { litellm, calls } = mockLiteLLM({
      teams: [{ team_id: "team-a", team_alias: "3학년A반", models: ["gpt-4o-mini"] }],
    });
    const out = await assignClassBudgets({
      students: [{ alias: "20261001-홍길동" }],
      team_id: "team-a",
      budget: 2,
    }, { litellm });
    assert.deepEqual(out.models, ["gpt-4o-mini"]);
    const gen = calls.find((c) => c.path === "/key/generate");
    assert.deepEqual(gen.body.models, ["gpt-4o-mini"]);
  });

  it("새 학급을 만들 때 허용 목록을 학급에도 넣는다", async () => {
    const { litellm, calls } = mockLiteLLM({ createdTeamId: "team-created" });
    await assignClassBudgets({
      students: [{ alias: "20261001-홍길동" }],
      team: "3학년A반",
      budget: 2,
      models: ["gpt-4o-mini"],
    }, { litellm });
    const created = calls.find((c) => c.path === "/team/new");
    assert.deepEqual(created.body.models, ["gpt-4o-mini"]);
    const gen = calls.find((c) => c.path === "/key/generate");
    assert.deepEqual(gen.body.models, ["gpt-4o-mini"]);
  });

  it("학급 목록 밖 모델만 고르면 400", async () => {
    const { litellm } = mockLiteLLM({
      teams: [{ team_id: "team-a", models: ["gpt-4o-mini"] }],
    });
    await assert.rejects(
      () => assignClassBudgets({
        students: [{ alias: "20261001-홍길동" }],
        team_id: "team-a",
        models: ["gpt-4o"],
      }, { litellm }),
      (e) => e.status === 400 && /겹치지/.test(e.message)
    );
  });
});
