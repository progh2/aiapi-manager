// 01 개요(함교). 가운데는 3D 관제도가 보이도록 비워 둔다.
import { $, esc, money, num, relTime, icon, fmtTime } from "../lib/util.js";
import { state, alerts, keyCounts, sessionCounts, conditionLevel } from "../lib/store.js";
import { sparkline } from "../../charts.js";
import { say } from "../lib/holo.js";

const LEVEL_ICON = { crit: "!", warn: "!", info: "i", good: "✓" };

export default {
  id: "bridge",
  deps: ["keys", "teams", "providers", "analytics", "activity", "status"],
  init(root, ctx) {
    this.ctx = ctx;
    root.innerHTML = `
      <div class="st-inner" style="max-width:none">
        <div class="bridge-grid">
          <section class="panel vitals" aria-label="함선 상태" style="display:flex;flex-direction:column">
            <div class="panel-h"><span class="code">SHIP STATUS</span><h2>함선 상태</h2><span class="end"><span class="tag info" id="br-range">최근 30일</span></span></div>
            <div class="tile hero" style="border:0;background:none;padding:0">
              <div class="k" id="br-hero-k">최근 30일 지출</div>
              <div class="v" id="br-hero">—</div>
              <div class="s" id="br-hero-s"></div>
              <div class="spark" id="br-spark"></div>
            </div>
            <div class="vital-rows" id="br-vitals"></div>
            <div class="holo" id="br-holo" style="margin-top:auto;padding-top:14px">
              <div class="holo-fig"><img src="/mascot/holo/elf-dashboard.webp" alt=""></div>
              <div class="holo-say" style="flex:1"></div>
            </div>
          </section>
          <div class="void" aria-hidden="true">
            <div class="void-legend">
              <span><span class="led info"></span>행성 = 학급 (크기 예산 · 색 사용률)</span>
              <span><span class="led good"></span>수업 중</span>
              <span><span class="led off"></span>수업 외</span>
              <span><span class="led crit"></span>봉쇄·소진</span>
              <span><span class="led warn"></span>80% 이상</span>
              <span>위성 = 학생 키 · 아래 = 공급자 엔진 · 빈 곳을 끌어 회전</span>
            </div>
          </div>
          <section class="panel alerts" aria-label="경보">
            <div class="panel-h"><span class="code">ALERTS</span><h2>경보</h2><span class="end" id="br-alert-count"></span></div>
            <div class="alert-list" id="br-alerts"></div>
          </section>
          <section class="panel forecast glass" aria-label="예측과 최근 호출">
            <div class="fc-grid">
              <div>
                <div class="panel-h"><span class="code">NAV · FORECAST</span><h2>항로 예측</h2></div>
                <div class="fc-strip" id="br-fc"></div>
              </div>
              <div>
                <div class="panel-h"><span class="code">COMMS</span><h2>최근 호출</h2><span class="end"><button class="btn xs" type="button" data-nav="log" data-tab="activity">전체 보기</button></span></div>
                <div id="br-calls"></div>
              </div>
            </div>
          </section>
        </div>
      </div>`;
    root.addEventListener("click", (ev) => {
      const go = ev.target.closest("[data-nav]");
      if (go) {
        const params = {};
        for (const k of ["tab", "filter", "team_id", "id"]) if (go.dataset[k]) params[k] = go.dataset[k];
        ctx.go(go.dataset.nav, params);
        return;
      }
      const call = ev.target.closest("[data-token]");
      if (call && call.dataset.token) ctx.openKey(call.dataset.token);
    });
  },
  enter() { this.refresh(); },
  refresh() {
    const a = state.analytics;
    const days = state.analyticsOpts.days;
    $("#br-range").textContent = `최근 ${days}일`;
    $("#br-hero-k").textContent = `최근 ${days}일 지출`;
    if (a) {
      const avg = a.totalSpend / Math.max(1, a.dates.length);
      $("#br-hero").textContent = money(a.totalSpend);
      $("#br-hero-s").textContent = `하루 평균 ${money(avg)} · 오늘 ${money(a.daily.at(-1) || 0)}`;
      sparkline($("#br-spark"), a.daily);
    }
    this.renderVitals();
    this.renderAlerts();
    this.renderForecast();
    this.renderCalls();
  },
  renderVitals() {
    const c = keyCounts();
    const s = sessionCounts();
    const a = state.analytics;
    const sum = state.activity.summary;
    const todayReq = a ? (a.requests || []).at(-1) || 0 : 0;
    const low = state.providers.filter((p) => !p.builtin && p.remaining != null).sort((x, y) => x.remaining - y.remaining)[0];
    const row = (k, v, nav, sub = "", led = "") => `<div class="vital-row" role="button" tabindex="0" data-nav="${nav.station}" ${nav.filter ? `data-filter="${nav.filter}"` : ""} ${nav.tab ? `data-tab="${nav.tab}"` : ""}>${led ? `<span class="led ${led}"></span>` : ""}<span class="k">${esc(k)}</span><span class="v">${v}${sub ? ` <small>${esc(sub)}</small>` : ""}</span></div>`;
    $("#br-vitals").innerHTML = [
      row("활성 키", `${num(c.active)}`, { station: "keys", filter: "active" }, `/ 전체 ${num(c.total)}`, "good"),
      row("차단·봉쇄", num(c.blocked), { station: "keys", filter: "blocked" }, "", c.blocked ? "crit" : "off"),
      row("예산 소진 · 임박", `${num(c.over)} · ${num(c.warn)}`, { station: "keys", filter: c.over ? "over" : "warn" }, "", c.over ? "crit" : c.warn ? "warn" : "off"),
      row("7일 안 만료", num(c.expiring), { station: "keys", filter: "expiring" }, "", c.expiring ? "warn" : "off"),
      row("수업 중 학급", `${s.open}`, { station: "classes" }, `/ ${s.total}${s.always ? ` · 항상 ${s.always}` : ""}`, s.open ? "good" : "off"),
      row("오늘 호출", num(todayReq), { station: "log", tab: "activity" }, sum ? `최근 ${sum.total}건 중 실패 ${sum.failed}` : "", sum && sum.failed ? "warn" : "info"),
      row("공급자 최저 잔액", low ? money(low.remaining) : "—", { station: "engines" }, low ? low.label : "", low && low.max_budget ? (low.remaining <= 0 ? "crit" : low.remaining / low.max_budget <= 0.2 ? "warn" : "good") : "off"),
    ].join("");
    for (const el of document.querySelectorAll("#br-vitals .vital-row")) {
      el.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); el.click(); } };
    }
  },
  renderAlerts() {
    const list = alerts();
    const lvl = conditionLevel(list);
    const crit = list.filter((x) => x.level === "crit").length;
    const warn = list.filter((x) => x.level === "warn").length;
    $("#br-alert-count").innerHTML = crit ? `<span class="tag crit">경보 ${crit}</span>` : warn ? `<span class="tag warn">주의 ${warn}</span>` : `<span class="tag good">정상</span>`;
    $("#br-alerts").innerHTML = list.length ? list.map((x) => {
      const g = x.go || {};
      const attrs = `data-nav="${esc(g.station || "bridge")}" ${g.filter ? `data-filter="${esc(g.filter)}"` : ""} ${g.tab ? `data-tab="${esc(g.tab)}"` : ""} ${g.team_id ? `data-team_id="${esc(g.team_id)}"` : ""} ${g.id ? `data-id="${esc(g.id)}"` : ""}`;
      return `<div class="alert ${x.level}"><span class="ic" aria-hidden="true">${LEVEL_ICON[x.level]}</span><span class="t">${esc(x.title)}</span><button class="btn xs go" type="button" ${attrs}>보기</button><span class="d">${esc(x.detail)}</span></div>`;
    }).join("") : `<div class="alert good"><span class="ic" aria-hidden="true">✓</span><span class="t">모든 시스템 정상</span><span></span><span class="d">경보가 없습니다. 3D 관제도에서 학급과 키 상태를 둘러보세요.</span></div>`;
    this.brief(list, lvl);
  },
  renderForecast() {
    const a = state.analytics;
    const h = state.analyticsOpts.horizon;
    const it = (k, v, sub = "") => `<div class="it"><span class="k">${esc(k)}</span><span class="v">${v}</span>${sub ? `<span class="muted" style="font-size:11px">${esc(sub)}</span>` : ""}</div>`;
    if (!a) { $("#br-fc").innerHTML = '<span class="muted">사용량을 불러오는 중…</span>'; return; }
    const fc = a.forecast;
    const soon = a.soonestTeam;
    $("#br-fc").innerHTML = [
      it("최근 추세", fc ? `${money(fc.slope)}/일` : "—", fc ? "누적 직선 기울기" : "기록 3일 이상 필요"),
      it(`${h}일 뒤 누적`, fc ? money(fc.future.at(-1)) : "—", fc ? `지금보다 +${money(fc.future.at(-1) - a.totalSpend)}` : ""),
      it("가장 빨리 소진", soon ? esc(soon.name) : "—", soon ? (soon.daysLeft === 0 ? "이미 초과" : soon.daysLeft == null ? "최근 사용 없음" : `약 ${soon.daysLeft}일 뒤`) : "예산 있는 학급 없음"),
      it("학급 예산 잔여", a.budget && a.budget.remaining != null ? money(a.budget.remaining) : "—", a.budget && a.budget.total ? `합계 ${money(a.budget.total)}` : ""),
    ].join("");
  },
  renderCalls() {
    const items = state.activity.items.slice(0, 5);
    $("#br-calls").innerHTML = items.length ? `<div class="stack" style="gap:6px">${items.map((it) => `
      <div class="row" style="gap:8px;font-size:12px;flex-wrap:nowrap;cursor:${it.token ? "pointer" : "default"}" data-token="${esc(it.token || "")}" title="${esc(fmtTime(it.at))}">
        <span class="led ${it.ok ? "good" : "crit"}"></span>
        <b style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${esc(it.alias || "(별칭 없음)")}</b>
        <span class="muted nowrap">${esc(it.ok ? (it.model || "") : it.reason || "실패")}</span>
        <span class="num muted nowrap">${esc(relTime(it.at))}</span>
      </div>`).join("")}</div>` : '<p class="muted" style="margin:0;font-size:12px">최근 24시간 호출이 없습니다.</p>';
  },
  brief(list, lvl) {
    const a = state.analytics;
    const c = keyCounts();
    const sum = state.activity.summary;
    let line;
    if (lvl === "red") {
      line = `경보 ${list.filter((x) => x.level === "crit").length}건이에요. "${list[0].title}"부터 확인해 주세요.`;
    } else if (lvl === "yellow") {
      line = `살펴볼 항목이 ${list.filter((x) => x.level === "warn").length}건 있어요. ${list[0].title}.`;
    } else {
      line = `모든 시스템 정상이에요. 활성 키 ${c.active}개${sum && sum.active_keys ? `, 최근 호출한 키 ${sum.active_keys}개` : ""}.`;
    }
    if (a && a.soonestTeam && a.soonestTeam.daysLeft) line += ` ${a.soonestTeam.name} 예산은 이 속도면 약 ${a.soonestTeam.daysLeft}일 뒤 바닥나요.`;
    if (line !== this.lastLine) {
      this.lastLine = line;
      say($("#br-holo"), lvl === "red" ? "warn" : "dashboard", line, { who: "AI 엘피 · 브리핑" });
    }
  },
};
