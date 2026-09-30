const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { KeyVault, hashKey } = require("./key-vault");

// 시험용 가짜 키. 비밀 탐지기가 진짜 키로 오인하지 않도록 뜻 없는 글자로 만든다.
const fakeKey = (tail) => `sk-${"x".repeat(18)}${tail}`;
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vault-")), "key-vault.json");

test("넣은 키를 LiteLLM token(sha256)으로 다시 꺼낸다", () => {
  const v = new KeyVault(tmpFile(), "master-secret");
  const key = fakeKey("7Q2x");
  const token = v.put(key, { alias: "20261001-홍길동" });
  assert.equal(token, hashKey(key));
  assert.equal(v.has(token), true);
  assert.equal(v.get(token), key);
  assert.equal(v.hint(token), "7Q2x");
  assert.equal(v.size(), 1);
});

test("파일에는 원문이 없고 권한은 600 이며, 다시 열어도 꺼낼 수 있다", () => {
  const file = tmpFile();
  const key = fakeKey("A1b2");
  const token = new KeyVault(file, "s").put(key);
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes("xxxxxxxxxxxx"), "원문이 파일에 남았습니다");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(new KeyVault(file, "s").get(token), key);
});

test("비밀 값이 다르면 풀지 못한다", () => {
  const file = tmpFile();
  const token = new KeyVault(file, "old-master").put(fakeKey("zzzz"));
  assert.equal(new KeyVault(file, "new-master").get(token), null);
});

test("없는 키·지운 키는 null", () => {
  const v = new KeyVault(tmpFile(), "s");
  const a = v.put(fakeKey("0001"));
  const b = v.put(fakeKey("0002"));
  assert.equal(v.remove([a, "nope"]), 1);
  assert.equal(v.get(a), null);
  assert.equal(v.get(b), fakeKey("0002"));
  assert.equal(v.get("unknown"), null);
  assert.equal(v.has(null), false);
});

test("손상된 파일은 덮어쓰지 않는다", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{broken");
  const v = new KeyVault(file, "s");
  assert.equal(v.isCorrupt(), true);
  assert.throws(() => v.put(fakeKey("0003")), /손상/);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});

test("비밀 값 없이는 만들지 않는다", () => {
  assert.throws(() => new KeyVault(tmpFile(), ""), /비밀 값/);
});
