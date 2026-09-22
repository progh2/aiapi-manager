const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  ALPHABET,
  MAX_CAMP,
  CAMP_LOW_COST_MODELS,
  todayYmd,
  normalizePrefix,
  formatCode,
  litellmKeyFor,
  isCampCode,
  isLowCostModel,
  campIssuePolicy,
  defaultCampExpires,
  campExpires,
  resolveCampModels,
  campMetadata,
  generateCampCodes,
  printList,
  isCustomKeyRejected,
  issueCampKeys,
  revokeCampKeys,
} = require("./camp-keys");
const { assignClassBudgets } = require("./class-assign");

function mockLiteLLM({ generate, teams = [], keys = [], rejectCustom = false } = {}) {
  const calls = [];
  async function litellm(path, method, body) {
    calls.push({ path, method, body });
    if (path.startsWith("/key/list")) return { keys, total_pages: 1 };
    if (path === "/team/list") return { teams };
    if (path === "/team/new") return { team_id: "team-camp", team_alias: body.team_alias };
    if (path === "/key/generate") {
      if (rejectCustom && body.key) throw new Error("Invalid key format. minimum custom key length");
      if (generate) return generate(body);
      if (String(body.key_alias).includes("FAIL")) throw new Error("alias already exists");
      return {
        key: body.key || `sk-long-${body.key_alias}`,
        expires: "2026-09-17T14:59:59.000Z",
        max_budget: body.max_budget,
        metadata: body.metadata,
      };
    }
    throw new Error(`unexpected ${path}`);
  }
  return { litellm, calls };
}

function letterRng(letters) {
  let i = 0;
  return () => {
    const ch = letters[i % letters.length];
    i += 1;
    return ALPHABET.indexOf(ch);
  };
}

describe("camp code helpers", () => {
  it("오늘 날짜를 로컬 YYYY-MM-DD로 만든다", () => {
    const now = new Date(2026, 8, 17, 9, 0, 0);
    assert.equal(todayYmd(now), "2026-09-17");
  });

  it("prefix를 대문자·영숫자로 맞춘다", () => {
    assert.equal(normalizePrefix("camp-1"), "CAMP1");
    assert.equal(normalizePrefix(""), "CAMP");
    assert.equal(normalizePrefix("very-long-prefix"), "VERYLONG");
  });

  it("짧은 코드와 sk- 가상 키를 짝짓는다", () => {
    assert.equal(formatCode("camp", "a7k2"), "CAMP-A7K2");
    assert.equal(litellmKeyFor("CAMP-A7K2"), "sk-CAMP-A7K2");
    assert.equal(isCampCode("CAMP-A7K2"), true);
    assert.equal(isCampCode("20261001-홍길동"), false);
  });
});

describe("generateCampCodes", () => {
  it("N개 고유 짧은 코드를 만든다", () => {
    const codes = generateCampCodes(8, { prefix: "CAMP" });
    assert.equal(codes.length, 8);
    assert.equal(new Set(codes).size, 8);
    for (const c of codes) {
      assert.match(c, /^CAMP-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
      assert.doesNotMatch(c, /[01IOL]/);
    }
  });

  it("이미 있는 코드는 건너뛴다", () => {
    const codes = generateCampCodes(2, {
      prefix: "CAMP",
      existing: ["CAMP-AAAA"],
      randomInt: letterRng("AAAABBBBCCCC"),
    });
    assert.deepEqual(codes, ["CAMP-BBBB", "CAMP-CCCC"]);
  });

  it("0명·한도 초과는 400", () => {
    assert.throws(() => generateCampCodes(0), (e) => e.status === 400);
    assert.throws(() => generateCampCodes(MAX_CAMP + 1), (e) => e.status === 400 && /200/.test(e.message));
  });
});

describe("당일 만료 강제와 인쇄 목록", () => {
  it("expires가 없으면 오늘을 쓰고, 다른 날은 거절한다", () => {
    const now = new Date(2026, 8, 17, 10, 0, 0);
    assert.equal(defaultCampExpires({}, now), "2026-09-17");
    assert.equal(defaultCampExpires({ expires: "  " }, now), "2026-09-17");
    assert.equal(campExpires({ expires: "2026-09-17" }, now), "2026-09-17");
    assert.throws(
      () => defaultCampExpires({ expires: "2026-09-18" }, now),
      (e) => e.status === 400 && /당일 종료/.test(e.message)
    );
  });

  it("인쇄·CSV 목록을 만든다", () => {
    const print = printList([
      { code: "CAMP-A7K2", key: "sk-CAMP-A7K2" },
      { code: "CAMP-M9QX", key: "sk-CAMP-M9QX" },
      { code: "CAMP-FAIL", error: "boom" },
    ], { expires: "2026-09-17" });
    assert.equal(print.count, 2);
    assert.deepEqual(print.lines, ["1. CAMP-A7K2", "2. CAMP-M9QX"]);
    assert.equal(print.text, "CAMP-A7K2\nCAMP-M9QX");
    assert.match(print.csv, /^no,code,api_key,alias,expires\n/);
    assert.match(print.csv, /1,CAMP-A7K2,sk-CAMP-A7K2,CAMP-A7K2,2026-09-17/);
  });
});

describe("campIssuePolicy (#20)", () => {
  it("모델 필수·당일 종료·스케줄 회수를 켠다", () => {
    const p = campIssuePolicy({ count: 3 });
    assert.equal(p.require_models, true);
    assert.equal(p.force_same_day_expiry, true);
    assert.equal(p.low_cost_models_only, true);
    assert.deepEqual(p.low_cost_models, CAMP_LOW_COST_MODELS);
    assert.equal(p.schedule_revoke.at, "end_of_day");
    assert.equal(p.schedule_revoke.filter, "camp_due");
    assert.equal(p.schedule_revoke.action, "block");
    assert.equal(p.schedule_revoke.endpoint, "/api/keys/revoke");
    assert.equal(p.schedule_revoke.camp_endpoint, "/api/keys/camp/revoke");
  });

  it("저가 모델만 저가이다", () => {
    assert.equal(isLowCostModel("gpt-4o-mini"), true);
    assert.equal(isLowCostModel("claude-3-haiku"), true);
    assert.equal(isLowCostModel("gpt-4o"), false);
    assert.equal(isLowCostModel(""), false);
  });

  it("캠프 모델은 필수이고 저가만 통과한다", () => {
    assert.deepEqual(resolveCampModels(["gpt-4o-mini"], []), ["gpt-4o-mini"]);
    assert.throws(
      () => resolveCampModels([], []),
      (e) => e.status === 400 && /반드시/.test(e.message)
    );
    assert.throws(
      () => resolveCampModels(["gpt-4o"], []),
      (e) => e.status === 400 && /저가/.test(e.message) && /gpt-4o/.test(e.message)
    );
    assert.throws(
      () => resolveCampModels(["gpt-4o-mini"], ["gpt-4o"]),
      (e) => e.status === 400 && /겹치지/.test(e.message)
    );
  });

  it("메타에 캠프 코드·만료일·회수 훅을 남긴다", () => {
    const meta = campMetadata({
      code: "CAMP-A7K2",
      prefix: "CAMP",
      expires: "2026-09-17",
      models: ["gpt-4o-mini"],
      policy: campIssuePolicy({}),
    });
    assert.equal(meta.aiapi_camp.kind, "camp");
    assert.equal(meta.aiapi_camp.code, "CAMP-A7K2");
    assert.equal(meta.aiapi_camp.expires_ymd, "2026-09-17");
    assert.deepEqual(meta.aiapi_camp.models, ["gpt-4o-mini"]);
    assert.equal(meta.aiapi_camp.schedule_revoke.at, "end_of_day");
    assert.equal(meta.aiapi_camp.schedule_revoke.filter, "camp_due");
  });

  it("커스텀 키 거절 문구를 알아본다", () => {
    assert.equal(isCustomKeyRejected(new Error("minimum custom key length")), true);
    assert.equal(isCustomKeyRejected(new Error("alias already exists")), false);
  });
});

describe("issueCampKeys", () => {
  it("명단 없이 N개·짧은 코드·당일 만료로 발급한다", async () => {
    const now = new Date(2026, 8, 17, 9, 30, 0);
    const { litellm, calls } = mockLiteLLM();
    const out = await issueCampKeys({
      count: 3,
      prefix: "CAMP",
      budget: 1,
      models: ["gpt-4o-mini"],
      randomInt: letterRng("AAAABBBBCCCC"),
    }, { litellm, now });

    assert.equal(out.results.length, 3);
    assert.equal(out.expires, "2026-09-17");
    assert.equal(out.prefix, "CAMP");
    assert.equal(out.max_budget, 1);
    assert.equal(out.policy.force_same_day_expiry, true);
    assert.equal(out.policy.require_models, true);
    assert.deepEqual(out.models, ["gpt-4o-mini"]);
    assert.equal(out.results[0].code, "CAMP-AAAA");
    assert.equal(out.results[0].key, "sk-CAMP-AAAA");
    assert.equal(out.results[0].mapped, false);
    assert.equal(out.print.count, 3);
    assert.equal(out.print.lines[0], "1. CAMP-AAAA");

    const gens = calls.filter((c) => c.path === "/key/generate");
    assert.equal(gens.length, 3);
    assert.equal(gens[0].body.key, "sk-CAMP-AAAA");
    assert.equal(gens[0].body.key_alias, "CAMP-AAAA");
    assert.match(gens[0].body.duration, /^\d+s$/);
    assert.equal(gens[0].body.max_budget, 1);
    assert.deepEqual(gens[0].body.models, ["gpt-4o-mini"]);
    assert.equal(gens[0].body.metadata.aiapi_camp.expires_ymd, "2026-09-17");
    assert.equal(gens[0].body.metadata.aiapi_camp.schedule_revoke.filter, "camp_due");

    const end = new Date(2026, 8, 17, 23, 59, 59, 999);
    const secs = Number(gens[0].body.duration.slice(0, -1));
    const expected = Math.floor((end - now) / 1000);
    assert.equal(secs, expected);
  });

  it("커스텀 키를 거절하면 장문 키로 매핑한다", async () => {
    const now = new Date(2026, 8, 17, 9, 0, 0);
    const { litellm, calls } = mockLiteLLM({ rejectCustom: true });
    const out = await issueCampKeys({
      count: 1,
      models: ["gpt-4o-mini"],
      randomInt: letterRng("A7K2"),
    }, { litellm, now });
    assert.equal(out.results[0].code, "CAMP-A7K2");
    assert.equal(out.results[0].key, "sk-long-CAMP-A7K2");
    assert.equal(out.results[0].mapped, true);
    const gens = calls.filter((c) => c.path === "/key/generate");
    assert.equal(gens.length, 2);
    assert.equal(gens[0].body.key, "sk-CAMP-A7K2");
    assert.equal(gens[1].body.key, undefined);
    assert.equal(gens[1].body.key_alias, "CAMP-A7K2");
  });

  it("인원이 없으면 400", async () => {
    const { litellm } = mockLiteLLM();
    await assert.rejects(
      () => issueCampKeys({}, { litellm }),
      (e) => e.status === 400 && /인원/.test(e.message)
    );
  });

  it("모델이 없으면 400", async () => {
    const now = new Date(2026, 8, 17, 9, 0, 0);
    const { litellm } = mockLiteLLM();
    await assert.rejects(
      () => issueCampKeys({ count: 1, randomInt: letterRng("A7K2") }, { litellm, now }),
      (e) => e.status === 400 && /모델/.test(e.message)
    );
  });

  it("gpt-4o 같은 고가 모델은 400", async () => {
    const now = new Date(2026, 8, 17, 9, 0, 0);
    const { litellm } = mockLiteLLM();
    await assert.rejects(
      () => issueCampKeys({
        count: 1,
        models: ["gpt-4o"],
        randomInt: letterRng("A7K2"),
      }, { litellm, now }),
      (e) => e.status === 400 && /저가/.test(e.message)
    );
  });

  it("다른 날 만료는 400", async () => {
    const now = new Date(2026, 8, 17, 9, 0, 0);
    const { litellm } = mockLiteLLM();
    await assert.rejects(
      () => issueCampKeys({
        count: 1,
        models: ["gpt-4o-mini"],
        expires: "2026-09-18",
        randomInt: letterRng("A7K2"),
      }, { litellm, now }),
      (e) => e.status === 400 && /당일 종료/.test(e.message)
    );
  });

  it("학급 허용 목록과 교집합한다", async () => {
    const now = new Date(2026, 8, 17, 9, 0, 0);
    const { litellm, calls } = mockLiteLLM({
      teams: [{ team_id: "team-2", team_alias: "캠프1일차", models: ["gpt-4o-mini"] }],
    });
    const out = await issueCampKeys({
      count: 1,
      team_id: "team-2",
      models: ["gpt-4o-mini"],
      randomInt: letterRng("M9QX"),
    }, { litellm, now });
    assert.deepEqual(out.models, ["gpt-4o-mini"]);
    const gen = calls.find((c) => c.path === "/key/generate");
    assert.deepEqual(gen.body.models, ["gpt-4o-mini"]);
    assert.equal(gen.body.team_id, "team-2");
  });
});

describe("revokeCampKeys", () => {
  const campDue = {
    token: "sk-CAMP-OLD1",
    key_alias: "CAMP-OLD1",
    expires: "2026-09-16T14:59:59.000Z",
    blocked: false,
    metadata: { aiapi_camp: { kind: "camp", code: "CAMP-OLD1", expires_ymd: "2026-09-16" } },
  };
  const campToday = {
    token: "sk-CAMP-NEW1",
    key_alias: "CAMP-NEW1",
    expires: "2026-09-17T14:59:59.000Z",
    blocked: false,
    metadata: { aiapi_camp: { kind: "camp", code: "CAMP-NEW1", expires_ymd: "2026-09-17" } },
  };
  const classKey = {
    token: "sk-class",
    key_alias: "20261001-홍길동",
    expires: "2026-09-16T14:59:59.000Z",
    blocked: false,
  };

  function revokeMock(keys) {
    const calls = [];
    async function litellm(path, method, body) {
      calls.push({ path, method, body });
      if (path.startsWith("/key/list")) return { keys, total_pages: 1 };
      if (path === "/key/block") {
        const k = keys.find((x) => x.token === body.key);
        if (k) k.blocked = true;
        return { blocked: true };
      }
      throw new Error(`unexpected ${path}`);
    }
    return { litellm, calls };
  }

  it("when=due 는 지난 캠프 키만 차단한다", async () => {
    const keys = [campDue, campToday, classKey].map((k) => ({ ...k }));
    const { litellm, calls } = revokeMock(keys);
    const now = new Date(2026, 8, 17, 9, 0, 0);
    const out = await revokeCampKeys({ when: "due" }, { litellm, now });
    assert.equal(out.filter, "camp_due");
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].alias, "CAMP-OLD1");
    assert.equal(calls.filter((c) => c.path === "/key/block").length, 1);
  });

  it("when=today 는 오늘 캠프 키를 수동으로 막는다", async () => {
    const keys = [campDue, campToday, classKey].map((k) => ({ ...k }));
    const { litellm, calls } = revokeMock(keys);
    const now = new Date(2026, 8, 17, 16, 0, 0);
    const out = await revokeCampKeys({ when: "today", action: "block" }, { litellm, now });
    assert.equal(out.filter, "camp_today");
    assert.deepEqual(out.results.map((r) => r.alias), ["CAMP-NEW1"]);
    assert.equal(calls.filter((c) => c.path === "/key/block").length, 1);
  });
});

describe("학급 일괄 부여 회귀", () => {
  it("기존 CSV 일괄은 그대로 동작한다", async () => {
    const { litellm, calls } = mockLiteLLM();
    const out = await assignClassBudgets({
      csv: "학번,이름\n20261001,홍길동",
      team_id: "team-a",
      budget: 2,
      expires: "2026-12-31",
      models: ["gpt-4o-mini"],
    }, { litellm });
    assert.equal(out.results[0].alias, "20261001-홍길동");
    assert.equal(out.results[0].key, "sk-long-20261001-홍길동");
    assert.deepEqual(out.models, ["gpt-4o-mini"]);
    const gen = calls.find((c) => c.path === "/key/generate");
    assert.equal(gen.body.key_alias, "20261001-홍길동");
    assert.equal(gen.body.key, undefined);
  });
});
