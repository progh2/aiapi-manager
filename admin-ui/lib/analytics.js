const DAY_MS = 86400000;
const ymd = (d) => d.toISOString().slice(0, 10);

function remainingBudget(maxBudget, spend) {
  if (maxBudget == null) return null;
  const budget = Number(maxBudget);
  if (!Number.isFinite(budget)) return null;
  return budget - (Number(spend) || 0);
}

function forecast(dailySeries, horizonDays) {
  const pts = dailySeries.map((v, i) => [i, v]).filter(([, v]) => v !== null);
  if (pts.length < 3) return null;
  const n = pts.length;
  const sx = pts.reduce((a, [x]) => a + x, 0);
  const sy = pts.reduce((a, [, y]) => a + y, 0);
  const sxx = pts.reduce((a, [x]) => a + x * x, 0);
  const sxy = pts.reduce((a, [x, y]) => a + x * y, 0);
  const denom = n * sxx - sx * sx;
  if (!denom) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const at = (x) => Math.max(0, intercept + slope * x);
  const future = Array.from({ length: horizonDays }, (_, k) => at(n - 1 + k + 1));
  return { slope, fitStart: at(0), fitEnd: at(n - 1), future };
}

function buildAnalytics({ results, keyList, teams, start, end, horizon, teamId = "" }) {
  const teamName = new Map(teams.map((t) => [t.team_id, t.team_alias || t.team_id.slice(0, 8)]));
  const selectedTeam = teamId ? teams.find((t) => t.team_id === teamId) || null : null;
  const meta = new Map(keyList.map((k) => [k.token, {
    alias: k.key_alias || k.token.slice(0, 8),
    team_id: k.team_id || null,
    team: k.team_id ? teamName.get(k.team_id) || "(삭제된 그룹)" : null,
    budget: k.max_budget ?? null,
  }]));
  const allowedTokens = teamId
    ? new Set(keyList.filter((k) => k.team_id === teamId).map((k) => k.token))
    : null;

  const byDate = new Map();
  const perKey = new Map();
  const perModel = new Map();

  for (const r of results) {
    const cur = byDate.get(r.date) || { spend: 0, requests: 0, tokens: 0 };
    for (const [m, v] of Object.entries(r.breakdown?.models || {})) {
      perModel.set(m, (perModel.get(m) || 0) + (v.metrics?.spend || 0));
    }
    if (allowedTokens) {
      for (const [hash, v] of Object.entries(r.breakdown?.api_keys || {})) {
        if (!allowedTokens.has(hash)) continue;
        cur.spend += v.metrics?.spend || 0;
        cur.requests += v.metrics?.api_requests || 0;
        cur.tokens += v.metrics?.total_tokens || 0;
      }
    } else {
      cur.spend += r.metrics?.spend || 0;
      cur.requests += r.metrics?.api_requests || 0;
      cur.tokens += r.metrics?.total_tokens || 0;
    }
    byDate.set(r.date, cur);

    for (const [hash, v] of Object.entries(r.breakdown?.api_keys || {})) {
      if (allowedTokens && !allowedTokens.has(hash)) continue;
      const keyCur = perKey.get(hash) || { spend: 0, requests: 0 };
      keyCur.spend += v.metrics?.spend || 0;
      keyCur.requests += v.metrics?.api_requests || 0;
      perKey.set(hash, keyCur);
    }
  }

  const dates = [];
  const dailyRows = [];
  for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
    const key = ymd(new Date(t));
    const v = byDate.get(key) || { spend: 0, requests: 0, tokens: 0 };
    dates.push(key);
    dailyRows.push(v);
  }

  let running = 0;
  const daily = dailyRows.map((d) => d.spend);
  const cumulative = daily.map((spend) => (running += spend));
  const fc = forecast(cumulative, horizon);
  const futureDates = Array.from({ length: horizon }, (_, k) => ymd(new Date(end.getTime() + (k + 1) * DAY_MS)));

  const keyStats = [...perKey.entries()].map(([hash, v]) => {
    const m = meta.get(hash);
    const budget = m?.budget ?? null;
    return {
      alias: m?.alias || hash.slice(0, 8),
      team: m?.team || null,
      budget,
      max_budget: budget,
      remaining: remainingBudget(budget, v.spend),
      deleted: !m,
      ...v,
    };
  }).filter((k) => k.spend > 0).sort((a, b) => b.spend - a.spend);

  const perTeam = new Map();
  for (const k of keyStats) {
    const name = k.team || "학급 없음";
    const cur = perTeam.get(name) || { name, spend: 0, budget: null, max_budget: null, remaining: null };
    cur.spend += k.spend;
    if (k.team) {
      const team = teams.find((t) => (t.team_alias || t.team_id.slice(0, 8)) === k.team);
      const budget = team?.max_budget ?? null;
      cur.budget = budget;
      cur.max_budget = budget;
      cur.remaining = remainingBudget(budget, cur.spend);
    }
    perTeam.set(name, cur);
  }

  const totalSpend = cumulative.at(-1) || 0;
  const budgetTotal = teamId
    ? (selectedTeam?.max_budget ?? null)
    : teams.reduce((sum, t) => sum + (t.max_budget || 0), 0);

  return {
    dates,
    daily,
    requests: dailyRows.map((d) => d.requests),
    cumulative,
    futureDates,
    forecast: fc,
    keyStats,
    teamStats: [...perTeam.values()].filter((t) => t.spend > 0).sort((a, b) => b.spend - a.spend),
    modelStats: [...perModel.entries()].map(([name, spend]) => ({ name, spend }))
      .filter((m) => m.spend > 0).sort((a, b) => b.spend - a.spend),
    totalSpend,
    budget: {
      total: budgetTotal,
      remaining: remainingBudget(budgetTotal, totalSpend),
      team_id: selectedTeam?.team_id || null,
      team: selectedTeam ? (selectedTeam.team_alias || selectedTeam.team_id.slice(0, 8)) : null,
    },
  };
}

module.exports = {
  DAY_MS,
  ymd,
  remainingBudget,
  forecast,
  buildAnalytics,
};
