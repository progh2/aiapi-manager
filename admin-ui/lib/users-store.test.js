const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { UsersStore } = require("./users-store");

function tempPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "users-store-"));
  return path.join(dir, "users.json");
}

test("정상 저장은 임시 파일을 남기지 않는다", () => {
  const file = tempPath();
  const store = new UsersStore(file);
  store.add({ email: "a@school.edu", name: "에이" }, "admin@school.edu");
  const again = new UsersStore(file);
  assert.equal(again.get("A@school.edu").name, "에이");
  assert.equal(fs.existsSync(`${file}.${process.pid}.tmp`), false);
  const raw = fs.readFileSync(file, "utf8");
  assert.equal(JSON.parse(raw).users.length, 1);
});

test("손상된 파일은 빈 목록으로 덮어쓰지 않는다", () => {
  const file = tempPath();
  fs.writeFileSync(file, "{not json");
  const store = new UsersStore(file);
  assert.equal(store.isCorrupt(), true);
  assert.throws(() => store.add({ email: "a@school.edu" }, "admin@school.edu"));
  assert.equal(fs.readFileSync(file, "utf8"), "{not json");
});
