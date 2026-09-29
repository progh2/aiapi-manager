const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeSchedule, scheduleAllows, formatSchedule } = require("./schedule");

// 2026-09-29는 화요일. 서울 10:30.
const TUE_1030 = new Date("2026-09-29T01:30:00.000Z");
const TUE_1800 = new Date("2026-09-29T09:00:00.000Z");
const WED_1030 = new Date("2026-09-30T01:30:00.000Z");

const CLASS = [
  { days: [2, 4], start: "09:00", end: "10:50" },
  { days: [5], start: "13:00", end: "14:50" },
];

describe("normalizeSchedule", () => {
  it("비우면 항상 허용", () => {
    assert.deepEqual(normalizeSchedule(null), []);
    assert.deepEqual(normalizeSchedule([]), []);
  });

  it("요일·시간을 정규화한다", () => {
    assert.deepEqual(normalizeSchedule([{ days: [4, 2, 2], start: "09:00", end: "10:50" }]), [
      { days: [2, 4], start: "09:00", end: "10:50" },
    ]);
  });

  it("자정을 넘는 시간대는 거절한다", () => {
    assert.throws(() => normalizeSchedule([{ days: [1], start: "22:00", end: "01:00" }]), /종료는 시작보다/);
  });
});

describe("scheduleAllows", () => {
  it("창이 없으면 항상 허용", () => {
    assert.equal(scheduleAllows([], TUE_1800), true);
  });

  it("여러 시간대 중 하나만 맞아도 허용", () => {
    assert.equal(scheduleAllows(CLASS, TUE_1030), true);
    assert.equal(scheduleAllows(CLASS, new Date("2026-10-02T04:30:00.000Z")), true);
  });

  it("요일이나 시간이 아니면 거절", () => {
    assert.equal(scheduleAllows(CLASS, TUE_1800), false);
    assert.equal(scheduleAllows(CLASS, WED_1030), false);
    assert.equal(scheduleAllows(CLASS, new Date("2026-09-29T01:50:00.000Z")), false);
  });
});

describe("formatSchedule", () => {
  it("화면용 문구", () => {
    assert.equal(formatSchedule([]), "항상");
    assert.equal(formatSchedule(CLASS), "화목 09:00–10:50, 금 13:00–14:50");
  });
});
