const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  HISTORY_KEY,
  parseAddBudget,
  parseAddDays,
  nextExpiryFromAddDays,
  historyFromMetadata,
  unwrapKeyInfo,
  remainingBudget,
  adjustKey,
  keyDetail,
} = require("./key-adjust");

const NOW = new Date("2026-09-15T12:00:00.000Z");

function key(partial) {
  return {
    token: partial.token || "sk-" + (partial.key_alias || "x"),
    key_alias: partial.key_alias || "x",
    team_id: partial.team_id || "team-1",
    max_budget: partial.max_budget === undefined ? 2 : partial.max_budget,
    spend: partial.spend ?? 0.4,
    expires: partial.expires === undefined ? "2026-12-31T14:59:59.000Z" : partial.expires,
    metadata: partial.metadata || {},
    blocked: !!partial.blocked,
  };
}

function mockLiteLLM({ keys, failUpdate } = {}) {
  const store = (keys || [
    key({ key_alias: "20261001-홍길동", token: "sk-hong" }),
    key({
      key_alias: "교사-시연",
      token: "sk-unlimited",
      max_budget: null,
      expires: null,
    }),
  ]).map((k) => ({ ...k, metadata: { ...(k.metadata || {}) } }));
  const calls = [];

  async function litellm(path, method, body) {
    calls.push({ path, method, body });
    if (path.startsWith("/key/info")) {
      const q = new URL("http://x" + path);
      const tok = q.searchParams.get("key");
      const k = store.find((x) => x.token === tok);
      if (!k) throw new Error("키 없음");
      return { key: k.token, info: k };
    }
    if (path.startsWith("/key/list")) {
      return { keys: store, total_pages: 1 };
    }
    if (path === "/key/update") {
      if (failUpdate) throw new Error("LiteLLM 수정 실패");
      const k = store.find((x) => x.token === body.key);
      if (!k) throw new Error("키 없음");
      if (body.max_budget !== undefined) k.max_budget = body.max_budget;
      if (body.metadata) k.metadata = body.metadata;
      if (body.duration && /^\d+s$/.test(body.duration)) {
        k.expires = new Date(NOW.getTime() + Number(body.duration.slice(0, -1)) * 1000).toISOString();
      }
      return { ...k };
    }
    throw new Error(`unexpected ${path}`);
  }
  return { litellm, calls, store };
}

describe("parseAddBudget / parseAddDays", () => {
  it("빈 값은 null, 양수만 받는다", () => {
    assert.equal(parseAddBudget(""), null);
    assert.equal(parseAddBudget("2.5"), 2.5);
    assert.throws(() => parseAddBudget(0), (e) => e.status === 400);
    assert.throws(() => parseAddBudget(-1), (e) => e.status === 400);
    assert.equal(parseAddDays(""), null);
    assert.equal(parseAddDays(14), 14);
    assert.throws(() => parseAddDays(1.5), (e) => e.status === 400);
  });
});

describe("nextExpiryFromAddDays", () => {
  it("미래 만료일이면 그 날짜에 더한다 (지금부터가 아님)", () => {
    const next = nextExpiryFromAddDays("2026-12-31T14:59:59.000Z", 14, NOW);
    assert.equal(next.toISOString(), "2027-01-14T14:59:59.000Z");
    const fromNow = new Date(NOW.getTime() + 14 * 86400000);
    assert.ok(next.getTime() > fromNow.getTime());
  });

  it("만료됐거나 없으면 지금부터 더한다", () => {
    const expired = nextExpiryFromAddDays("2026-09-01T00:00:00.000Z", 14, NOW);
    assert.equal(expired.toISOString(), "2026-09-29T12:00:00.000Z");
    const none = nextExpiryFromAddDays(null, 7, NOW);
    assert.equal(none.toISOString(), "2026-09-22T12:00:00.000Z");
  });
});

describe("historyFromMetadata / unwrapKeyInfo / remaining", () => {
  it("이력을 복사해 꺼내고 잔여를 계산한다", () => {
    const hist = [{ at: "x", by: "a", add_budget: 1 }];
    assert.deepEqual(historyFromMetadata({ [HISTORY_KEY]: hist }), hist);
    assert.notEqual(historyFromMetadata({ [HISTORY_KEY]: hist }), hist);
    assert.deepEqual(historyFromMetadata({}), []);
    const info = unwrapKeyInfo({
      key: "sk-hong",
      info: { token: "sk-hong", key_alias: "홍", max_budget: 2 },
    });
    assert.equal(info.token, "sk-hong");
    assert.equal(info.key_alias, "홍");
    assert.equal(remainingBudget(2, 0.4), 1.6);
    assert.equal(remainingBudget(null, 1), null);
  });
});

describe("adjustKey", () => {
  it("예산을 가산하고 /key/update 에 새 max_budget 과 이력을 보낸다", async () => {
    const { litellm, calls } = mockLiteLLM();
    const out = await adjustKey({
      token: "sk-hong",
      add_budget: 2,
    }, { litellm, now: NOW, actor: "teacher@school.kr" });

    assert.equal(out.max_budget, 4);
    assert.equal(out.max_budget_before, 2);
    assert.equal(out.add_budget, 2);
    assert.equal(out.remaining, 3.6);
    assert.equal(out.history.length, 1);
    assert.equal(out.entry.by, "teacher@school.kr");
    assert.equal(out.entry.at, NOW.toISOString());
    assert.equal(out.entry.add_budget, 2);
    assert.equal(out.entry.max_budget_after, 4);

    const upd = calls.find((c) => c.path === "/key/update");
    assert.equal(upd.method, "POST");
    assert.equal(upd.body.key, "sk-hong");
    assert.equal(upd.body.max_budget, 4);
    assert.equal(upd.body.duration, undefined);
    assert.equal(upd.body.metadata[HISTORY_KEY].length, 1);
    assert.equal(upd.body.metadata[HISTORY_KEY][0].by, "teacher@school.kr");
    assert.ok(calls.some((c) => c.path.startsWith("/key/info")));
  });

  it("기존 만료일에 일수를 더하고 duration 은 지금부터가 아니다", async () => {
    const { litellm, calls } = mockLiteLLM();
    const out = await adjustKey({
      token: "sk-hong",
      add_days: 14,
    }, { litellm, now: NOW, actor: "teacher@school.kr" });

    assert.equal(out.add_days, 14);
    assert.equal(out.entry.expires_before, "2026-12-31T14:59:59.000Z");
    assert.equal(out.entry.expires_after, "2027-01-14T14:59:59.000Z");
    assert.match(out.expires, /^2027-01-14/);

    const upd = calls.find((c) => c.path === "/key/update");
    const secs = Number(upd.body.duration.slice(0, -1));
    // 12/31+14일 ≈ 121일. 지금부터 14일이면 1209600초
    assert.ok(upd.body.duration.endsWith("s"));
    assert.ok(secs > 14 * 86400, `duration ${upd.body.duration} should be from existing expiry`);
    assert.equal(upd.body.max_budget, undefined);
  });

  it("달력 만료일로 연장하고 충전과 같이 할 수 있다", async () => {
    const { litellm, calls } = mockLiteLLM();
    const out = await adjustKey({
      token: "sk-hong",
      add_budget: "1.5",
      expires: "2027-03-01",
    }, { litellm, now: NOW, actor: "a@school.kr" });

    assert.equal(out.add_budget, 1.5);
    assert.equal(out.max_budget, 3.5);
    assert.equal(out.entry.expires, "2027-03-01");
    assert.ok(out.entry.expires_after);

    const upd = calls.find((c) => c.path === "/key/update");
    assert.equal(upd.body.max_budget, 3.5);
    assert.match(upd.body.duration, /^\d+s$/);
    assert.equal(upd.body.metadata[HISTORY_KEY][0].add_budget, 1.5);
    assert.equal(upd.body.metadata[HISTORY_KEY][0].expires, "2027-03-01");
  });

  it("이미 있는 metadata 를 덮어쓰지 않고 이력을 덧붙인다", async () => {
    const { litellm, calls } = mockLiteLLM({
      keys: [key({
        token: "sk-hong",
        key_alias: "20261001-홍길동",
        metadata: {
          note: "keep-me",
          [HISTORY_KEY]: [{ at: "2026-09-01T00:00:00.000Z", by: "old@school.kr", add_budget: 1 }],
        },
      })],
    });
    const out = await adjustKey({
      token: "sk-hong",
      add_budget: 2,
    }, { litellm, now: NOW, actor: "teacher@school.kr" });
    assert.equal(out.history.length, 2);
    assert.equal(out.history[0].by, "old@school.kr");
    assert.equal(out.history[1].add_budget, 2);
    const upd = calls.find((c) => c.path === "/key/update");
    assert.equal(upd.body.metadata.note, "keep-me");
  });

  it("/key/info 가 없으면 목록에서 찾는다", async () => {
    const store = [key({ token: "sk-hong", key_alias: "20261001-홍길동" })];
    const calls = [];
    async function litellm(path, method, body) {
      calls.push({ path, method, body });
      if (path.startsWith("/key/info")) throw new Error("info 없음");
      if (path.startsWith("/key/list")) return { keys: store, total_pages: 1 };
      if (path === "/key/update") {
        store[0].max_budget = body.max_budget;
        store[0].metadata = body.metadata;
        return { ...store[0] };
      }
      throw new Error(path);
    }
    const out = await adjustKey({ token: "sk-hong", add_budget: 1 }, {
      litellm, now: NOW, actor: "t@school.kr",
    });
    assert.equal(out.max_budget, 3);
    assert.ok(calls.some((c) => c.path.startsWith("/key/list")));
  });

  it("무제한 예산 충전은 400", async () => {
    const { litellm } = mockLiteLLM();
    await assert.rejects(
      () => adjustKey({ token: "sk-unlimited", add_budget: 2 }, { litellm, now: NOW }),
      (e) => e.status === 400 && /무제한/.test(e.message)
    );
  });

  it("없는 키는 404, token 없거나 변경 없으면 400", async () => {
    const { litellm } = mockLiteLLM();
    await assert.rejects(
      () => adjustKey({ token: "sk-missing", add_budget: 1 }, { litellm, now: NOW }),
      (e) => e.status === 404
    );
    await assert.rejects(
      () => adjustKey({ add_budget: 1 }, { litellm, now: NOW }),
      (e) => e.status === 400 && /token/.test(e.message)
    );
    await assert.rejects(
      () => adjustKey({ token: "sk-hong" }, { litellm, now: NOW }),
      (e) => e.status === 400 && /충전/.test(e.message)
    );
    await assert.rejects(
      () => adjustKey({ token: "sk-hong", add_days: 7, expires: "2026-12-31" }, { litellm, now: NOW }),
      (e) => e.status === 400 && /함께/.test(e.message)
    );
  });

  it("LiteLLM 수정 실패는 그대로 올린다", async () => {
    const { litellm } = mockLiteLLM({ failUpdate: true });
    await assert.rejects(
      () => adjustKey({ token: "sk-hong", add_budget: 1 }, { litellm, now: NOW }),
      (e) => /LiteLLM/.test(e.message)
    );
  });
});

describe("keyDetail", () => {
  it("키와 이력을 같이 돌려준다", async () => {
    const { litellm } = mockLiteLLM({
      keys: [key({
        token: "sk-hong",
        key_alias: "20261001-홍길동",
        metadata: {
          [HISTORY_KEY]: [{ at: NOW.toISOString(), by: "t@school.kr", add_budget: 2 }],
        },
      })],
    });
    const out = await keyDetail("sk-hong", { litellm });
    assert.equal(out.key.key_alias, "20261001-홍길동");
    assert.equal(out.history.length, 1);
    assert.equal(out.history[0].by, "t@school.kr");
    assert.equal(out.remaining, 1.6);
  });

  it("token 없으면 400", async () => {
    const { litellm } = mockLiteLLM();
    await assert.rejects(() => keyDetail("", { litellm }), (e) => e.status === 400);
  });
});
