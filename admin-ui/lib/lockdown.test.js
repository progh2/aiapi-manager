const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { LOCK_KEY, lockdownTeam, liftLockdown } = require("./lockdown");

const NOW = new Date("2026-09-29T03:00:00.000Z");

function world() {
  const teams = [
    { team_id: "t1", team_alias: "3학년A반", metadata: { aiapi_schedule: [{ days: [1], start: "09:00", end: "10:00" }] } },
    { team_id: "t2", team_alias: "3학년B반", metadata: {} },
  ];
  const keys = [
    { token: "h-a", key_alias: "20261001-홍길동", team_id: "t1", blocked: false, metadata: { aiapi_schedule_from: "team" } },
    { token: "h-b", key_alias: "20261002-김철수", team_id: "t1", blocked: true, metadata: {} },
    { token: "h-old", key_alias: "20261003-이영희-폐기", team_id: "t1", blocked: true, metadata: {} },
    { token: "h-c", key_alias: "20261003-이영희", team_id: "t1", blocked: false, metadata: {} },
    { token: "h-z", key_alias: "다른반", team_id: "t2", blocked: false, metadata: {} },
  ];
  const calls = [];
  async function litellm(path, method, body) {
    calls.push({ path, body });
    if (path === "/team/list") return { teams };
    if (path.startsWith("/key/list")) return { keys, total_pages: 1 };
    if (path === "/key/update") {
      const k = keys.find((x) => x.token === body.key);
      k.metadata = body.metadata;
      return k;
    }
    if (path === "/key/block" || path === "/key/unblock") {
      const k = keys.find((x) => x.token === body.key);
      k.blocked = path === "/key/block";
      return { blocked: k.blocked };
    }
    if (path === "/team/update") {
      const t = teams.find((x) => x.team_id === body.team_id);
      t.metadata = body.metadata;
      return t;
    }
    throw new Error("unexpected " + path);
  }
  return { teams, keys, calls, litellm };
}

describe("학급 봉쇄", () => {
  it("열린 키만 막고 표시를 남기며, 이미 막힌 키는 건너뛴다", async () => {
    const w = world();
    const out = await lockdownTeam({ team_id: "t1", reason: "시험" }, { litellm: w.litellm, actor: "t@school.kr", now: NOW });
    assert.equal(out.results.filter((r) => r.blocked && !r.skipped).length, 2);
    assert.equal(w.keys.find((k) => k.token === "h-a").blocked, true);
    assert.equal(w.keys.find((k) => k.token === "h-a").metadata[LOCK_KEY].by, "t@school.kr");
    assert.equal(w.keys.find((k) => k.token === "h-a").metadata.aiapi_schedule_from, "team");
    assert.equal(w.keys.find((k) => k.token === "h-b").metadata[LOCK_KEY], undefined);
    assert.equal(w.keys.find((k) => k.token === "h-z").blocked, false);
    const team = w.teams.find((t) => t.team_id === "t1");
    assert.equal(team.metadata[LOCK_KEY].keys, 2);
    assert.equal(team.metadata[LOCK_KEY].reason, "시험");
    assert.equal(team.metadata.aiapi_schedule.length, 1);
  });

  it("해제는 봉쇄로 막은 키만 열고 폐기 키와 개별 차단 키는 그대로 둔다", async () => {
    const w = world();
    await lockdownTeam({ team_id: "t1" }, { litellm: w.litellm, actor: "t", now: NOW });
    const out = await liftLockdown({ team_id: "t1" }, { litellm: w.litellm });
    assert.deepEqual(out.results.map((r) => r.alias).sort(), ["20261001-홍길동", "20261003-이영희"]);
    assert.equal(w.keys.find((k) => k.token === "h-a").blocked, false);
    assert.equal(w.keys.find((k) => k.token === "h-a").metadata[LOCK_KEY], undefined);
    assert.equal(w.keys.find((k) => k.token === "h-b").blocked, true);
    assert.equal(w.keys.find((k) => k.token === "h-old").blocked, true);
    assert.equal(w.teams.find((t) => t.team_id === "t1").metadata[LOCK_KEY], undefined);
  });

  it("이미 봉쇄된 학급은 409, 없는 학급은 404", async () => {
    const w = world();
    await lockdownTeam({ team_id: "t1" }, { litellm: w.litellm, now: NOW });
    await assert.rejects(() => lockdownTeam({ team_id: "t1" }, { litellm: w.litellm, now: NOW }), (e) => e.status === 409);
    await assert.rejects(() => lockdownTeam({ team_id: "zz" }, { litellm: w.litellm, now: NOW }), (e) => e.status === 404);
    await assert.rejects(() => liftLockdown({}, { litellm: w.litellm }), (e) => e.status === 400);
  });
});
