const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseModelIds, listProviderModels, publicModelId, ollamaRoot } = require("./provider-catalog");

describe("parseModelIds", () => {
  it("임베딩·음성 모델은 빼고 채팅 모델만 남긴다", () => {
    const ids = parseModelIds("openai", {
      data: [
        { id: "gpt-4o-mini" },
        { id: "gpt-4o" },
        { id: "text-embedding-3-small" },
        { id: "whisper-1" },
        { id: "gpt-4o-mini" },
      ],
    });
    assert.deepEqual(ids, ["gpt-4o", "gpt-4o-mini"]);
  });

  it("Gemini 이름에서 models/ 를 뺀다", () => {
    assert.deepEqual(parseModelIds("gemini", {
      models: [{ name: "models/gemini-2.0-flash" }, { name: "models/embedding-001" }],
    }), ["gemini-2.0-flash"]);
  });
});

describe("listProviderModels", () => {
  it("키를 오류 문구에 넣지 않는다", async () => {
    const secret = "sk-super-secret";
    await assert.rejects(
      () => listProviderModels({
        provider: "openai",
        apiKey: secret,
        fetchImpl: async () => ({ ok: false, json: async () => ({ error: { message: secret } }) }),
      }),
      (err) => {
        assert.equal(err.message.includes(secret), false);
        return true;
      }
    );
  });
});

describe("publicModelId", () => {
  it("OpenRouter 모델은 슬래시를 허용한다", () => {
    assert.equal(publicModelId("openrouter", "openai/gpt-4o-mini"), "openai/gpt-4o-mini");
  });

  it("Ollama 태그 이름을 읽고 임베딩은 뺀다", () => {
    assert.deepEqual(parseModelIds("ollama", {
      models: [
        { name: "llama3.2:latest" },
        { name: "nomic-embed-text:latest" },
        { name: "library/qwen2.5:7b" },
      ],
    }), ["library/qwen2.5:7b", "llama3.2:latest"]);
  });
});

describe("ollama", () => {
  it("주소 끝의 /v1 은 로컬 API 루트에서 뺀다", () => {
    assert.equal(ollamaRoot("http://10.0.0.8:11434/v1/"), "http://10.0.0.8:11434");
  });

  it("키 없이 태그 주소를 조회하고 오류에 키를 넣지 않는다", async () => {
    const secret = "ollama-secret";
    let called = null;
    const models = await listProviderModels({
      provider: "ollama",
      apiKey: "",
      apiBase: "http://10.0.0.8:11434/v1",
      fetchImpl: async (url, opts) => {
        called = { url, opts };
        return { ok: true, json: async () => ({ models: [{ name: "llama3.2:latest" }] }) };
      },
    });
    assert.deepEqual(models, ["llama3.2:latest"]);
    assert.equal(called.url, "http://10.0.0.8:11434/api/tags");
    assert.equal(called.opts.headers.Authorization, undefined);
    await assert.rejects(
      () => listProviderModels({
        provider: "ollama",
        apiKey: secret,
        apiBase: "http://10.0.0.8:11434",
        fetchImpl: async () => ({ ok: false, json: async () => ({ error: secret }) }),
      }),
      (err) => {
        assert.equal(err.message.includes(secret), false);
        return true;
      }
    );
  });
});
