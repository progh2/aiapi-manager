const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { UsersStore } = require("./users-store");
const { linkStudentAccounts } = require("./user-link");

const store = () => new UsersStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "users-")), "users.json"));

test("이메일이 있는 발급 줄은 계정을 만들고 키를 연결한다", () => {
  const users = store();
  const rows = [
    { alias: "20261001-홍길동", name: "홍길동", email: "hong@school.kr", key: "k1" },
    { alias: "20261002-김철수", name: "김철수", key: "k2" },
  ];
  const out = linkStudentAccounts(users, rows, { by: "t@school.kr" });
  assert.deepEqual(out, { created: 1, linked: 0, unchanged: 0, failed: 0 });
  assert.equal(rows[0].account, "created");
  assert.equal(rows[1].account, undefined);
  assert.deepEqual(users.get("hong@school.kr").key_aliases, ["20261001-홍길동"]);
  assert.equal(users.get("hong@school.kr").created_by, "t@school.kr");
});

test("이미 있는 계정에는 별칭을 더하고, 같은 별칭은 두 번 넣지 않는다", () => {
  const users = store();
  users.add({ email: "hong@school.kr", name: "홍길동", key_aliases: ["캡스톤-홍길동"] }, "t");
  const rows = [
    { alias: "20261001-홍길동", email: "Hong@School.kr", key: "k1" },
    { alias: "캡스톤-홍길동", email: "hong@school.kr", skipped: true, error: "이미 있는 별칭" },
  ];
  const out = linkStudentAccounts(users, rows, {});
  assert.deepEqual(out, { created: 0, linked: 1, unchanged: 1, failed: 0 });
  assert.deepEqual(users.get("hong@school.kr").key_aliases, ["캡스톤-홍길동", "20261001-홍길동"]);
});

test("발급에 실패한 줄과 관리자 이메일은 계정을 만들지 않는다", () => {
  const users = store();
  const rows = [
    { alias: "a", email: "x@school.kr", error: "예산 오류" },
    { alias: "b", email: "teacher@school.kr", key: "k" },
  ];
  const out = linkStudentAccounts(users, rows, { adminEmails: new Set(["teacher@school.kr"]) });
  assert.deepEqual(out, { created: 0, linked: 0, unchanged: 0, failed: 0 });
  assert.equal(rows[1].account, "admin");
  assert.equal(users.list().length, 0);
});

test("명단 파일이 손상됐으면 줄마다 오류를 남긴다", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "users-")), "users.json");
  fs.writeFileSync(file, "{bad");
  const users = new UsersStore(file);
  const rows = [{ alias: "a", email: "x@school.kr", key: "k" }];
  const out = linkStudentAccounts(users, rows, {});
  assert.equal(out.failed, 1);
  assert.equal(rows[0].account, "error");
});
