const test = require("node:test");
const assert = require("node:assert/strict");
const { soonestTeam } = require("./team-exhaust");

test("예산 합이 아니라 더 빨리 끝나는 학급을 고른다", () => {
  const row = soonestTeam({
    days: 10,
    teams: [
      { team_alias: "A반", max_budget: 50, spend: 10 },
      { team_alias: "B반", max_budget: 20, spend: 10 },
    ],
    teamStats: [
      { name: "A반", spend: 10 },
      { name: "B반", spend: 10 },
    ],
  });
  assert.equal(row.name, "B반");
  assert.equal(row.daysLeft, 10);
  assert.equal(row.left, 10);
});

test("기간 지출이 커도 현재 spend가 예산 아래면 초과가 아니다", () => {
  const row = soonestTeam({
    days: 90,
    teams: [{ team_alias: "A반", max_budget: 50, spend: 20 }],
    teamStats: [{ name: "A반", spend: 120 }],
  });
  assert.ok(row.daysLeft > 0);
  assert.equal(row.left, 30);
});
