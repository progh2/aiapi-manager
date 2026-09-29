const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { applyIssueSchedule, keysFollowingTeam, teamScheduleMetadata, keepCampSchedule } = require("./team-schedule");

const CLASS = [{ days: [2, 4], start: "09:00", end: "10:50" }];

describe("applyIssueSchedule", () => {
  it("시간대를 넣으면 그 키만의 시간으로 둔다", () => {
    const meta = applyIssueSchedule({
      aiapi_schedule: CLASS,
      aiapi_provider_key_id: "pk_test",
    }, { team: { metadata: { aiapi_schedule: [] } } });
    assert.equal(meta.aiapi_schedule_from, "key");
    assert.equal(meta.aiapi_provider_key_id, "pk_test");
    assert.equal(meta.aiapi_schedule.length, 1);
  });

  it("비우고 학급이 있으면 학급 시간표를 복사한다", () => {
    const meta = applyIssueSchedule({ aiapi_schedule: [] }, {
      team: { metadata: { aiapi_schedule: CLASS } },
    });
    assert.equal(meta.aiapi_schedule_from, "team");
    assert.equal(meta.aiapi_schedule[0].start, "09:00");
  });

  it("학급을 만들면서 넣은 시간대는 학급을 따르는 키로 표시한다", () => {
    const meta = applyIssueSchedule({ aiapi_schedule: CLASS }, { teamCreated: true });
    assert.equal(meta.aiapi_schedule_from, "team");
  });
});

describe("keysFollowingTeam", () => {
  it("학급을 따르는 키만 고른다", () => {
    const keys = [
      { token: "a", team_id: "t1", metadata: { aiapi_schedule_from: "team" } },
      { token: "b", team_id: "t1", metadata: { aiapi_schedule_from: "key" } },
      { token: "c", team_id: "t2", metadata: { aiapi_schedule_from: "team" } },
    ];
    assert.deepEqual(keysFollowingTeam(keys, "t1").map((k) => k.token), ["a"]);
  });
});

describe("keepCampSchedule", () => {
  it("캠프 키의 빈 시간표는 학급 시간표를 따르지 않는다", () => {
    const inherited = applyIssueSchedule({ aiapi_schedule: [] }, {
      team: { metadata: { aiapi_schedule: CLASS } },
    });
    const meta = keepCampSchedule(inherited, { metadata: { aiapi_camp: { kind: "camp", code: "CAMP-A7K2" } } });
    assert.equal(meta.aiapi_schedule_from, "key");
    assert.deepEqual(meta.aiapi_schedule, []);
    assert.equal(meta.aiapi_camp.code, "CAMP-A7K2");
  });

  it("캠프 키에 넣은 시간대는 유지한다", () => {
    const meta = keepCampSchedule({
      aiapi_schedule: CLASS,
      aiapi_schedule_from: "key",
      aiapi_camp: { kind: "camp" },
    }, { metadata: { aiapi_camp: { kind: "camp" } } });
    assert.equal(meta.aiapi_schedule_from, "key");
    assert.equal(meta.aiapi_schedule[0].start, "09:00");
  });
});

describe("teamScheduleMetadata", () => {
  it("기존 metadata 를 유지한 채 시간표만 바꾼다", () => {
    const meta = teamScheduleMetadata({ note: "a" }, CLASS);
    assert.equal(meta.note, "a");
    assert.equal(meta.aiapi_schedule.length, 1);
  });
});
