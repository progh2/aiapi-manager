const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  ProviderKeyStore,
  attachProvider,
  registerProvider,
  registerPool,
  updateProvider,
  deleteProvider,
  matchPoolCalls,
  toPublic,
  spendFor,
} = require("./provider-keys");

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pk-"));
  return new ProviderKeyStore(path.join(dir, "provider-keys.json"));
}

function sampleRecord(over = {}) {
  return {
    id: "pk_test",
    slug: "openai-a",
    label: "학교 OpenAI A",
    provider: "openai",
    api_key: "sk-secret-1234",
    key_hint: "••••1234",
    max_budget: 20,
    budget_duration: "30d",
    litellm_user_id: "provider:openai-a",
    models: [{ name: "gpt-4o-mini", call_name: "openai-a/gpt-4o-mini", model_id: "m1" }],
    ...over,
  };
}

describe("attachProvider", () => {
  it("고른 모델만 슬러그 이름으로 바꾸고 공급자 사용자에 묶는다", () => {
    const store = tempStore();
    store.add(sampleRecord());
    const out = attachProvider({
      provider_key_id: "pk_test",
      models: ["gpt-4o-mini"],
      schedule: [{ days: [2, 4], start: "09:00", end: "10:50" }],
    }, store);
    assert.deepEqual(out.models, ["openai-a/gpt-4o-mini"]);
    assert.equal(out.user_id, "provider:openai-a");
    assert.equal(out.metadata.aiapi_provider_key_id, "pk_test");
    assert.equal(out.metadata.aiapi_schedule.length, 1);
  });

  it("기본 .env 키는 모델 이름을 그대로 둔다", () => {
    const out = attachProvider({
      provider_key_id: "env",
      models: ["gpt-4o-mini"],
      schedule: [],
    }, tempStore());
    assert.deepEqual(out.models, ["gpt-4o-mini"]);
    assert.equal(out.user_id, undefined);
    assert.deepEqual(out.metadata.aiapi_schedule, []);
  });

  it("같은 회사 키라도 다른 슬러그의 모델은 고를 수 없다", () => {
    const store = tempStore();
    store.add(sampleRecord());
    assert.throws(
      () => attachProvider({ provider_key_id: "pk_test", models: ["openai-b/gpt-4o-mini"] }, store),
      /하나 이상/
    );
  });
});

describe("registerProvider", () => {
  it("LiteLLM에 사용자와 모델을 만들고 응답에는 비밀 키를 넣지 않는다", async () => {
    const store = tempStore();
    const calls = [];
    const litellm = async (p, method, body) => {
      calls.push({ p, method, body });
      if (p === "/user/new") return { user_id: body.user_id };
      if (p === "/model/new") return { model_id: "mid-" + body.model_name };
      throw new Error(p);
    };
    const pub = await registerProvider({
      provider: "openai",
      slug: "openai-a",
      label: "A",
      api_key: "sk-live-9999",
      max_budget: 15,
      budget_duration: "30d",
      models: ["gpt-4o-mini", "gpt-4o"],
    }, { litellm, store });
    assert.equal(pub.key_hint, "••••9999");
    assert.equal(pub.api_key, undefined);
    assert.deepEqual(pub.models.map((m) => m.call_name), ["openai-a/gpt-4o-mini", "openai-a/gpt-4o"]);
    assert.equal(calls[0].body.user_id, "provider:openai-a");
    assert.equal(calls[0].body.max_budget, 15);
    assert.equal(calls[1].body.litellm_params.api_key, "sk-live-9999");
    assert.equal(calls[1].body.model_name, "openai-a/gpt-4o-mini");
    const saved = store.get("openai-a");
    assert.equal(saved.api_key, "sk-live-9999");
    assert.equal(JSON.stringify(toPublic(saved, 0)).includes("sk-live"), false);
  });

  it("학생 키가 있으면 삭제하지 않는다", async () => {
    const store = tempStore();
    store.add(sampleRecord());
    await assert.rejects(
      () => deleteProvider("pk_test", {
        litellm: async () => ({}),
        store,
        keys: [{ models: ["openai-a/gpt-4o-mini"], spend: 0, metadata: {} }],
      }),
      /학생 키를 먼저/
    );
  });
});

describe("ollama", () => {
  it("키와 달러 한도 없이 등록하고 주소의 /v1 은 뺀다", async () => {
    const store = tempStore();
    const calls = [];
    const litellm = async (p, method, body) => {
      calls.push({ p, body });
      if (p === "/user/new") return {};
      if (p === "/model/new") return { model_id: "ollama-1" };
      throw new Error(p);
    };
    const pub = await registerProvider({
      provider: "ollama",
      slug: "lab-pc",
      label: "실습실 PC",
      api_key: "",
      api_base: "http://10.0.0.8:11434/v1/",
      max_budget: "",
      models: ["llama3.2:latest"],
    }, { litellm, store });
    assert.equal(pub.key_hint, "로컬");
    assert.equal(pub.api_base, "http://10.0.0.8:11434");
    assert.equal(pub.max_budget, null);
    assert.equal(pub.models[0].call_name, "lab-pc/llama3.2:latest");
    assert.equal(calls[0].body.max_budget, undefined);
    assert.equal(calls[1].body.litellm_params.model, "ollama/llama3.2:latest");
    assert.equal(calls[1].body.litellm_params.api_key, undefined);
    assert.equal(calls[1].body.litellm_params.api_base, "http://10.0.0.8:11434");
    assert.equal(JSON.stringify(pub).includes("sk-"), false);
  });
});

describe("registerPool", () => {
  it("같은 학생 모델 이름에 멤버별 weight 를 붙인다", async () => {
    const store = tempStore();
    store.add(sampleRecord());
    store.add(sampleRecord({
      id: "pk_b",
      slug: "openai-b",
      label: "학교 OpenAI B",
      api_key: "sk-other-7777",
      litellm_user_id: "provider:openai-b",
      models: [{ name: "gpt-4o-mini", call_name: "openai-b/gpt-4o-mini", model_id: "m2" }],
    }));
    const calls = [];
    const litellm = async (p, method, body) => {
      calls.push({ p, body });
      if (p === "/user/new") return {};
      if (p === "/model/new") return { model_id: "pool-" + calls.length };
      if (p === "/model/delete") return {};
      throw new Error(p);
    };
    const pub = await registerPool({
      slug: "class-mix",
      label: "수업 묶음",
      max_budget: 30,
      budget_duration: "30d",
      members: [
        { provider_key_id: "pk_test", model: "gpt-4o-mini", weight: 2 },
        { provider_key_id: "openai-b", model: "gpt-4o-mini", weight: 1 },
      ],
    }, { litellm, store });
    assert.equal(pub.kind, "pool");
    assert.equal(pub.models[0].call_name, "class-mix/gpt-4o-mini");
    assert.equal(pub.api_key, undefined);
    assert.equal(JSON.stringify(pub).includes("sk-"), false);
    assert.deepEqual(pub.members.map((m) => m.weight), [2, 1]);
    const models = calls.filter((c) => c.p === "/model/new");
    assert.equal(models.length, 2);
    assert.equal(models[0].body.model_name, "class-mix/gpt-4o-mini");
    assert.equal(models[1].body.model_name, "class-mix/gpt-4o-mini");
    assert.equal(models[0].body.litellm_params.weight, 2);
    assert.equal(models[1].body.litellm_params.weight, 1);
    assert.equal(models[0].body.litellm_params.api_key, "sk-secret-1234");
    assert.equal(calls[0].body.user_id, "pool:class-mix");
    const attached = attachProvider({
      provider_key_id: pub.id,
      models: ["gpt-4o-mini"],
    }, store);
    assert.deepEqual(attached.models, ["class-mix/gpt-4o-mini"]);
    assert.equal(attached.user_id, "pool:class-mix");
  });

  it("묶음이 참조하는 공급자 키는 지우지 않고, 묶음 삭제는 배포를 모두 지운다", async () => {
    const store = tempStore();
    store.add(sampleRecord());
    store.add({
      id: "pool_1",
      kind: "pool",
      slug: "class-mix",
      label: "수업 묶음",
      provider: "pool",
      api_key: "",
      max_budget: 30,
      litellm_user_id: "pool:class-mix",
      models: [{
        name: "gpt-4o-mini",
        call_name: "class-mix/gpt-4o-mini",
        model_id: "d1",
        model_ids: ["d1", "d2"],
      }],
      members: [{ provider_key_id: "pk_test", label: "A", model: "gpt-4o-mini", weight: 1 }],
    });
    const deleted = [];
    const litellm = async (p, method, body) => {
      if (p === "/model/delete") deleted.push(body.id);
      return {};
    };
    await assert.rejects(
      () => deleteProvider("pk_test", { litellm, store, keys: [] }),
      /묶음을 먼저/
    );
    assert.equal(deleted.length, 0);
    await deleteProvider("pool_1", { litellm, store, keys: [] });
    assert.deepEqual(deleted.sort(), ["d1", "d2"]);
    assert.equal(store.get("pool_1"), null);
    assert.ok(store.get("pk_test"));
  });
});

describe("updateProvider", () => {
  it("비밀 키를 비우면 유지하고 금액과 새 모델을 반영한다", async () => {
    const store = tempStore();
    store.add(sampleRecord());
    const calls = [];
    const litellm = async (p, method, body) => {
      calls.push({ p, body });
      if (p === "/model/new") return { model_id: "mid-new" };
      return {};
    };
    const pub = await updateProvider({
      id: "pk_test",
      label: "학교 OpenAI A2",
      api_key: "",
      max_budget: 40,
      budget_duration: "7d",
      models: ["gpt-4o-mini", "gpt-4o"],
    }, {
      litellm,
      store,
      keys: [{ models: ["openai-a/gpt-4o-mini"], spend: 4, metadata: {} }],
    });
    assert.equal(pub.remaining, 36);
    assert.equal(pub.label, "학교 OpenAI A2");
    assert.equal(JSON.stringify(pub).includes("sk-secret"), false);
    assert.equal(calls[0].p, "/user/update");
    assert.equal(calls[0].body.max_budget, 40);
    assert.equal(calls.some((c) => c.p === "/model/update"), false);
    assert.equal(calls.find((c) => c.p === "/model/new").body.litellm_params.api_key, "sk-secret-1234");
    assert.equal(store.get("pk_test").api_key, "sk-secret-1234");
  });

  it("비밀 키를 바꾸면 묶음 배포도 갱신하고, 쓰는 모델은 빼지 않는다", async () => {
    const store = tempStore();
    store.add(sampleRecord());
    store.add({
      id: "pool_1",
      kind: "pool",
      slug: "mix",
      label: "묶음",
      provider: "pool",
      api_key: "",
      max_budget: 10,
      litellm_user_id: "pool:mix",
      models: [{ name: "gpt-4o-mini", call_name: "mix/gpt-4o-mini", model_id: "d1" }],
      members: [{ provider_key_id: "pk_test", label: "A", model: "gpt-4o-mini", weight: 2, model_id: "d9" }],
    });
    const calls = [];
    const litellm = async (p, method, body) => {
      calls.push({ p, body });
      return {};
    };
    await assert.rejects(
      () => updateProvider({
        id: "pk_test",
        label: "A",
        api_key: "sk-rotated-1",
        max_budget: 20,
        budget_duration: "30d",
        models: ["gpt-4o"],
      }, { litellm, store, keys: [{ models: ["openai-a/gpt-4o-mini"], spend: 0, metadata: {} }] }),
      /학생 키/
    );
    await updateProvider({
      id: "pk_test",
      label: "A",
      api_key: "sk-rotated-1",
      max_budget: 20,
      budget_duration: "30d",
      models: ["gpt-4o-mini"],
    }, { litellm, store, keys: [] });
    const updates = calls.filter((c) => c.p === "/model/update");
    assert.equal(updates.length, 2);
    assert.equal(updates[1].body.model_id, "d9");
    assert.equal(updates[1].body.litellm_params.api_key, "sk-rotated-1");
    assert.equal(updates[1].body.litellm_params.weight, 2);
    assert.equal(store.get("pk_test").api_key, "sk-rotated-1");
  });
});

describe("matchPoolCalls", () => {
  it("배포 id 로 멤버를 찾고 다른 모델 호출은 뺀다", () => {
    const calls = matchPoolCalls({
      models: [{ call_name: "mix/gpt-4o-mini" }],
      members: [
        { model_id: "d1", label: "A", model: "gpt-4o-mini", weight: 2 },
        { model_id: "d2", label: "B", model: "gpt-4o-mini", weight: 1 },
      ],
    }, [
      { model: "mix/gpt-4o-mini", model_id: "d2", spend: 0.1, startTime: "2026-09-29T02:00:00Z" },
      { model: "gpt-4o-mini", model_id: "other", spend: 9, startTime: "2026-09-29T03:00:00Z" },
      { model: "mix/gpt-4o-mini", model_id: "d1", spend: 0.2, startTime: "2026-09-29T01:00:00Z" },
    ]);
    assert.deepEqual(calls.map((c) => c.member), ["B", "A"]);
    assert.equal(calls[0].weight, 1);
  });
});

describe("spendFor", () => {
  it("그 공급자 키로 나간 학생 키 사용량만 합친다", () => {
    const record = sampleRecord();
    const spend = spendFor(record, [
      { models: ["openai-a/gpt-4o-mini"], spend: 1.5, metadata: {} },
      { models: ["openai-b/gpt-4o-mini"], spend: 9, metadata: {} },
      { models: ["gpt-4o"], spend: 4, metadata: { aiapi_provider_key_id: "pk_test" } },
    ]);
    assert.equal(spend, 5.5);
  });
});
