const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AuditLog, sanitizeDetail } = require("./audit-log");

function tempPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-log-"));
  return path.join(dir, "audit.jsonl");
}

test("작업을 붙이면 다시 열어도 최신순으로 나온다", () => {
  const file = tempPath();
  const log = new AuditLog(file);
  log.append({ actor: "t@school.kr", action: "key.issue", target: "20261001-홍길동", at: new Date("2026-09-29T01:00:00Z") });
  log.append({ actor: "t@school.kr", action: "key.block", target: "20261001-홍길동", at: new Date("2026-09-29T02:00:00Z") });
  const again = new AuditLog(file);
  const rows = again.list();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].action, "key.block");
  assert.equal(rows[1].action, "key.issue");
});

test("비밀 키 값은 기록하지 않고 별칭은 남긴다", () => {
  const out = sanitizeDetail({
    key: "sk-secret",
    api_key: "sk-real",
    master_key: "sk-master",
    token: "abc",
    key_alias: "20261001-홍길동",
    budget: 2,
    nested: { api_key: "x", models: ["gpt-4o-mini"] },
  });
  assert.deepEqual(out, {
    key_alias: "20261001-홍길동",
    budget: 2,
    nested: { models: ["gpt-4o-mini"] },
  });
});

test("보관 한도를 넘으면 오래된 기록부터 버리고 파일도 줄인다", () => {
  const file = tempPath();
  const log = new AuditLog(file, { maxEntries: 10 });
  for (let i = 0; i < 30; i++) log.append({ actor: "a", action: "key.issue", target: `k${i}` });
  assert.equal(log.size(), 10);
  assert.equal(log.list({ limit: 1 })[0].target, "k29");
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.ok(lines.length <= 13, `파일 줄 수 ${lines.length}`);
  const again = new AuditLog(file, { maxEntries: 10 });
  assert.equal(again.list({ limit: 100 }).at(-1).target, "k20");
});

test("깨진 줄은 건너뛰고 나머지를 읽는다", () => {
  const file = tempPath();
  fs.writeFileSync(file, [
    JSON.stringify({ at: "2026-09-29T00:00:00Z", action: "team.create", actor: "a", target: "3A" }),
    "{half written",
    "",
    JSON.stringify({ at: "2026-09-29T00:01:00Z", action: "team.delete", actor: "a", target: "3A" }),
  ].join("\n"));
  const log = new AuditLog(file);
  assert.equal(log.size(), 2);
  assert.equal(log.skipped, 1);
});

test("종류·사람·검색어로 거른다", () => {
  const log = new AuditLog(tempPath());
  log.append({ actor: "a@x", action: "key.issue", target: "홍길동" });
  log.append({ actor: "b@x", action: "key.block", target: "김철수" });
  log.append({ actor: "a@x", action: "team.create", target: "3학년A반" });
  assert.equal(log.list({ action: "key." }).length, 2);
  assert.equal(log.list({ actor: "b@x" }).length, 1);
  assert.equal(log.list({ q: "3학년" })[0].action, "team.create");
});

test("기록 파일을 쓸 수 없어도 예외를 던지지 않는다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-ro-"));
  const log = new AuditLog(path.join(dir, "a", "b"));
  fs.writeFileSync(path.join(dir, "a"), "파일이라 디렉터리를 못 만든다");
  assert.doesNotThrow(() => log.append({ actor: "a", action: "key.issue" }));
  assert.equal(log.size(), 1);
});
