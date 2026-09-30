// 02 사용량. 필터 한 줄이 모든 차트를 같은 범위로 다시 그린다. 차트마다 표 보기가 있다.
import { $, esc, money, num } from "../lib/util.js";
import { state, loadAnalytics } from "../lib/store.js";
import { teamOptions } from "../lib/forms.js";
import { cumulativeChart, dailyBarChart, seriesBarChart, rankBarChart, sparkline } from "../../charts.js";
import { toastError } from "../lib/ui.js";

function table(headers, rows) {
  return `<details class="tableview"><summary>표로 보기</summary><div class="tbl-wrap"><table class="tbl"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? "num" : ""}">${esc(c)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${headers.length}" class="tbl-empty">기록 없음</td></tr>`}</tbody></table></div></details>`;
}

export default {
  id: "telemetry",
  deps: ["analytics", "teams"],
  init(root, ctx) {
    this.ctx = ctx;
    root.innerHTML = `
      <div class="st-inner">
        <div class="st-head">
          <div class="ttl"><div class="code">STATION 02 · TELEMETRY</div><h1>사용량 분석</h1>
            <p>하루는 서울 시각 기준입니다. 예측은 최근 누적 지출에 직선을 맞춰 이어 본 값이라, 시험·과제 마감처럼 몰리는 시기는 반영하지 못합니다.</p></div>
          <div class="tools">
            <label class="field"><span>기간</span><select id="tm-days"><option value="14">최근 14일</option><option value="30" selected>최근 30일</option><option value="60">최근 60일</option><option value="90">최근 90일</option></select></label>
            <label class="field"><span>예측</span><select id="tm-horizon"><option value="7">7일 뒤</option><option value="14" selected>14일 뒤</option><option value="30">30일 뒤</option></select></label>
            <label class="field"><span>학급/조</span><select id="tm-team"></select></label>
            <button class="btn" type="button" id="tm-refresh" style="align-self:flex-end"><svg><use href="#i-refresh"/></svg>새로고침</button>
          </div>
        </div>
        <div id="tm-body">
          <div class="tiles" id="tm-tiles"></div>
          <div class="grid g2" style="margin-top:14px">
            <section class="panel chart-box span2"><div class="panel-h"><span class="code">CUMULATIVE</span><h2>누적 지출과 예측</h2></div>
              <p class="cap" id="tm-fc-cap"></p>
              <div class="legend"><span><i class="swatch"></i>실제 누적</span><span><i class="swatch dash"></i>예측(최근 추세)</span><span><i class="swatch limit"></i>학급 예산</span></div>
              <div id="tm-cum"></div><div id="tm-cum-t"></div></section>
            <section class="panel chart-box"><div class="panel-h"><span class="code">DAILY SPEND</span><h2>일별 지출</h2></div><div id="tm-daily"></div><div id="tm-daily-t"></div></section>
            <section class="panel chart-box"><div class="panel-h"><span class="code">DAILY CALLS</span><h2>일별 호출 수</h2></div><div id="tm-req"></div><div id="tm-req-t"></div></section>
            <section class="panel chart-box"><div class="panel-h"><span class="code">BY STUDENT</span><h2>학생별 지출</h2><span class="sub">상위 12명 · 회색 트랙이 개인 예산</span></div><div id="tm-keys"></div><div id="tm-keys-t"></div></section>
            <section class="panel chart-box"><div class="panel-h"><span class="code">BY CLASS</span><h2>학급/조별 지출</h2></div><div id="tm-teams"></div><div id="tm-teams-t"></div></section>
            <section class="panel chart-box span2"><div class="panel-h"><span class="code">BY MODEL</span><h2>모델별 지출</h2><span class="sub">어느 모델에 돈이 쓰이는지</span></div><div id="tm-models"></div><div id="tm-models-t"></div></section>
          </div>
        </div>
      </div>`;
    const reload = () => {
      $("#tm-body").classList.add("stale");
      loadAnalytics({ days: Number($("#tm-days").value), horizon: Number($("#tm-horizon").value), team_id: $("#tm-team").value })
        .catch((e) => toastError(e, "사용량을 불러오지 못했습니다"))
        .finally(() => $("#tm-body").classList.remove("stale"));
    };
    for (const id of ["#tm-days", "#tm-horizon", "#tm-team"]) root.querySelector(id).addEventListener("change", reload);
    root.querySelector("#tm-refresh").addEventListener("click", reload);
    let t;
    window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => { if (ctx.isActive("telemetry")) this.refresh(); }, 250); });
  },
  enter() { this.refresh(); },
  refresh() {
    const sel = $("#tm-team");
    const cur = state.analyticsOpts.team_id || "";
    sel.innerHTML = teamOptions({ selected: cur, none: "전체 학급" });
    $("#tm-days").value = String(state.analyticsOpts.days);
    $("#tm-horizon").value = String(state.analyticsOpts.horizon);
    const a = state.analytics;
    if (!a) { $("#tm-tiles").innerHTML = '<p class="muted">사용량을 불러오는 중…</p>'; return; }
    const days = a.dates.length;
    const horizon = state.analyticsOpts.horizon;
    const avg = a.totalSpend / Math.max(1, days);
    const slope = a.forecast ? a.forecast.slope : null;
    const projected = a.forecast ? a.forecast.future.at(-1) : null;
    const trend = slope == null ? "기록 부족" : slope > avg * 1.15 ? "평균보다 빠르게 느는 중" : slope < avg * 0.85 ? "평균보다 느려지는 중" : "평균과 비슷";
    const soon = a.soonestTeam;
    const scope = a.budget && a.budget.team ? a.budget.team : "전체 학급";
    const tiles = [
      `<div class="tile hero" style="grid-column:span 2"><div class="k">${esc(scope)} · 최근 ${days}일 지출</div><div class="v">${money(a.totalSpend)}</div><div class="s">호출 ${num((a.requests || []).reduce((x, y) => x + y, 0))}회 · 오늘 ${money(a.daily.at(-1) || 0)}</div><div class="spark" id="tm-spark"></div></div>`,
      `<div class="tile"><div class="k">하루 평균</div><div class="v">${money(avg)}</div><div class="s">${days}일 평균</div></div>`,
      `<div class="tile"><div class="k">최근 추세</div><div class="v">${slope == null ? "—" : money(slope) + "/일"}</div><div class="s">${esc(trend)}</div></div>`,
      `<div class="tile"><div class="k">${horizon}일 뒤 누적 예측</div><div class="v">${projected == null ? "—" : money(projected)}</div><div class="s">${projected == null ? "기록 3일 이상 필요" : `지금보다 +${money(projected - a.totalSpend)}`}</div></div>`,
      soon
        ? `<div class="tile"><div class="k">가장 빨리 소진되는 학급</div><div class="v" title="${esc(soon.name)}">${esc(soon.name)}</div><div class="s">${soon.daysLeft === 0 ? "이미 초과" : soon.daysLeft == null ? "최근 사용 없음" : `약 ${soon.daysLeft}일 뒤`} · 잔여 ${money(Math.max(0, soon.left))} / ${money(soon.budget)}</div></div>`
        : `<div class="tile"><div class="k">학급 예산 잔여</div><div class="v">${a.budget && a.budget.remaining != null ? money(a.budget.remaining) : "—"}</div><div class="s">${a.budget && a.budget.total ? `합계 ${money(a.budget.total)}` : "예산을 정한 학급이 없습니다"}</div></div>`,
    ];
    $("#tm-tiles").innerHTML = tiles.join("");
    sparkline($("#tm-spark"), a.daily);

    const budget = a.budget ? a.budget.total : null;
    const cum = cumulativeChart($("#tm-cum"), a.dates, a.cumulative, a.futureDates, a.forecast, budget || null);
    $("#tm-fc-cap").textContent = (a.forecast
      ? `최근 ${days}일의 누적 지출에 직선을 맞춰 ${horizon}일 뒤까지 이었습니다.`
      : "예측하려면 3일 이상의 사용 기록이 필요합니다.")
      + (budget && !cum.budgetShown ? ` ${scope} 예산 ${money(budget)}은 지금 지출보다 훨씬 커서 그래프에서 뺐습니다.` : "");
    $("#tm-cum-t").innerHTML = table(["날짜", "일별", "누적"], a.dates.map((d, i) => [d, money(a.daily[i]), money(a.cumulative[i])])
      .concat(a.forecast ? a.futureDates.map((d, i) => [`${d} (예측)`, "—", money(a.forecast.future[i])]) : []));
    dailyBarChart($("#tm-daily"), a.dates, a.daily);
    $("#tm-daily-t").innerHTML = table(["날짜", "지출"], a.dates.map((d, i) => [d, money(a.daily[i])]));
    seriesBarChart($("#tm-req"), a.dates, a.requests || [], { format: (v) => v, label: "호출" });
    $("#tm-req-t").innerHTML = table(["날짜", "호출 수"], a.dates.map((d, i) => [d, num((a.requests || [])[i] || 0)]));
    rankBarChart($("#tm-keys"), a.keyStats, { labelKey: "alias", subKey: "team", limit: 12 });
    $("#tm-keys-t").innerHTML = table(["별칭", "학급", "지출", "예산", "잔여", "호출"], a.keyStats.map((k) => [k.alias, k.team || "—", money(k.spend), k.budget == null ? "없음" : money(k.budget), k.remaining == null ? "—" : money(k.remaining), num(k.requests)]));
    rankBarChart($("#tm-teams"), a.teamStats, { labelKey: "name" });
    $("#tm-teams-t").innerHTML = table(["학급/조", "지출", "예산", "잔여"], a.teamStats.map((t) => [t.name, money(t.spend), t.budget == null ? "없음" : money(t.budget), t.remaining == null ? "—" : money(t.remaining)]));
    rankBarChart($("#tm-models"), a.modelStats, { labelKey: "name", limit: 10 });
    $("#tm-models-t").innerHTML = table(["모델", "지출"], a.modelStats.map((m) => [m.name, money(m.spend)]));
  },
};
