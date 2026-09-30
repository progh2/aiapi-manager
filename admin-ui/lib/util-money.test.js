const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// 관리 화면 금액 표시(public/js/lib/util.js). 브라우저 모듈이지만 money 는 DOM 을 쓰지 않는다.
let money;
before(async () => {
  ({ money } = await import(pathToFileURL(path.join(__dirname, "../public/js/lib/util.js")).href));
});

describe("관리 화면 금액", () => {
  it("진짜 0 은 $0, 1센트 미만은 반올림으로 0 처럼 보이지 않는다", () => {
    assert.equal(money(0), "$0");
    assert.equal(money(0.00035), "$0.00035"); // GPT-6 Luna 3천 토큰쯤
    assert.equal(money(0.000012), "$0.000012");
    assert.equal(money(0.0099), "$0.0099");
    assert.equal(money(0.000000001), "<$0.00000001");
  });
  it("1센트 이상은 전과 같다", () => {
    assert.equal(money(0.342), "$0.342");
    assert.equal(money(2), "$2.00");
    assert.equal(money(150), "$150");
    assert.equal(money(-0.0005), "-$0.0005");
    assert.equal(money(null), "—");
  });
});
