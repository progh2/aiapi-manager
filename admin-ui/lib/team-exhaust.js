// 학급 예산은 합치지 않는다. 각 학급의 남은 예산과 기간 지출 속도로 가장 빠른 소진만 고른다.

function soonestTeam({ teams, teamStats, days }) {
  const windowByName = new Map((teamStats || []).map((t) => [t.name, t.spend]));
  let best = null;
  for (const t of teams || []) {
    if (t.max_budget == null || t.max_budget === "") continue;
    const budget = Number(t.max_budget);
    if (!Number.isFinite(budget)) continue;
    const spent = Number(t.spend) || 0;
    const left = budget - spent;
    const name = t.team_alias || String(t.team_id || "").slice(0, 8) || "(이름 없음)";
    const windowSpend = windowByName.get(name) || 0;
    const rate = days > 0 ? windowSpend / days : 0;
    const daysLeft = left <= 0 ? 0 : rate > 0 ? Math.ceil(left / rate) : null;
    const row = { name, budget, spent, left, daysLeft };
    const score = (r) => (r.daysLeft == null ? Infinity : r.daysLeft);
    if (!best || score(row) < score(best)) best = row;
  }
  return best;
}

module.exports = { soonestTeam };
