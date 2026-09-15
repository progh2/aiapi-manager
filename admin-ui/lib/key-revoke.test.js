const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  isExpired,
  isExpiringSoon,
  matchesFilter,
  effectiveFilter,
  selectKeysForRevoke,
  revokeKeys,
} = require("./key-revoke");

const NOW = new Date("2026-09-15T12:00:00.000Z");

function key(partial) {
  return {
    token: partial.token || "sk-" + (partial.key_alias || "x"),
    key_alias: partial.key_alias || "x",
    team_id: partial.team_id || null,
    expires: partial.expires,
    blocked: !!partial.blocked,
    max_budget: 2,
    spend: 0,
  };
}

const SAMPLE = [
  key({
    key_alias: "expired-a",
    team_id: "team-1",
    expires: "2026-09-01T00:00:00.000Z",
  }),
  key({
    key_alias: "expired-blocked",
    team_id: "team-1",
    expires: "2026-09-10T00:00:00.000Z",
    blocked: true,
  }),
  key({
    key_alias: "expiring-b",
    team_id: "team-1",
    expires: "2026-09-18T00:00:00.000Z",
  }),
  key({
    key_alias: "active-c",
    team_id: "team-1",
    expires: "2026-12-31T00:00:00.000Z",
  }),
  key({
    key_alias: "camp-expired",
    team_id: "team-2",
    expires: "2026-09-14T00:00:00.000Z",
  }),
  key({
    key_alias: "unlimited",
    team_id: null,
    expires: null,
  }),
];

function mockLiteLLM({ keys = SAMPLE, failAlias } = {}) {
  const calls = [];
  async function litellm(path, method, body) {
    calls.push({ path, method, body });
    if (path.startsWith("/key/list")) return { keys, total_pages: 1 };
    if (path === "/key/block") {
      const k = keys.find((x) => x.token === body.key);
      if (failAlias && k?.key_alias === failAlias) throw new Error("LiteLLM 차단 실패");
      if (!k) throw new Error("키 없음");
      k.blocked = true;
      return { blocked: true };
    }
    if (path === "/key/delete") {
      const tok = (body.keys || [])[0];
      const i = keys.findIndex((x) => x.token === tok);
      if (failAlias && keys[i]?.key_alias === failAlias) throw new Error("LiteLLM 삭제 실패");
      if (i < 0) throw new Error("키 없음");
      keys.splice(i, 1);
      return { deleted: 1 };
    }
    throw new Error(`unexpected ${path}`);
  }
  return { litellm, calls };
}

describe("isExpired / isExpiringSoon", () => {
  it("만료일과 임박(7일)을 구분한다", () => {
    assert.equal(isExpired(SAMPLE[0], NOW), true);
    assert.equal(isExpired(SAMPLE[2], NOW), false);
    assert.equal(isExpired(SAMPLE[5], NOW), false);
    assert.equal(isExpiringSoon(SAMPLE[2], 7, NOW), true);
    assert.equal(isExpiringSoon(SAMPLE[3], 7, NOW), false);
    assert.equal(isExpiringSoon(SAMPLE[0], 7, NOW), false);
  });
});

describe("matchesFilter", () => {
  it("그룹과 만료 필터를 함께 적용한다", () => {
    const expiredTeam1 = SAMPLE.filter((k) => matchesFilter(k, "expired", {
      team_id: "team-1",
      now: NOW,
    }));
    assert.deepEqual(expiredTeam1.map((k) => k.key_alias), ["expired-a", "expired-blocked"]);

    const expiring = SAMPLE.filter((k) => matchesFilter(k, "expiring", { now: NOW }));
    assert.deepEqual(expiring.map((k) => k.key_alias), ["expiring-b"]);
  });
});

describe("effectiveFilter", () => {
  it("tokens 가 있으면 서버 필터를 쓰지 않는다", () => {
    assert.equal(effectiveFilter({ filter: "expired" }, true), null);
  });
  it("그룹만 고르면 그 그룹 전체", () => {
    assert.equal(effectiveFilter({ team_id: "team-1" }, false), "all");
  });
  it("조건이 없으면 만료됨", () => {
    assert.equal(effectiveFilter({}, false), "expired");
  });
});

describe("selectKeysForRevoke", () => {
  it("tokens 가 있으면 그 순서대로 고르고 없는 키는 missing", () => {
    const picked = selectKeysForRevoke({
      tokens: [SAMPLE[3].token, "sk-missing"],
    }, SAMPLE, NOW);
    assert.equal(picked[0].key_alias, "active-c");
    assert.equal(picked[1].missing, true);
    assert.equal(picked[1].token, "sk-missing");
  });

  it("filter=all 은 그룹 없이 거절한다", () => {
    assert.throws(
      () => selectKeysForRevoke({ filter: "all" }, SAMPLE, NOW),
      (e) => e.status === 400
    );
  });
});

describe("revokeKeys", () => {
  it("만료 키만 /key/block 하고 이미 차단된 키는 성공으로 남긴다", async () => {
    const keys = SAMPLE.map((k) => ({ ...k }));
    const { litellm, calls } = mockLiteLLM({ keys });
    const out = await revokeKeys({ action: "block", filter: "expired" }, { litellm, now: NOW });

    assert.equal(out.action, "block");
    assert.equal(out.filter, "expired");
    assert.equal(out.results.length, 3);
    const byAlias = Object.fromEntries(out.results.map((r) => [r.alias, r]));
    assert.equal(byAlias["expired-a"].blocked, true);
    assert.equal(byAlias["expired-a"].error, undefined);
    assert.equal(byAlias["expired-blocked"].skipped, true);
    assert.equal(byAlias["camp-expired"].blocked, true);

    const blocks = calls.filter((c) => c.path === "/key/block");
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0].body, { key: "sk-expired-a" });
    assert.ok(!calls.some((c) => c.path === "/key/delete"));
  });

  it("그룹 전체는 /key/delete 를 키마다 호출하고 부분 실패를 남긴다", async () => {
    const keys = SAMPLE.map((k) => ({ ...k }));
    const { litellm, calls } = mockLiteLLM({ keys, failAlias: "active-c" });
    const out = await revokeKeys({
      action: "delete",
      team_id: "team-1",
    }, { litellm, now: NOW });

    assert.equal(out.filter, "all");
    assert.equal(out.results.length, 4);
    const fail = out.results.find((r) => r.alias === "active-c");
    assert.equal(fail.error, "LiteLLM 삭제 실패");
    const ok = out.results.filter((r) => r.deleted);
    assert.equal(ok.length, 3);

    const dels = calls.filter((c) => c.path === "/key/delete");
    assert.equal(dels.length, 4);
    assert.deepEqual(dels[0].body, { keys: ["sk-expired-a"] });
    assert.ok(!calls.some((c) => c.path === "/key/block"));
  });

  it("선택한 tokens 만 차단한다", async () => {
    const keys = SAMPLE.map((k) => ({ ...k }));
    const { litellm, calls } = mockLiteLLM({ keys });
    const out = await revokeKeys({
      action: "block",
      tokens: ["sk-active-c", "sk-missing"],
    }, { litellm, now: NOW });
    assert.equal(out.filter, null);
    assert.equal(out.results[0].alias, "active-c");
    assert.equal(out.results[0].blocked, true);
    assert.equal(out.results[1].error, "키를 찾을 수 없습니다");
    assert.equal(calls.filter((c) => c.path === "/key/block").length, 1);
  });

  it("action 없으면 400", async () => {
    const { litellm } = mockLiteLLM();
    await assert.rejects(
      () => revokeKeys({}, { litellm, now: NOW }),
      (e) => e.status === 400 && /action/.test(e.message)
    );
  });

  it("맞는 키가 없으면 400", async () => {
    const { litellm } = mockLiteLLM({
      keys: [key({ key_alias: "alive", expires: "2026-12-31T00:00:00.000Z" })],
    });
    await assert.rejects(
      () => revokeKeys({ action: "block", filter: "expired" }, { litellm, now: NOW }),
      (e) => e.status === 400 && /조건/.test(e.message)
    );
  });

  it("키 목록 페이지를 모두 모은다", async () => {
    const page1 = [key({ key_alias: "expired-p1", expires: "2026-01-01T00:00:00.000Z" })];
    const page2 = [key({ key_alias: "expired-p2", expires: "2026-01-02T00:00:00.000Z" })];
    const calls = [];
    async function litellm(path, method, body) {
      calls.push({ path, method, body });
      if (path.includes("page=1")) return { keys: page1, total_pages: 2 };
      if (path.includes("page=2")) return { keys: page2, total_pages: 2 };
      if (path === "/key/block") return { blocked: true };
      throw new Error(path);
    }
    const out = await revokeKeys({ action: "block", filter: "expired" }, { litellm, now: NOW });
    assert.equal(out.results.length, 2);
    assert.equal(out.results[1].alias, "expired-p2");
  });
});
