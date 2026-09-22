const test = require("node:test");
const assert = require("node:assert/strict");
const { checkAlias } = require("./aliases");

test("이미 있는 별칭은 건너뛰고, 성공 후에만 다음 중복을 막는다", () => {
  const existing = new Set(["20261001-홍길동"]);
  assert.equal(checkAlias(existing, "20261001-홍길동").skipped, true);
  const first = checkAlias(existing, "20261002-김철수");
  assert.equal(first.error, undefined);
  assert.equal(existing.has("20261002-김철수"), false);
  existing.add(first.alias);
  assert.equal(checkAlias(existing, "20261002-김철수").skipped, true);
  assert.equal(checkAlias(existing, "  ").error, "별칭이 필요합니다");
});
