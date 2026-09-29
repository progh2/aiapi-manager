const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AssistantStore, isPrivateHost } = require("./store");

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "elfy-"));
  return path.join(dir, "assistant.json");
}

test("처음에는 꺼져 있고 준비되지 않았다", () => {
  const s = new AssistantStore(tmpFile());
  const v = s.publicView();
  assert.equal(v.enabled, false);
  assert.equal(v.ready, false);
  assert.equal(v.has_api_key, false);
});

test("API 키는 응답에 싣지 않고 끝 네 글자만 보여 준다", () => {
  const file = tmpFile();
  const s = new AssistantStore(file);
  const v = s.update({ enabled: true, provider: "openai", api_key: "sk-test-abcdefgh1234", model: "gpt-4.1-mini" });
  assert.equal(v.api_key, undefined);
  assert.equal(v.api_key_hint, "••••1234");
  assert.equal(v.ready, true);
  assert.equal(v.external, true);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.api_key, "sk-test-abcdefgh1234");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("빈 api_key 는 저장된 키를 지우지 않고, clear_api_key 는 지운다", () => {
  const s = new AssistantStore(tmpFile());
  s.update({ provider: "openai", api_key: "sk-keep-00001111" });
  s.update({ api_key: "", model: "gpt-4o-mini" });
  assert.equal(s.get().api_key, "sk-keep-00001111");
  s.update({ clear_api_key: true });
  assert.equal(s.get().api_key, "");
});

test("공급자를 바꾸면 이전 API 키를 버린다", () => {
  const s = new AssistantStore(tmpFile());
  s.update({ provider: "openai", api_key: "sk-openai-99998888" });
  s.update({ provider: "ollama", base_url: "http://192.168.0.20:11434/" });
  assert.equal(s.get().api_key, "");
  assert.equal(s.get().base_url, "http://192.168.0.20:11434");
});

test("Ollama 를 켜려면 주소가 필요하고, 잘못된 주소는 거절한다", () => {
  const s = new AssistantStore(tmpFile());
  assert.throws(() => s.update({ enabled: true, provider: "ollama", model: "qwen3:8b" }), /주소/);
  assert.throws(() => s.update({ base_url: "ftp://x" }), /http/);
  assert.throws(() => s.update({ num_ctx: 100 }), /문맥 길이/);
});

test("사설망 Ollama 는 외부로 보지 않는다", () => {
  const s = new AssistantStore(tmpFile());
  s.update({ enabled: true, provider: "ollama", base_url: "http://192.168.0.20:11434", model: "qwen3:8b" });
  assert.equal(s.publicView().external, false);
  assert.equal(s.publicView().ready, true);
  assert.equal(isPrivateHost("http://10.1.2.3:11434"), true);
  assert.equal(isPrivateHost("https://api.openai.com"), false);
  assert.equal(isPrivateHost("http://host.docker.internal:11434"), true);
});

test("사용량은 서울 기준 달마다 새로 세고 상한을 넘으면 알린다", () => {
  const s = new AssistantStore(tmpFile());
  s.update({ monthly_token_cap: 1000 });
  const sept = new Date("2026-09-30T10:00:00+09:00");
  s.addUsage({ prompt_tokens: 600, completion_tokens: 300 }, sept);
  assert.equal(s.capReached(sept), false);
  s.addUsage({ prompt_tokens: 100, completion_tokens: 50 }, sept);
  assert.equal(s.capReached(sept), true);
  const oct = new Date("2026-10-01T00:30:00+09:00");
  assert.equal(s.capReached(oct), false);
  s.addUsage({ prompt_tokens: 1, completion_tokens: 1 }, oct);
  assert.equal(s.get().usage.month, "2026-10");
  assert.equal(s.get().usage.requests, 1);
});

test("손상된 파일은 덮어쓰지 않는다", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{broken");
  const s = new AssistantStore(file);
  assert.equal(s.isCorrupt(), true);
  assert.throws(() => s.update({ enabled: true }), /손상/);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});

test("프록시 방식은 비서 전용 키와 모델이 있어야 준비된다", () => {
  const s = new AssistantStore(tmpFile());
  s.update({ enabled: true, mode: "proxy", proxy_model: "gpt-4o-mini" });
  assert.equal(s.publicView().ready, false);
  s.setProxyKey("sk-assistant-1234");
  const v = s.publicView();
  assert.equal(v.ready, true);
  assert.equal(v.proxy_key, undefined);
  assert.equal(v.proxy_key_hint, "••••1234");
});
