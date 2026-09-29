// 엘피가 쓰는 도구.
// - read: 데이터를 읽기만 한다.
// - propose: 바꾸는 작업을 "제안 카드"로만 만든다. 실제 변경은 선생님이 화면에서 [실행]을 눌러
//   기존 관리 API(/api/keys/adjust/bulk 등)를 부를 때 일어난다. 모델이 직접 바꾸는 길은 없다.
// - client: 화면 이동처럼 브라우저가 할 일.
const crypto = require("crypto");
const F = require("./facts");

const STATIONS = {
  bridge: "개요", telemetry: "사용량", keys: "키 관리", classes: "학급/조", launch: "키 발급",
  engines: "공급자", crew: "사용자", log: "기록", ai: "AI 엘피",
};
const KEY_STATES = ["active", "warn", "over", "expiring", "expired", "blocked", "locked", "camp"];
const STATE_LABEL = {
  active: "사용 중", warn: "예산 80% 넘음", over: "예산 소진", expiring: "7일 안 만료", expired: "만료",
  blocked: "차단", locked: "봉쇄", camp: "캠프 키",
};
const MAX_TOPUP = 50;
const MAX_DAYS = 365;
const MAX_CLASS_BUDGET = 10000;
const LIST_LINES = 8;

function toolError(message) {
  const err = new Error(message);
  err.tool = true;
  return err;
}

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");

// ---------------------------------------------------------------- 대상 찾기
function findClass(name, teams) {
  const q = norm(name);
  if (!q) return null;
  const exact = teams.filter((t) => norm(F.teamLabel(t)) === q || t.team_id === name);
  if (exact.length === 1) return exact[0];
  const part = teams.filter((t) => norm(F.teamLabel(t)).includes(q) || q.includes(norm(F.teamLabel(t))));
  if (part.length === 1) return part[0];
  const names = teams.map((t) => F.teamLabel(t)).slice(0, 30).join(", ");
  if (part.length > 1) throw toolError(`"${name}" 에 맞는 학급이 여러 개입니다: ${part.map((t) => F.teamLabel(t)).join(", ")}. 어느 학급인지 선생님께 물어보세요.`);
  throw toolError(`"${name}" 학급을 찾지 못했습니다. 있는 학급: ${names || "없음"}`);
}

function findKeysByAlias(list, keys) {
  const found = new Map();
  const missing = [];
  for (const raw of list) {
    const q = norm(raw);
    if (!q) continue;
    const exact = keys.filter((k) => norm(k.key_alias) === q);
    const hits = exact.length ? exact : keys.filter((k) => norm(k.key_alias).includes(q));
    if (!hits.length) missing.push(raw);
    else if (hits.length > 1 && !exact.length) {
      throw toolError(`"${raw}" 에 맞는 키가 여러 개입니다: ${hits.slice(0, 10).map((k) => k.key_alias).join(", ")}${hits.length > 10 ? " …" : ""}. 어느 키인지 선생님께 물어보세요.`);
    } else for (const k of hits) found.set(k.token, k);
  }
  if (missing.length) throw toolError(`키를 찾지 못했습니다: ${missing.join(", ")}. 별칭(예: 20261001-홍길동)이나 이름을 다시 확인하세요.`);
  return [...found.values()];
}

function matchState(k, state, now) {
  if (!state || state === "all") return true;
  if (state === "expiring") return !k.blocked && F.isExpiringSoon(k, now);
  if (state === "camp") return F.isCamp(k);
  const code = F.keyState(k, now).code;
  if (state === "active") return code === "active" || code === "warn";
  return code === state;
}

function resolveTargets(target = {}, { keys, teams }, now) {
  let pool = keys.filter((k) => !F.isRetired(k) && !F.isSystemKey(k));
  let team = null;
  if (target.class) {
    team = findClass(target.class, teams);
    pool = pool.filter((k) => k.team_id === team.team_id);
  }
  const aliases = Array.isArray(target.aliases) ? target.aliases.filter(Boolean) : target.aliases ? [target.aliases] : [];
  if (aliases.length) pool = findKeysByAlias(aliases, pool);
  if (target.state && target.state !== "all") {
    if (!KEY_STATES.includes(target.state)) throw toolError(`state 는 ${KEY_STATES.join(", ")} 중 하나입니다`);
    pool = pool.filter((k) => matchState(k, target.state, now));
  }
  if (!team && !aliases.length && !target.state) {
    throw toolError("대상이 없습니다. 학급(class), 키 별칭(aliases), 상태(state) 중 하나 이상을 정하세요.");
  }
  const scope = [
    team ? F.teamLabel(team) : null,
    aliases.length ? (aliases.length === 1 ? aliases[0] : `키 ${aliases.length}개 지정`) : null,
    target.state && target.state !== "all" ? STATE_LABEL[target.state] : null,
  ].filter(Boolean).join(" · ");
  return { keys: pool, team, wholeClass: Boolean(team && !aliases.length && (!target.state || target.state === "all")), scope };
}

function listLines(keys, fmt) {
  const sorted = [...keys].sort((a, b) => String(a.key_alias || "").localeCompare(String(b.key_alias || ""), "ko", { numeric: true }));
  const lines = sorted.slice(0, LIST_LINES).map(fmt);
  if (sorted.length > LIST_LINES) lines.push(`…외 ${sorted.length - LIST_LINES}개`);
  return lines;
}

function newProposal(fields) {
  return { id: `p_${crypto.randomBytes(5).toString("hex")}`, created_at: new Date().toISOString(), ...fields };
}

function proposalResult(p, extra = {}) {
  return {
    proposal_shown: true,
    title: p.title,
    summary: p.summary,
    targets: p.count,
    status: "아직 실행 전입니다. 선생님이 화면의 제안 카드에서 [실행]을 눌러야 진행됩니다.",
    ...extra,
  };
}

function numberArg(v, name, { min, max, integer = false } = {}) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw toolError(`${name} 은(는) 숫자여야 합니다`);
  if (integer && !Number.isInteger(n)) throw toolError(`${name} 은(는) 정수여야 합니다`);
  if (n < min || n > max) throw toolError(`${name} 은(는) ${min}~${max} 사이여야 합니다`);
  return n;
}

// ---------------------------------------------------------------- 스키마 조각
const TARGET_SCHEMA = {
  type: "object",
  description: "대상 키. class·aliases·state 를 함께 주면 모두 만족하는 키만 고른다.",
  properties: {
    class: { type: "string", description: "학급/조 이름 (예: 3학년A반)" },
    aliases: { type: "array", items: { type: "string" }, description: "키 별칭이나 학생 이름 목록 (예: [\"20261001-홍길동\"])" },
    state: { type: "string", enum: KEY_STATES, description: "키 상태로 거르기: active 사용 중, warn 예산 80% 넘음, over 예산 소진, expiring 7일 안 만료, expired 만료, blocked 차단, locked 봉쇄, camp 캠프 키" },
  },
};

// ---------------------------------------------------------------- 관리자 도구
const ADMIN_TOOLS = [
  {
    name: "get_overview",
    kind: "read",
    label: "전체 상황 확인",
    description: "지금 운영 상황 요약: 경보, 키 상태별 개수, 학급별 예산·수업 상태, 공급자 잔액, 최근 24시간 호출과 실패 이유.",
    parameters: { type: "object", properties: {} },
    async run(_args, ctx) {
      const [keys, teams, providers, activity] = await Promise.all([ctx.data.keys(), ctx.data.teams(), ctx.data.providers(), ctx.data.activity({ hours: 24, limit: 100 })]);
      const now = ctx.now;
      const result = {
        now: F.seoulNow(now).text,
        alerts: F.alerts({ keys, teams, providers, activity }, now),
        keys: F.keyCounts(keys, now),
        classes: teams.slice(0, 25).map((t) => F.classFact(t, keys, now)),
        providers: providers.map(F.providerFact),
        calls_24h: F.failureSummary(activity),
      };
      return { result, summary: `경보 ${result.alerts.length}건 · 키 ${result.keys.total}개 · 학급 ${teams.length}개` };
    },
  },
  {
    name: "list_classes",
    kind: "read",
    label: "학급 살펴보기",
    description: "학급/조 목록과 예산·사용액·초기화 주기·수업 시간표·지금 수업 상태·키 상태별 개수·허용 모델·봉쇄 여부. name 을 주면 그 학급만.",
    parameters: { type: "object", properties: { name: { type: "string", description: "학급/조 이름 (생략하면 전체)" } } },
    async run(args, ctx) {
      const [keys, teams] = await Promise.all([ctx.data.keys(), ctx.data.teams()]);
      const list = args.name ? [findClass(args.name, teams)] : teams;
      const classes = list.slice(0, 30).map((t) => F.classFact(t, keys, ctx.now));
      return { result: { count: list.length, classes }, summary: args.name ? `${F.teamLabel(list[0])} 확인` : `학급 ${list.length}개 확인` };
    },
  },
  {
    name: "find_keys",
    kind: "read",
    label: "키 찾기",
    description: "학생 키를 찾는다. 학급·상태·검색어로 거른다. 결과는 사용률이 높은 순.",
    parameters: {
      type: "object",
      properties: {
        class: { type: "string", description: "학급/조 이름" },
        state: { type: "string", enum: [...KEY_STATES, "all"], description: "키 상태 (생략하면 전체)" },
        search: { type: "string", description: "별칭·이름 일부" },
        limit: { type: "integer", description: "최대 개수 (기본 15, 최대 30)" },
      },
    },
    async run(args, ctx) {
      const [keys, teams] = await Promise.all([ctx.data.keys(), ctx.data.teams()]);
      const now = ctx.now;
      let pool = keys.filter((k) => !F.isRetired(k) && !F.isSystemKey(k));
      if (args.class) {
        const t = findClass(args.class, teams);
        pool = pool.filter((k) => k.team_id === t.team_id);
      }
      if (args.state && args.state !== "all") pool = pool.filter((k) => matchState(k, args.state, now));
      if (args.search) pool = pool.filter((k) => norm(k.key_alias).includes(norm(args.search)));
      const limit = Math.min(30, Math.max(1, Number(args.limit) || 15));
      const teamsById = new Map(teams.map((t) => [t.team_id, t]));
      const sorted = pool.sort((a, b) => (F.ratio(b.spend, b.max_budget) ?? -1) - (F.ratio(a.spend, a.max_budget) ?? -1));
      return {
        result: { count: pool.length, shown: Math.min(limit, pool.length), keys: sorted.slice(0, limit).map((k) => F.keyFact(k, teamsById, now)) },
        summary: `키 ${pool.length}개 찾음`,
      };
    },
  },
  {
    name: "recent_calls",
    kind: "read",
    label: "최근 호출 확인",
    description: "학생들의 최근 AI 호출 기록과 실패 이유(한국어). 프롬프트 내용은 없다. 왜 막혔는지 물을 때 쓴다.",
    parameters: {
      type: "object",
      properties: {
        hours: { type: "integer", description: "최근 몇 시간 (기본 24, 최대 72)" },
        only_failed: { type: "boolean", description: "실패한 호출만" },
        class: { type: "string", description: "학급/조 이름" },
        alias: { type: "string", description: "키 별칭이나 학생 이름" },
        limit: { type: "integer", description: "보여 줄 개수 (기본 15, 최대 30)" },
      },
    },
    async run(args, ctx) {
      const hours = Math.min(72, Math.max(1, Number(args.hours) || 24));
      let items = await ctx.data.activity({ hours, limit: 100, status: args.only_failed ? "failure" : "" });
      if (args.only_failed) items = items.filter((it) => !it.ok);
      if (args.class) {
        const teams = await ctx.data.teams();
        const t = findClass(args.class, teams);
        items = items.filter((it) => it.team_id === t.team_id);
      }
      if (args.alias) items = items.filter((it) => norm(it.alias).includes(norm(args.alias)));
      const limit = Math.min(30, Math.max(1, Number(args.limit) || 15));
      const summary = F.failureSummary(items);
      const calls = items.slice(0, limit).map((it) => ({
        time: F.seoulNow(new Date(it.at)).text.slice(5),
        alias: it.alias,
        class: it.team,
        model: it.model,
        ok: it.ok,
        reason: it.ok ? undefined : it.reason,
        tokens: it.tokens || undefined,
      }));
      return { result: { hours, ...summary, calls }, summary: `호출 ${summary.total}건 · 실패 ${summary.failed}건` };
    },
  },
  {
    name: "usage_report",
    kind: "read",
    label: "사용량 분석",
    description: "기간 사용액(USD)·하루 평균·예산 대비 잔액·월말까지 예측·많이 쓴 키/학급/모델·예산이 가장 먼저 바닥날 학급.",
    parameters: {
      type: "object",
      properties: {
        days: { type: "integer", description: "최근 며칠 (7~90, 기본 30)" },
        class: { type: "string", description: "학급/조 이름 (생략하면 전체)" },
      },
    },
    async run(args, ctx) {
      const days = Math.min(90, Math.max(7, Number(args.days) || 30));
      let teamId = "";
      if (args.class) teamId = findClass(args.class, await ctx.data.teams()).team_id;
      const a = await ctx.data.analytics({ days, teamId });
      const daily = a.daily || [];
      const last7 = daily.slice(-7).reduce((s, v) => s + v, 0);
      const fc = a.forecast || null;
      const result = {
        days,
        class: a.budget && a.budget.team,
        total_spend: F.money(a.totalSpend),
        daily_avg_last7: F.money(last7 / Math.min(7, daily.length || 1)),
        busiest_day: daily.length ? (() => { const i = daily.indexOf(Math.max(...daily)); return `${a.dates[i]} ${F.money(daily[i])}`; })() : null,
        requests: (a.requests || []).reduce((s, v) => s + v, 0),
        budget_total: a.budget && a.budget.total != null ? F.money(a.budget.total) : null,
        budget_remaining: a.budget && a.budget.remaining != null ? F.money(a.budget.remaining) : null,
        forecast_next_14d: fc && Array.isArray(fc.future) && fc.future.length ? F.money(Math.max(0, fc.future.at(-1) - (a.totalSpend || 0))) : null,
        trend_per_day: fc && Number.isFinite(fc.slope) ? F.money(Math.max(0, fc.slope)) : null,
        top_keys: (a.keyStats || []).slice(0, 8).map((k) => ({ alias: k.alias, class: k.team, spend: F.money(k.spend), budget: k.budget == null ? "무제한" : F.money(k.budget), requests: k.requests })),
        top_classes: (a.teamStats || []).slice(0, 8).map((t) => ({ class: t.name, spend: F.money(t.spend), budget: t.budget == null ? "무제한" : F.money(t.budget) })),
        top_models: (a.modelStats || []).slice(0, 6).map((m) => ({ model: m.name, spend: F.money(m.spend) })),
        soonest_exhaust: a.soonestTeam ? { class: a.soonestTeam.name, days_left: a.soonestTeam.daysLeft, left: F.money(Math.max(0, a.soonestTeam.left || 0)) } : null,
      };
      return { result, summary: `${days}일 사용액 ${result.total_spend}` };
    },
  },
  {
    name: "list_providers",
    kind: "read",
    label: "공급자 키 확인",
    description: "실제 AI 회사 API 키(공급자 키)와 묶음의 한도·잔액·모델.",
    parameters: { type: "object", properties: {} },
    async run(_args, ctx) {
      const providers = await ctx.data.providers();
      return { result: { providers: providers.map(F.providerFact) }, summary: `공급자 ${providers.length}개 확인` };
    },
  },
  {
    name: "recent_admin_actions",
    kind: "read",
    label: "작업 기록 확인",
    description: "관리자가 최근에 한 작업(발급·충전·차단·봉쇄 등) 기록.",
    parameters: { type: "object", properties: { search: { type: "string", description: "대상·작업 검색어" }, limit: { type: "integer", description: "최대 20" } } },
    async run(args, ctx) {
      const entries = ctx.data.audit({ limit: Math.min(20, Math.max(1, Number(args.limit) || 10)), q: args.search || "" });
      return {
        result: {
          entries: entries.map((e) => ({
            time: F.seoulNow(new Date(e.at)).text,
            by: String(e.actor || "").split("@")[0] || null,
            action: e.action,
            target: e.target,
            via: e.detail && e.detail.via === "elfy" ? "엘피 제안" : undefined,
          })),
        },
        summary: `기록 ${entries.length}건 확인`,
      };
    },
  },
  {
    name: "propose_topup",
    kind: "propose",
    label: "충전·연장 제안",
    description: "키 예산 충전(add_budget, USD, 키마다 더함)이나 만료 연장(add_days)을 제안 카드로 만든다. 실행은 선생님이 누른다.",
    parameters: {
      type: "object",
      properties: {
        target: TARGET_SCHEMA,
        add_budget: { type: "number", description: `키마다 더할 예산(USD), 0 초과 ${MAX_TOPUP} 이하` },
        add_days: { type: "integer", description: `만료일을 며칠 늘릴지 (1~${MAX_DAYS})` },
      },
      required: ["target"],
    },
    async run(args, ctx) {
      const addBudget = numberArg(args.add_budget, "add_budget", { min: 0.01, max: MAX_TOPUP });
      const addDays = numberArg(args.add_days, "add_days", { min: 1, max: MAX_DAYS, integer: true });
      if (addBudget == null && addDays == null) throw toolError("충전 금액(add_budget)이나 연장 일수(add_days)가 필요합니다. 선생님께 얼마나 할지 물어보세요.");
      const [keys, teams] = await Promise.all([ctx.data.keys(), ctx.data.teams()]);
      const sel = resolveTargets(args.target, { keys, teams }, ctx.now);
      if (!sel.keys.length) throw toolError(`조건(${sel.scope})에 맞는 키가 없습니다.`);
      if (sel.keys.length > 500) throw toolError("한 번에 500개까지 충전할 수 있습니다.");
      const bits = [];
      if (addBudget != null) bits.push(`키마다 +${F.money(addBudget)}`);
      if (addDays != null) bits.push(`만료 +${addDays}일`);
      const total = addBudget != null ? addBudget * sel.keys.length : 0;
      const body = { add_budget: addBudget ?? undefined, add_days: addDays ?? undefined };
      if (sel.wholeClass) body.team_id = sel.team.team_id;
      else body.tokens = sel.keys.map((k) => k.token);
      const p = newProposal({
        kind: "topup",
        title: `${sel.scope} 키 ${sel.keys.length}개 ${addBudget != null ? "충전" : "연장"}`,
        summary: `${bits.join(" · ")}${total ? ` · 합계 ${F.money(total)}` : ""}`,
        lines: listLines(sel.keys, (k) => {
          const parts = [k.key_alias || "(별칭 없음)"];
          if (addBudget != null) parts.push(`${F.money(k.spend)} / ${k.max_budget == null ? "무제한" : `${F.money(k.max_budget)} → ${F.money(Number(k.max_budget) + addBudget)}`}`);
          if (addDays != null) parts.push(k.expires ? `만료 ${F.seoulYmd(k.expires)} → +${addDays}일` : "만료 없음 → 오늘부터 기한 생김");
          return parts.join("  ");
        }),
        count: sel.keys.length,
        tone: total > 100 ? "warn" : "primary",
        typed: total > 100 ? "충전" : "",
        confirm: addBudget != null ? "충전 실행" : "연장 실행",
        request: { path: "/api/keys/adjust/bulk", body },
        refresh: ["keys", "teams", "analytics"],
        after: { station: "keys", params: sel.team ? { team: sel.team.team_id } : {} },
      });
      return { result: proposalResult(p), summary: p.title, proposal: p };
    },
  },
  {
    name: "propose_block_keys",
    kind: "propose",
    label: "차단·해제 제안",
    description: "키 차단(block) 또는 차단 해제(unblock)를 제안한다. 학급 전체를 시험 등으로 막을 때는 propose_lockdown 이 낫다.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["block", "unblock"], description: "block 차단, unblock 해제" },
        target: TARGET_SCHEMA,
      },
      required: ["action", "target"],
    },
    async run(args, ctx) {
      const action = args.action === "unblock" ? "unblock" : args.action === "block" ? "block" : null;
      if (!action) throw toolError("action 은 block 또는 unblock 입니다");
      const [keys, teams] = await Promise.all([ctx.data.keys(), ctx.data.teams()]);
      const sel = resolveTargets(args.target, { keys, teams }, ctx.now);
      let list = sel.keys;
      const notes = [];
      if (action === "block") {
        list = list.filter((k) => !k.blocked);
        if (sel.keys.length !== list.length) notes.push(`이미 막힌 키 ${sel.keys.length - list.length}개는 뺐습니다`);
      } else {
        const locked = list.filter((k) => k.blocked && F.isLocked(k));
        list = list.filter((k) => k.blocked && !F.isLocked(k));
        if (locked.length) notes.push(`봉쇄로 막힌 키 ${locked.length}개는 학급 봉쇄 해제(propose_lockdown unlock)로 여세요`);
      }
      if (!list.length) throw toolError(`조건(${sel.scope})에서 ${action === "block" ? "차단할" : "해제할"} 키가 없습니다. ${notes.join(". ")}`);
      const verb = action === "block" ? "차단" : "차단 해제";
      const p = newProposal({
        kind: action,
        title: `${sel.scope} 키 ${list.length}개 ${verb}`,
        summary: action === "block" ? "학생 호출이 바로 막힙니다. 나중에 해제할 수 있습니다." : "막혔던 키로 다시 호출할 수 있게 됩니다.",
        lines: [...listLines(list, (k) => `${k.key_alias || "(별칭 없음)"}  ${F.keyState(k, ctx.now).label}`), ...notes.map((n) => `※ ${n}`)],
        count: list.length,
        tone: action === "block" ? "danger" : "primary",
        typed: action === "block" && list.length >= 10 ? "차단" : "",
        confirm: `${verb} 실행`,
        request: { path: "/api/keys/revoke", body: { action, tokens: list.map((k) => k.token) } },
        refresh: ["keys", "teams"],
        after: { station: "keys", params: sel.team ? { team: sel.team.team_id } : {} },
      });
      return { result: proposalResult(p, notes.length ? { notes } : {}), summary: p.title, proposal: p };
    },
  },
  {
    name: "propose_lockdown",
    kind: "propose",
    label: "학급 봉쇄 제안",
    description: "학급/조 봉쇄(lock: 소속 키를 한꺼번에 막음, 시험 때 등) 또는 봉쇄 해제(unlock: 봉쇄로 막은 키만 다시 엶)를 제안한다.",
    parameters: {
      type: "object",
      properties: {
        class: { type: "string", description: "학급/조 이름" },
        action: { type: "string", enum: ["lock", "unlock"] },
        reason: { type: "string", description: "이유 (예: 중간고사)" },
      },
      required: ["class", "action"],
    },
    async run(args, ctx) {
      const action = args.action === "unlock" ? "unlock" : "lock";
      const [keys, teams] = await Promise.all([ctx.data.keys(), ctx.data.teams()]);
      const team = findClass(args.class, teams);
      const own = keys.filter((k) => k.team_id === team.team_id && !F.isRetired(k));
      const locked = F.isLocked(team);
      if (action === "lock" && locked) throw toolError(`${F.teamLabel(team)} 은(는) 이미 봉쇄 중입니다.`);
      if (action === "unlock" && !locked) throw toolError(`${F.teamLabel(team)} 은(는) 봉쇄 중이 아닙니다. 개별 차단 해제는 propose_block_keys 를 쓰세요.`);
      const affected = action === "lock" ? own.filter((k) => !k.blocked) : own.filter((k) => k.blocked && F.isLocked(k));
      const reason = String(args.reason || "").trim().slice(0, 80);
      const p = newProposal({
        kind: action,
        title: `${F.teamLabel(team)} ${action === "lock" ? "봉쇄" : "봉쇄 해제"}`,
        summary: action === "lock"
          ? `열린 키 ${affected.length}개를 한꺼번에 막습니다${reason ? ` · 이유: ${reason}` : ""}. 해제하면 이 키들만 다시 열립니다.`
          : `봉쇄로 막은 키 ${affected.length}개를 다시 엽니다. 봉쇄 전에 따로 막힌 키는 그대로 둡니다.`,
        lines: listLines(affected, (k) => `${k.key_alias || "(별칭 없음)"}  ${F.keyState(k, ctx.now).label}`),
        count: affected.length,
        tone: action === "lock" ? "danger" : "primary",
        typed: action === "lock" ? "봉쇄" : "",
        confirm: action === "lock" ? "봉쇄 실행" : "해제 실행",
        request: { path: "/api/teams/lockdown", body: { team_id: team.team_id, action, reason: reason || undefined } },
        refresh: ["keys", "teams"],
        after: { station: "classes", params: { team_id: team.team_id } },
      });
      return { result: proposalResult(p), summary: p.title, proposal: p };
    },
  },
  {
    name: "propose_class_budget",
    kind: "propose",
    label: "학급 예산 변경 제안",
    description: "학급/조 전체 예산(소속 키 합계 한도, USD)을 새 값으로 바꾸는 제안. 시간표·모델은 그대로 둔다.",
    parameters: {
      type: "object",
      properties: {
        class: { type: "string", description: "학급/조 이름" },
        budget: { type: "number", description: "새 학급 예산 (USD)" },
      },
      required: ["class", "budget"],
    },
    async run(args, ctx) {
      const budget = numberArg(args.budget, "budget", { min: 0, max: MAX_CLASS_BUDGET });
      if (budget == null) throw toolError("새 예산(budget)이 필요합니다");
      const [keys, teams] = await Promise.all([ctx.data.keys(), ctx.data.teams()]);
      const team = findClass(args.class, teams);
      const before = team.max_budget == null ? "무제한" : F.money(team.max_budget);
      const spend = Number(team.spend) || 0;
      const n = keys.filter((k) => k.team_id === team.team_id && !F.isRetired(k)).length;
      const lines = [`지금 ${F.money(spend)} / ${before} → ${F.money(spend)} / ${F.money(budget)}`, `소속 키 ${n}개 · 시간표 ${F.classFact(team, keys, ctx.now).schedule} 유지`];
      if (budget < spend) lines.push("※ 새 예산이 이미 쓴 금액보다 작아 학급 호출이 바로 막힙니다");
      const p = newProposal({
        kind: "class_budget",
        title: `${F.teamLabel(team)} 학급 예산 ${before} → ${F.money(budget)}`,
        summary: "학급 전체 한도만 바꿉니다. 학생 키 한도는 그대로입니다.",
        lines,
        count: 1,
        tone: budget < spend ? "warn" : "primary",
        typed: "",
        confirm: "예산 변경",
        request: {
          path: "/api/teams/update",
          body: {
            team_id: team.team_id,
            alias: F.teamLabel(team),
            budget,
            schedule: (team.metadata && team.metadata.aiapi_schedule) || [],
          },
        },
        refresh: ["teams", "keys"],
        after: { station: "classes", params: { team_id: team.team_id } },
      });
      return { result: proposalResult(p), summary: p.title, proposal: p };
    },
  },
  {
    name: "open_screen",
    kind: "client",
    label: "화면 열기",
    description: "관리 화면의 스테이션을 연다. keys 는 filter(상태)·class 로 거를 수 있고, log 는 tab(activity 호출, audit 작업 기록, system 시스템, guide 학생 안내), launch 는 tab(bulk 명단 일괄, camp 캠프, single 한 개) 을 받는다.",
    parameters: {
      type: "object",
      properties: {
        screen: { type: "string", enum: Object.keys(STATIONS) },
        filter: { type: "string", enum: KEY_STATES, description: "keys 화면의 상태 거르기" },
        class: { type: "string", description: "학급/조 이름 (keys·classes)" },
        tab: { type: "string", enum: ["activity", "audit", "system", "guide", "bulk", "camp", "single"] },
      },
      required: ["screen"],
    },
    async run(args, ctx) {
      const screen = STATIONS[args.screen] ? args.screen : null;
      if (!screen) throw toolError(`screen 은 ${Object.keys(STATIONS).join(", ")} 중 하나입니다`);
      const params = {};
      if (args.class && (screen === "keys" || screen === "classes")) {
        const team = findClass(args.class, await ctx.data.teams());
        params[screen === "keys" ? "team" : "team_id"] = team.team_id;
      }
      if (screen === "keys" && args.filter) params.filter = args.filter;
      if ((screen === "log" && ["activity", "audit", "system", "guide"].includes(args.tab))
        || (screen === "launch" && ["bulk", "camp", "single"].includes(args.tab))) params.tab = args.tab;
      return { result: { opened: STATIONS[screen], params }, summary: `${STATIONS[screen]} 화면 열기`, navigate: { station: screen, params } };
    },
  },
];

// ---------------------------------------------------------------- 등록 사용자(학생) 도구
const USER_TOOLS = [
  {
    name: "my_keys",
    kind: "read",
    label: "내 키 확인",
    description: "내(질문한 사람) 키의 예산·사용액·만료·허용 모델·지금 쓸 수 있는 시간인지.",
    parameters: { type: "object", properties: {} },
    async run(_args, ctx) {
      const keys = await ctx.data.myKeys();
      const teams = await ctx.data.teams().catch(() => []);
      const teamsById = new Map(teams.map((t) => [t.team_id, t]));
      const now = ctx.now;
      const { scheduleAllows, formatSchedule } = require("../schedule");
      const list = keys.map((k) => {
        const schedule = k.metadata && k.metadata.aiapi_schedule;
        return {
          ...F.keyFact(k, teamsById, now),
          schedule: formatSchedule(schedule),
          usable_now: !k.blocked && F.keyState(k, now).code !== "expired" && scheduleAllows(schedule, now),
        };
      });
      return { result: { count: list.length, keys: list }, summary: `내 키 ${list.length}개 확인` };
    },
  },
  {
    name: "my_recent_calls",
    kind: "read",
    label: "내 호출 기록 확인",
    description: "내 키의 최근 호출과 실패 이유. 왜 안 되는지 물을 때 쓴다.",
    parameters: { type: "object", properties: { only_failed: { type: "boolean" } } },
    async run(args, ctx) {
      let items = await ctx.data.myActivity();
      if (args.only_failed) items = items.filter((it) => !it.ok);
      const summary = F.failureSummary(items);
      return {
        result: {
          ...summary,
          calls: items.slice(0, 15).map((it) => ({ time: F.seoulNow(new Date(it.at)).text.slice(5), model: it.model, ok: it.ok, reason: it.ok ? undefined : it.reason })),
        },
        summary: `내 호출 ${summary.total}건 · 실패 ${summary.failed}건`,
      };
    },
  },
  {
    name: "connection_guide",
    kind: "read",
    label: "접속 방법 확인",
    description: "내 코드에서 쓸 base_url(프록시 주소), 쓸 수 있는 모델 이름, 파이썬 예시.",
    parameters: { type: "object", properties: {} },
    async run(_args, ctx) {
      const keys = await ctx.data.myKeys();
      const models = [...new Set(keys.flatMap((k) => k.models || []))].slice(0, 8);
      const base = ctx.proxyUrl || "http://(학교 서버 주소):4000";
      return {
        result: {
          base_url: base,
          models,
          python: `from openai import OpenAI\nclient = OpenAI(api_key="발급받은_키", base_url="${base}")\nr = client.chat.completions.create(model="${models[0] || "gpt-4o-mini"}", messages=[{"role": "user", "content": "안녕"}])\nprint(r.choices[0].message.content)`,
          note: "키는 선생님께 받은 sk- 로 시작하는 값입니다. 키를 친구와 나누거나 인터넷에 올리지 마세요.",
        },
        summary: "접속 방법 확인",
      };
    },
  },
];

function toolsFor(role) {
  return role === "admin" ? ADMIN_TOOLS : USER_TOOLS;
}

module.exports = {
  ADMIN_TOOLS,
  USER_TOOLS,
  STATIONS,
  KEY_STATES,
  MAX_TOPUP,
  toolsFor,
  resolveTargets,
  findClass,
  findKeysByAlias,
  toolError,
};
