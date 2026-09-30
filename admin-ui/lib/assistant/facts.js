// 엘피가 읽는 운영 사실. 화면(public/js/lib/util.js · store.js)과 같은 규칙으로 키·학급 상태를 센다.
const { scheduleAllows, formatSchedule } = require("../schedule");

const DAY_MS = 86400000;
const RETIRED_RE = /-폐기(-\d+)?$/;
const WEEK = ["일", "월", "화", "수", "목", "금", "토"];

const isRetired = (k) => RETIRED_RE.test(String((k && k.key_alias) || ""));
const isLocked = (x) => Boolean(x && x.metadata && x.metadata.aiapi_lockdown);
const isCamp = (k) => Boolean(k && k.metadata && k.metadata.aiapi_camp);
const isSystemKey = (k) => Boolean(k && k.metadata && k.metadata.aiapi_system);

function money(n) {
  const v = Number(n) || 0;
  // 1센트 미만은 $0.00 으로 뭉개지지 않게 유효 숫자 2자리까지 적는다(아주 싼 모델).
  if (v > 0 && v < 0.01) return `$${v.toFixed(Math.min(8, 1 - Math.floor(Math.log10(v)))).replace(/0+$/, "")}`;
  return `$${v >= 100 ? v.toFixed(0) : v.toFixed(2)}`;
}

function ratio(spend, max) {
  if (max == null || !Number.isFinite(Number(max)) || Number(max) <= 0) return null;
  return (Number(spend) || 0) / Number(max);
}

const pct = (r) => (r == null ? null : Math.round(r * 100));

function seoulNow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map((p) => [p.type, p.value]));
  const ymd = `${parts.year}-${parts.month}-${parts.day}`;
  const wd = WEEK[new Date(`${ymd}T12:00:00+09:00`).getUTCDay()];
  return { ymd, text: `${ymd} (${wd}) ${parts.hour}:${parts.minute}` };
}

function seoulYmd(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return seoulNow(d).ymd;
}

function isExpired(k, now) {
  return Boolean(k.expires) && new Date(k.expires).getTime() < now.getTime();
}

function isExpiringSoon(k, now, days = 7) {
  if (!k.expires) return false;
  const t = new Date(k.expires).getTime();
  return t >= now.getTime() && t <= now.getTime() + days * DAY_MS;
}

// 우선순위: 봉쇄 > 차단 > 만료 > 소진 > 임박 > 사용 중
function keyState(k, now = new Date()) {
  if (k.blocked && isLocked(k)) return { code: "locked", label: "봉쇄" };
  if (k.blocked) return { code: "blocked", label: isRetired(k) ? "폐기" : "차단" };
  if (isExpired(k, now)) return { code: "expired", label: "만료" };
  const r = ratio(k.spend, k.max_budget);
  if (r != null && r >= 1) return { code: "over", label: "예산 소진" };
  if (r != null && r >= 0.8) return { code: "warn", label: "예산 80% 넘음" };
  return { code: "active", label: "사용 중" };
}

function sessionOf(team, now = new Date()) {
  if (isLocked(team)) return { code: "locked", label: "봉쇄 중" };
  const schedule = team && team.metadata && team.metadata.aiapi_schedule;
  if (!Array.isArray(schedule) || !schedule.length) return { code: "always", label: "항상 열림" };
  return scheduleAllows(schedule, now) ? { code: "open", label: "수업 중" } : { code: "closed", label: "수업 외" };
}

const teamLabel = (t) => (t && (t.team_alias || String(t.team_id).slice(0, 8))) || null;

function expiresText(k, now) {
  if (!k.expires) return null;
  const left = Math.ceil((new Date(k.expires).getTime() - now.getTime()) / DAY_MS);
  const day = seoulYmd(k.expires);
  return left < 0 ? `${day} (만료됨)` : `${day} (${left}일 남음)`;
}

function durationText(d) {
  return { "1d": "매일 초기화", "7d": "매주 초기화", "30d": "30일마다 초기화" }[d] || (d ? `${d}마다 초기화` : null);
}

function keyFact(k, teamsById, now) {
  const r = ratio(k.spend, k.max_budget);
  return {
    alias: k.key_alias || "(별칭 없음)",
    class: teamLabel(teamsById.get(k.team_id)) || null,
    state: keyState(k, now).label,
    spend: money(k.spend),
    budget: k.max_budget == null ? "무제한" : money(k.max_budget),
    used_pct: pct(r),
    reset: durationText(k.budget_duration),
    expires: expiresText(k, now),
    models: Array.isArray(k.models) ? k.models.slice(0, 6) : [],
    camp: isCamp(k) || undefined,
  };
}

function classFact(t, keys, now) {
  const own = keys.filter((k) => k.team_id === t.team_id && !isRetired(k));
  const counts = {};
  for (const k of own) {
    const c = keyState(k, now).code;
    counts[c] = (counts[c] || 0) + 1;
  }
  const lock = t.metadata && t.metadata.aiapi_lockdown;
  const r = ratio(t.spend, t.max_budget);
  return {
    class: teamLabel(t),
    session: sessionOf(t, now).label,
    schedule: formatSchedule(t.metadata && t.metadata.aiapi_schedule),
    spend: money(t.spend),
    budget: t.max_budget == null ? "무제한" : money(t.max_budget),
    used_pct: pct(r),
    reset: durationText(t.budget_duration),
    keys: own.length,
    key_states: counts,
    models: Array.isArray(t.models) ? t.models.slice(0, 8) : [],
    lockdown: lock ? { reason: lock.reason || null, keys: lock.keys ?? null } : undefined,
  };
}

function keyCounts(keys, now) {
  const today = seoulNow(now).ymd;
  const out = { total: 0, active: 0, blocked: 0, locked: 0, over: 0, warn: 0, expired: 0, expiring_7d: 0, camp_today: 0 };
  for (const k of keys) {
    if (isRetired(k) || isSystemKey(k)) continue;
    out.total += 1;
    const c = keyState(k, now).code;
    if (c === "active" || c === "warn") out.active += 1;
    if (c === "blocked") out.blocked += 1;
    if (c === "locked") out.locked += 1;
    if (c === "over") out.over += 1;
    if (c === "warn") out.warn += 1;
    if (c === "expired") out.expired += 1;
    if (!k.blocked && isExpiringSoon(k, now)) out.expiring_7d += 1;
    if (isCamp(k) && !k.blocked) {
      const ymd = k.metadata.aiapi_camp.expires_ymd;
      if (ymd ? ymd === today : !isExpired(k, now)) out.camp_today += 1;
    }
  }
  return out;
}

function providerFact(p) {
  const left = p.max_budget == null ? null : (p.remaining ?? (Number(p.max_budget) - Number(p.spend || 0)));
  return {
    name: p.label || p.slug || p.id,
    kind: p.kind === "pool" ? "묶음" : (p.provider_label || p.provider || "공급자"),
    budget: p.max_budget == null ? (p.builtin ? ".env 기본 키(한도 없음)" : "한도 없음") : money(p.max_budget),
    remaining: left == null ? null : money(Math.max(0, left)),
    remaining_pct: left == null ? null : pct(left / Number(p.max_budget)),
    models: (p.models || []).map((m) => m.call_name || m.name).filter(Boolean).slice(0, 8),
  };
}

function failureSummary(items) {
  const by = {};
  let failed = 0;
  for (const it of items || []) {
    if (it.ok) continue;
    failed += 1;
    const label = it.reason || "실패";
    by[label] = (by[label] || 0) + 1;
  }
  const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => ({ reason, count }));
  return { total: (items || []).length, failed, top_reasons: top };
}

// 화면 상단 경보등과 같은 규칙. 심각한 것부터.
function alerts({ keys = [], teams = [], providers = [], activity = [] }, now = new Date()) {
  const out = [];
  const add = (level, text) => out.push({ level, text });
  for (const t of teams) {
    const lock = t.metadata && t.metadata.aiapi_lockdown;
    if (lock) add("crit", `${teamLabel(t)} 봉쇄 중${lock.reason ? ` (${lock.reason})` : ""}`);
    const r = ratio(t.spend, t.max_budget);
    if (r != null && r >= 1) add("crit", `${teamLabel(t)} 학급 예산 소진 (${money(t.spend)} / ${money(t.max_budget)})`);
    else if (r != null && r >= 0.8) add("warn", `${teamLabel(t)} 학급 예산 ${pct(r)}% 사용 (${money(t.spend)} / ${money(t.max_budget)})`);
  }
  for (const p of providers) {
    if (p.builtin || p.max_budget == null || p.remaining == null) continue;
    const left = Number(p.remaining);
    const r = left / Number(p.max_budget);
    if (left <= 0) add("crit", `공급자 "${p.label}" 한도 소진 — 이 키로 가는 호출이 멈춤`);
    else if (r <= 0.2) add("warn", `공급자 "${p.label}" 잔액 ${money(left)} (${pct(r)}%)`);
  }
  const c = keyCounts(keys, now);
  if (c.over) add("warn", `예산 소진 키 ${c.over}개`);
  if (c.warn) add("warn", `예산 80% 넘은 키 ${c.warn}개`);
  if (c.expiring_7d) add("warn", `7일 안에 만료되는 키 ${c.expiring_7d}개`);
  if (c.camp_today) add("info", `오늘 캠프 키 ${c.camp_today}개 사용 중`);
  const f = failureSummary(activity);
  if (f.total >= 10 && f.failed / f.total >= 0.3) add("warn", `최근 호출 실패율 ${pct(f.failed / f.total)}%`);
  const unpriced = (activity || []).filter((it) => it.unpriced);
  if (unpriced.length) {
    const models = [...new Set(unpriced.map((it) => it.model).filter(Boolean))].slice(0, 3).join(", ");
    add("warn", `가격 없는 모델 호출 ${unpriced.length}건(${models}) — 비용이 $0 으로 기록되어 예산이 줄지 않음. litellm 을 다시 시작하면 최신 가격표를 받음`);
  }
  const order = { crit: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

// 대화마다 시스템 프롬프트에 넣는 짧은 상황표. 토큰을 아끼려고 글로 적는다.
function snapshotText({ keys = [], teams = [], providers = [], activity = [] }, now = new Date()) {
  const lines = [];
  const list = alerts({ keys, teams, providers, activity }, now);
  const mark = { crit: "[경보]", warn: "[주의]", info: "[알림]" };
  lines.push(`- 경보: ${list.length ? list.slice(0, 8).map((a) => `${mark[a.level]} ${a.text}`).join(" / ") : "없음"}`);
  const c = keyCounts(keys, now);
  lines.push(`- 키: 전체 ${c.total} · 사용 가능 ${c.active} · 차단 ${c.blocked} · 봉쇄 ${c.locked} · 예산 소진 ${c.over} · 80% 넘음 ${c.warn} · 만료 ${c.expired} · 7일 내 만료 ${c.expiring_7d}${c.camp_today ? ` · 오늘 캠프 ${c.camp_today}` : ""}`);
  const sorted = [...teams].sort((a, b) => String(teamLabel(a)).localeCompare(String(teamLabel(b)), "ko", { numeric: true }));
  const classBits = sorted.slice(0, 15).map((t) => {
    const n = keys.filter((k) => k.team_id === t.team_id && !isRetired(k)).length;
    const budget = t.max_budget == null ? `${money(t.spend)} 사용` : `${money(t.spend)}/${money(t.max_budget)}`;
    return `${teamLabel(t)}(${sessionOf(t, now).label}, ${budget}, 키 ${n})`;
  });
  lines.push(`- 학급/조 ${teams.length}개: ${classBits.join(" · ") || "없음"}${teams.length > 15 ? ` · …외 ${teams.length - 15}개` : ""}`);
  // 학급과 같은 "사용 / 한도" 꼴로 적는다. 작은 모델이 잔액 비율을 사용률로 거꾸로 읽는 일이 있었다.
  const provBits = providers.slice(0, 6).map((p) => {
    const f = providerFact(p);
    return f.remaining == null ? `${f.name}(${f.budget})` : `${f.name}(사용 ${money(p.spend)} / 한도 ${f.budget})`;
  });
  lines.push(`- 공급자 키: ${provBits.join(" · ") || "없음"}`);
  const f = failureSummary(activity);
  lines.push(`- 최근 24시간 호출: ${f.total}건${f.total >= 100 ? " 이상" : ""} · 실패 ${f.failed}${f.top_reasons.length ? ` (${f.top_reasons.map((r) => `${r.reason} ${r.count}`).join(", ")})` : ""}`);
  return lines.join("\n");
}

module.exports = {
  DAY_MS,
  RETIRED_RE,
  isRetired,
  isLocked,
  isCamp,
  isSystemKey,
  money,
  ratio,
  pct,
  seoulNow,
  seoulYmd,
  keyState,
  sessionOf,
  teamLabel,
  keyFact,
  classFact,
  keyCounts,
  providerFact,
  failureSummary,
  alerts,
  snapshotText,
  isExpiringSoon,
};
