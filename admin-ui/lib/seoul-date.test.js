const test = require("node:test");
const assert = require("node:assert/strict");
const { ymdInSeoul, seoulDateRange } = require("./seoul-date");

test("UTC 자정 직후는 한국 날짜로 같은 날이다", () => {
  // 2026-03-15 00:30 UTC = 2026-03-15 09:30 KST
  assert.equal(ymdInSeoul(new Date("2026-03-15T00:30:00Z")), "2026-03-15");
  // 2026-03-14 16:30 UTC = 2026-03-15 01:30 KST
  assert.equal(ymdInSeoul(new Date("2026-03-14T16:30:00Z")), "2026-03-15");
  // 2026-03-14 14:30 UTC = 2026-03-14 23:30 KST
  assert.equal(ymdInSeoul(new Date("2026-03-14T14:30:00Z")), "2026-03-14");
});

test("기간 날짜는 한국 오늘을 끝으로 빈틈 없이 이어진다", () => {
  const range = seoulDateRange(3, 2, new Date("2026-03-14T16:30:00Z"));
  assert.deepEqual(range, {
    start: "2026-03-13",
    end: "2026-03-15",
    dates: ["2026-03-13", "2026-03-14", "2026-03-15"],
    futureDates: ["2026-03-16", "2026-03-17"],
  });
});
