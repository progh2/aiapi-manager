// 03 키 관리. 검색·필터, 여러 개 골라 일괄 차단·해제·충전·회수, 별칭을 누르면 상세 서랍.
import {
  $, $$, esc, icon, money, num, fmtDate, fmtDateTime, relTime, formatSchedule, DUR_LABEL,
  keyState, stateTag, meterHtml, isCamp, isRetired, isLocked, budgetRatio, toCsv, downloadText, todayYmd,
  snippetPython, isExpiringSoon,
} from "../lib/util.js";
import { state, teamName, teamById, loadKeys, loadTeams, providerIdFromModels } from "../lib/store.js";
import { toast, toastError, modal, confirmDialog, drawer, reveal, busy } from "../lib/ui.js";
import { RESET_OPTIONS, teamOptions, providerOptions, bindModelPicker, scheduleEditor } from "../lib/forms.js";

const FILTERS = [
  ["", "전체 (폐기 제외)"],
  ["active", "사용 중"],
  ["warn", "예산 80% 이상"],
  ["over", "예산 소진"],
  ["expiring", "7일 안 만료"],
  ["expired", "만료됨"],
  ["blocked", "차단됨"],
  ["locked", "봉쇄됨"],
  ["camp", "캠프 키"],
  ["camp_today", "오늘 캠프"],
  ["camp_due", "만료된 캠프"],
  ["retired", "폐기된 키"],
];
const PAGE = 150;

function matches(k, f, now) {
  const KR = window.KeyRevoke;
  switch (f) {
    case "": return !isRetired(k);
    case "retired": return isRetired(k);
    case "warn": { const r = budgetRatio(k.spend, k.max_budget); return !k.blocked && r != null && r >= 0.8 && r < 1; }
    case "over": { const r = budgetRatio(k.spend, k.max_budget); return !k.blocked && r != null && r >= 1; }
    case "locked": return Boolean(k.blocked && isLocked(k));
    case "expiring": return !k.blocked && isExpiringSoon(k, 7, now);
    default: return KR ? KR.matchesFilter(k, f, { within_days: 7, now: new Date(now) }) : true;
  }
}

function modelsText(k) {
  if ((k.models || []).length) return k.models.join(", ");
  const t = teamById(k.team_id);
  if (t && (t.models || []).length) return `${t.models.join(", ")} (학급)`;
  return "전체";
}

function scheduleText(k) {
  const meta = k.metadata || {};
  const txt = formatSchedule(meta.aiapi_schedule);
  return meta.aiapi_schedule_from === "team" && (meta.aiapi_schedule || []).length ? `${txt} (학급)` : txt;
}

function resultsModal(title, out, verbOk) {
  const rows = out.results || [];
  const bad = rows.filter((r) => r.error);
  const body = `<p style="margin:0 0 10px"><span class="tag good">성공 ${rows.length - bad.length}</span> ${bad.length ? `<span class="tag crit">실패 ${bad.length}</span>` : ""}</p>
    <div class="tbl-wrap" style="max-height:50vh"><table class="tbl"><thead><tr><th>상태</th><th>별칭</th><th>결과</th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="${r.error ? "bad" : "ok"}"><td>${r.error ? '<span class="tag crit">실패</span>' : '<span class="tag good">성공</span>'}</td><td>${esc(r.alias || (r.token || "").slice(0, 12))}</td><td>${r.error ? esc(r.error) : esc(r.skipped ? "이미 그 상태 — 건너뜀" : verbOk(r))}</td></tr>`).join("")}
    </tbody></table></div>`;
  modal({ title, code: "BATCH REPORT", body, size: "wide" });
}

export default {
  id: "keys",
  deps: ["keys", "teams", "providers"],
  init(root, ctx) {
    this.ctx = ctx;
    this.selected = new Set();
    this.limit = PAGE;
    root.innerHTML = `
      <div class="st-inner">
        <div class="st-head">
          <div class="ttl"><div class="code">STATION 03 · ROSTER</div><h1>키 관리</h1>
            <p>별칭을 누르면 상세가 열립니다. 여러 키를 골라 한 번에 막고, 풀고, 충전하고, 회수할 수 있습니다. 차단은 되돌릴 수 있고 회수(삭제)는 되돌릴 수 없습니다.</p></div>
          <div class="tools">
            <button class="btn" type="button" id="k-csv">${icon("down")}CSV 내보내기</button>
            <button class="btn primary" type="button" data-nav="launch" data-tab="single">${icon("plus")}새 키</button>
          </div>
        </div>
        <section class="panel">
          <div class="row" style="margin-bottom:12px">
            <label class="search"><svg><use href="#i-cmd"/></svg><input id="k-q" type="search" placeholder="별칭·학급·모델·캠프 코드 검색 ( / )" aria-label="키 검색"></label>
            <select id="k-team" aria-label="학급 필터" style="width:auto"></select>
            <select id="k-status" aria-label="상태 필터" style="width:auto">${FILTERS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
            <span class="muted" id="k-count" style="font-size:12px"></span>
            <span style="flex:1"></span>
            <button class="btn sm ghost" type="button" id="k-reload">${icon("refresh")}새로고침</button>
          </div>
          <div class="tbl-wrap" style="max-height:calc(100vh - 330px)">
            <table class="tbl" id="k-table">
              <thead><tr>
                <th style="width:34px"><input type="checkbox" id="k-all" aria-label="보이는 키 모두 선택"></th>
                <th>상태</th><th>별칭</th><th>학급/조</th><th>지출 / 예산</th><th>리셋</th><th>만료</th><th>모델</th><th>시간대</th><th class="r">RPM/TPM</th><th class="r">작업</th>
              </tr></thead>
              <tbody id="k-rows"></tbody>
            </table>
          </div>
          <div class="tbl-foot"><span id="k-foot"></span><button class="btn xs" type="button" id="k-more" hidden>더 보기</button></div>
          <div id="k-bulk"></div>
        </section>
      </div>`;

    root.querySelector("#k-q").addEventListener("input", () => { this.limit = PAGE; this.render(); });
    root.querySelector("#k-team").addEventListener("change", () => { this.limit = PAGE; this.render(); });
    root.querySelector("#k-status").addEventListener("change", () => { this.limit = PAGE; this.render(); });
    root.querySelector("#k-more").addEventListener("click", () => { this.limit += PAGE; this.render(); });
    root.querySelector("#k-reload").addEventListener("click", (ev) => busy(ev.currentTarget, () => Promise.all([loadKeys(), loadTeams()]).catch((e) => toastError(e))));
    root.querySelector("#k-csv").addEventListener("click", () => this.exportCsv());
    root.querySelector("#k-all").addEventListener("change", (ev) => {
      const vis = this.visible();
      vis.forEach((k) => (ev.target.checked ? this.selected.add(k.token) : this.selected.delete(k.token)));
      this.render();
    });
    root.addEventListener("change", (ev) => {
      const cb = ev.target.closest(".k-cb");
      if (!cb) return;
      if (cb.checked) this.selected.add(cb.dataset.token); else this.selected.delete(cb.dataset.token);
      cb.closest("tr").classList.toggle("sel", cb.checked);
      this.syncAll();
      this.renderBulk();
    });
    root.addEventListener("click", (ev) => {
      const nav = ev.target.closest("[data-nav]");
      if (nav) { ctx.go(nav.dataset.nav, { tab: nav.dataset.tab || "" }); return; }
      const b = ev.target.closest("[data-act]");
      if (!b) return;
      const k = state.keys.find((x) => x.token === b.dataset.token);
      const act = b.dataset.act;
      if (act === "bulk-block") return this.bulk("block");
      if (act === "bulk-unblock") return this.bulk("unblock");
      if (act === "bulk-delete") return this.bulk("delete");
      if (act === "bulk-topup") return this.bulkTopup();
      if (act === "bulk-clear") { this.selected.clear(); this.render(); return; }
      if (!k) return;
      if (act === "detail") this.openDetail(k.token);
      else if (act === "edit") this.openEdit(k);
      else if (act === "block") this.toggleBlock(k);
      else if (act === "reissue") this.reissue(k);
      else if (act === "delete") this.remove(k);
    });
  },
  enter(params = {}) {
    const team = $("#k-team");
    team.innerHTML = teamOptions({ selected: params.team || team.value || "", none: "전체 학급" });
    if (params.team) team.value = params.team;
    if (params.filter != null && FILTERS.some(([v]) => v === params.filter)) $("#k-status").value = params.filter;
    if (params.q != null) $("#k-q").value = params.q;
    this.render();
    if (params.focus === "search") setTimeout(() => $("#k-q").focus(), 350);
  },
  refresh() {
    const team = $("#k-team");
    const cur = team.value;
    team.innerHTML = teamOptions({ selected: cur, none: "전체 학급" });
    team.value = cur;
    const alive = new Set(state.keys.map((k) => k.token));
    for (const t of [...this.selected]) if (!alive.has(t)) this.selected.delete(t);
    this.render();
  },
  visible() {
    const q = $("#k-q").value.trim().toLowerCase();
    const team = $("#k-team").value;
    const f = $("#k-status").value;
    const now = Date.now();
    return state.keys.filter((k) => {
      if (team && k.team_id !== team) return false;
      if (!matches(k, f, now)) return false;
      if (!q) return true;
      const hay = `${k.key_alias || ""} ${teamName(k.team_id)} ${(k.models || []).join(" ")} ${(k.metadata && k.metadata.aiapi_camp && k.metadata.aiapi_camp.code) || ""}`.toLowerCase();
      return hay.includes(q);
    }).sort((a, b) => String(a.key_alias || "").localeCompare(String(b.key_alias || ""), "ko", { numeric: true }));
  },
  syncAll() {
    const vis = this.visible();
    const n = vis.filter((k) => this.selected.has(k.token)).length;
    const box = $("#k-all");
    box.checked = vis.length > 0 && n === vis.length;
    box.indeterminate = n > 0 && n < vis.length;
  },
  render() {
    const vis = this.visible();
    const now = Date.now();
    const shown = vis.slice(0, this.limit);
    $("#k-count").textContent = `${num(vis.length)}개${vis.length !== state.keys.length ? ` / 전체 ${num(state.keys.length)}개` : ""}`;
    $("#k-rows").innerHTML = shown.map((k) => {
      const st = keyState(k, now);
      const tok = esc(k.token || "");
      const sel = this.selected.has(k.token);
      const camp = isCamp(k) ? ' <span class="tag violet">캠프</span>' : k.metadata && k.metadata.aiapi_system ? ' <span class="tag info">엘피 전용</span>' : "";
      const exp = !k.expires ? '<span class="muted">무기한</span>'
        : new Date(k.expires).getTime() < now ? `<span class="muted">${fmtDate(k.expires)}</span>`
          : isExpiringSoon(k, 7, now) ? `${fmtDate(k.expires)} <span class="tag warn">${esc(relTime(k.expires))}</span>` : fmtDate(k.expires);
      return `<tr class="${sel ? "sel" : ""} ${st.code === "expired" || isRetired(k) ? "dim" : ""}">
        <td><input type="checkbox" class="k-cb" data-token="${tok}" ${sel ? "checked" : ""} aria-label="${esc(k.key_alias || "키")} 선택"></td>
        <td>${stateTag(st)}</td>
        <td><span class="alias" data-act="detail" data-token="${tok}" tabindex="0" role="button">${esc(k.key_alias || "(별칭 없음)")}</span>${camp}</td>
        <td>${k.team_id ? `<span class="tag info">${esc(teamName(k.team_id))}</span>` : '<span class="muted">—</span>'}</td>
        <td>${meterHtml(k.spend, k.max_budget)}</td>
        <td class="nowrap">${esc(DUR_LABEL[k.budget_duration] || "없음")}</td>
        <td class="nowrap">${exp}</td>
        <td style="max-width:200px;font-size:12px" class="sec">${esc(modelsText(k))}</td>
        <td style="max-width:170px;font-size:12px" class="sec">${esc(scheduleText(k))}</td>
        <td class="r num sec">${esc(k.rpm_limit ?? "—")} / ${esc(k.tpm_limit ?? "—")}</td>
        <td class="act">
          <button class="btn xs" type="button" data-act="detail" data-token="${tok}" title="상세·충전·이력">상세</button>
          <button class="btn xs" type="button" data-act="edit" data-token="${tok}" title="한도·모델·시간대 수정">수정</button>
          <button class="btn xs ${k.blocked ? "" : "warn"}" type="button" data-act="block" data-token="${tok}" ${isRetired(k) && k.blocked ? "disabled title='폐기된 키는 다시 열 수 없습니다'" : ""}>${k.blocked ? "해제" : "차단"}</button>
          <button class="btn xs" type="button" data-act="reissue" data-token="${tok}" title="유출된 키를 막고 같은 별칭으로 새 키" ${isRetired(k) ? "disabled" : ""}>새 키</button>
          <button class="btn xs danger" type="button" data-act="delete" data-token="${tok}" aria-label="삭제">${icon("trash")}</button>
        </td></tr>`;
    }).join("") || `<tr><td colspan="11" class="tbl-empty">조건에 맞는 키가 없습니다.</td></tr>`;
    for (const a of $$("#k-rows .alias")) a.onkeydown = (ev) => { if (ev.key === "Enter") a.click(); };
    $("#k-more").hidden = vis.length <= this.limit;
    $("#k-foot").textContent = vis.length > this.limit ? `${num(shown.length)}개 표시 중 · 검색으로 좁히거나 더 보기` : "";
    this.syncAll();
    this.renderBulk();
  },
  renderBulk() {
    const n = this.selected.size;
    $("#k-bulk").innerHTML = n ? `<div class="bulkbar" role="region" aria-label="선택한 키 작업">
      <span class="cnt">${num(n)}개 선택</span>
      <button class="btn sm warn" type="button" data-act="bulk-block">${icon("ban")}일괄 차단</button>
      <button class="btn sm" type="button" data-act="bulk-unblock">${icon("unlock")}일괄 해제</button>
      <button class="btn sm" type="button" data-act="bulk-topup">${icon("coin")}충전·연장</button>
      <button class="btn sm danger" type="button" data-act="bulk-delete">${icon("trash")}회수(삭제)</button>
      <span style="flex:1"></span>
      <button class="btn sm ghost" type="button" data-act="bulk-clear">선택 해제</button></div>` : "";
  },

  // ---------------------------------------------------------------- 일괄 작업
  async bulk(action) {
    const tokens = [...this.selected];
    const aliases = tokens.map((t) => state.keys.find((k) => k.token === t)?.key_alias || t.slice(0, 10));
    const preview = aliases.slice(0, 10).join(", ") + (aliases.length > 10 ? ` 외 ${aliases.length - 10}개` : "");
    const verb = { block: "차단", unblock: "차단 해제", delete: "회수(삭제)" }[action];
    const ok = await confirmDialog({
      title: `선택한 ${tokens.length}개 키 ${verb}`,
      message: action === "delete" ? "LiteLLM 에서 키를 지웁니다. 되돌릴 수 없습니다." : action === "block" ? "학생은 곧바로 호출할 수 없게 됩니다. 나중에 해제할 수 있습니다." : "막혀 있던 키를 다시 엽니다. 폐기된 키는 열지 않습니다.",
      detail: preview,
      confirmLabel: verb,
      tone: action === "delete" ? "danger" : action === "block" ? "warn" : "",
      typed: action === "delete" ? "회수" : "",
    });
    if (!ok) return;
    try {
      const out = await this.ctx.api("/api/keys/revoke", { method: "POST", body: { action, tokens } });
      const fail = out.results.filter((r) => r.error).length;
      out.results.forEach((r) => { if (!r.error) this.selected.delete(r.token); });
      toast(`${out.results.length - fail}개 ${verb}${fail ? ` · 실패 ${fail}` : ""}`, { tone: fail ? "warn" : "good", title: `일괄 ${verb}` });
      if (fail) resultsModal(`일괄 ${verb} 결과`, out, (r) => (r.deleted ? "회수됨" : r.unblocked ? "해제됨" : "차단됨"));
      await Promise.all([loadKeys(), loadTeams()]);
    } catch (e) { toastError(e, `일괄 ${verb} 실패`); }
  },
  bulkTopup(tokens = [...this.selected], { teamId = "", title = "" } = {}) {
    const n = teamId ? "학급 전체" : `${tokens.length}개 키`;
    const body = `
      <p class="help">${esc(n)}에 금액을 <b>더하거나</b> 만료를 늘립니다. 현재 한도를 통째로 바꾸려면 키 <b>수정</b>을 쓰세요. 예산이 무제한인 키는 충전되지 않고 실패로 남습니다.</p>
      <div class="form-grid">
        <label class="field"><span>충전 금액 (USD)</span><input id="bt-add" type="number" min="0.5" step="0.5" placeholder="예: 1"></label>
        <label class="field"><span>기존 만료일에 더하기</span><select id="bt-days"><option value="">연장 안 함</option><option value="7">7일</option><option value="14">14일</option><option value="30">30일</option><option value="90">90일</option></select></label>
        <label class="field"><span>또는 새 만료일</span><input id="bt-exp" type="date" min="${todayYmd()}"></label>
      </div>`;
    modal({
      title: title || `${n} 충전·연장`, code: "RESUPPLY", body,
      actions: [
        { label: "취소", tone: "ghost", value: null },
        {
          label: "적용", tone: "primary",
          onClick: async (h) => {
            const add = h.el.querySelector("#bt-add").value;
            const days = h.el.querySelector("#bt-days").value;
            const exp = h.el.querySelector("#bt-exp").value;
            if (!add && !days && !exp) { toast("충전 금액이나 연장을 입력하세요", { tone: "warn" }); return false; }
            if (days && exp) { toast("일수 연장과 새 만료일 중 하나만 고르세요", { tone: "warn" }); return false; }
            const body2 = teamId ? { team_id: teamId } : { tokens };
            if (add) body2.add_budget = add;
            if (days) body2.add_days = Number(days);
            if (exp) body2.expires = exp;
            try {
              const out = await this.ctx.api("/api/keys/adjust/bulk", { method: "POST", body: body2 });
              const fail = out.results.filter((r) => r.error).length;
              toast(`${out.results.length - fail}개 적용${fail ? ` · 실패 ${fail}` : ""}`, { tone: fail ? "warn" : "good", title: "충전·연장" });
              if (fail) resultsModal("충전·연장 결과", out, (r) => `${r.max_budget_before != null ? money(r.max_budget_before) : "?"} → ${r.max_budget != null ? money(r.max_budget) : "?"}`);
              await loadKeys();
            } catch (e) { toastError(e, "충전·연장 실패"); return false; }
            return true;
          },
        },
      ],
    });
  },
  exportCsv() {
    const now = Date.now();
    const vis = this.visible();
    const rows = vis.map((k) => [
      k.key_alias || "", teamName(k.team_id), keyState(k, now).label, (k.spend || 0).toFixed(4),
      k.max_budget ?? "", k.max_budget == null ? "" : Math.max(0, k.max_budget - (k.spend || 0)).toFixed(4),
      DUR_LABEL[k.budget_duration] || "", k.expires ? fmtDate(k.expires) : "무기한", modelsText(k), scheduleText(k),
      k.rpm_limit ?? "", k.tpm_limit ?? "", (k.metadata && k.metadata.aiapi_camp && k.metadata.aiapi_camp.code) || "",
    ]);
    downloadText(`keys_${todayYmd()}.csv`, toCsv(["별칭", "학급/조", "상태", "지출(USD)", "예산(USD)", "잔여(USD)", "예산 리셋", "만료", "허용 모델", "시간대", "RPM", "TPM", "캠프 코드"], rows));
    toast(`${vis.length}개 키를 CSV 로 내보냈습니다 (키 비밀값은 들어 있지 않습니다)`, { tone: "good" });
  },

  // ---------------------------------------------------------------- 한 키 작업
  async toggleBlock(k) {
    const to = !k.blocked;
    if (to) {
      const ok = await confirmDialog({ title: `'${k.key_alias}' 차단`, message: "학생은 곧바로 호출할 수 없게 됩니다. 나중에 해제할 수 있습니다.", confirmLabel: "차단", tone: "warn" });
      if (!ok) return;
    }
    try {
      await this.ctx.api("/api/keys/block", { method: "POST", body: { token: k.token, blocked: to, alias: k.key_alias } });
      toast(`'${k.key_alias}' ${to ? "차단" : "차단 해제"}`, { tone: "good" });
      await loadKeys();
    } catch (e) { toastError(e); }
  },
  async remove(k) {
    const ok = await confirmDialog({
      title: `'${k.key_alias}' 삭제`, message: "LiteLLM 에서 키를 지웁니다. 되돌릴 수 없고, 이 키를 쓰는 학생 코드는 바로 실패합니다.",
      confirmLabel: "삭제", tone: "danger",
    });
    if (!ok) return;
    try {
      await this.ctx.api("/api/keys/delete", { method: "POST", body: { keys: [k.token] } });
      this.selected.delete(k.token);
      toast(`'${k.key_alias}' 삭제`, { tone: "good" });
      await loadKeys();
    } catch (e) { toastError(e); }
  },
  async reissue(k) {
    const left = k.max_budget == null ? "무제한" : `남은 ${money(Math.max(0, Number(k.max_budget) - Number(k.spend || 0)))}`;
    const ok = await confirmDialog({
      title: `'${k.key_alias}' 폐기 후 새 키`,
      message: "비밀 키가 새었을 때 씁니다. 이전 키를 막고 같은 별칭으로 새 키를 만듭니다.",
      detail: `이전 키는 차단되고 별칭이 '${k.key_alias}-폐기'로 바뀝니다.\n새 키 예산: ${left}. 모델·학급·시간대·속도 제한은 그대로입니다.\n새 비밀 키는 한 번만 보입니다.`,
      confirmLabel: "폐기하고 새 키 만들기", tone: "warn",
    });
    if (!ok) return;
    try {
      const out = await this.ctx.api("/api/keys/reissue", { method: "POST", body: { token: k.token } });
      reveal({
        title: `${out.key_alias} — 새 키`, secret: out.key,
        lines: [`이전 별칭 ${out.retired_alias}`, `예산 ${out.max_budget == null ? "무제한" : money(out.max_budget)}`],
        snippet: snippetPython(this.ctx.proxyUrl(), (out.models || [])[0] || "gpt-4o-mini"),
      });
      await loadKeys();
    } catch (e) { toastError(e, "새 키를 만들지 못했습니다"); }
  },

  // ---------------------------------------------------------------- 수정
  openEdit(k) {
    const meta = k.metadata || {};
    const camp = Boolean(meta.aiapi_camp);
    const windows = meta.aiapi_schedule || [];
    const personal = meta.aiapi_schedule_from === "key" || (meta.aiapi_schedule_from !== "team" && windows.length > 0);
    const providerId = meta.aiapi_provider_key_id || providerIdFromModels(k.models);
    const body = `
      <div class="form-grid">
        <label class="field"><span>예산 (USD) <span class="req">*</span></span><input id="e-budget" type="number" step="0.5" min="0" value="${esc(k.max_budget ?? "")}" placeholder="비우면 한도 없음"></label>
        <label class="field"><span>소속 학급/조</span><select id="e-team">${teamOptions({ selected: k.team_id || "" })}</select></label>
        <label class="field"><span>예산 리셋</span><select id="e-reset">${RESET_OPTIONS}</select><span class="hint">만든 시각부터 셈 · 달력 1일 아님</span></label>
        <label class="field"><span>만료 (지금부터)</span><select id="e-dur"><option value="">바꾸지 않음</option><option value="7d">7일 뒤</option><option value="30d">30일 뒤</option><option value="90d">90일 뒤</option><option value="120d">120일 뒤</option></select><span class="hint">기존 만료일에 더하려면 상세의 연장을 쓰세요</span></label>
        <label class="field"><span>분당 요청 (RPM)</span><input id="e-rpm" type="number" min="1" value="${esc(k.rpm_limit ?? "")}" placeholder="무제한"></label>
        <label class="field"><span>분당 토큰 (TPM)</span><input id="e-tpm" type="number" min="1" value="${esc(k.tpm_limit ?? "")}" placeholder="무제한"></label>
      </div>
      <div class="form-grid" style="margin-top:12px"><label class="field"><span>공급자 키</span><select id="e-prov">${providerOptions(providerId)}</select></label></div>
      <div class="field" style="margin-top:12px"><span>허용 모델</span><div class="chips" id="e-models"></div><span class="hint" id="e-models-hint"></span></div>
      <div style="margin-top:14px">
        <label class="check"><input type="checkbox" id="e-own" ${camp || personal ? "checked" : ""} ${camp ? "disabled" : ""}> 이 키만 다른 사용 시간대</label>
        <p class="help" style="margin:6px 0 8px">${camp ? "캠프 키는 학급 시간표를 따르지 않습니다. 비우면 당일 항상입니다." : "끄면 학급 시간표를 따릅니다. 학급이 없거나 시간표가 비어 있으면 항상입니다."}</p>
        <div id="e-sched"></div>
      </div>`;
    modal({
      title: `키 수정 — ${k.key_alias || ""}`, code: "RECONFIGURE", body, size: "wide",
      onOpen: (h) => {
        h.el.querySelector("#e-reset").value = k.budget_duration || "";
        const picker = bindModelPicker({ select: h.el.querySelector("#e-prov"), box: h.el.querySelector("#e-models"), name: "e-models", hint: h.el.querySelector("#e-models-hint") });
        picker.set(providerId, k.models || []);
        const sched = scheduleEditor(h.el.querySelector("#e-sched"), windows);
        const own = h.el.querySelector("#e-own");
        const sync = () => { h.el.querySelector("#e-sched").style.display = own.checked ? "" : "none"; };
        own.addEventListener("change", sync);
        sync();
        h.picker = picker;
        h.sched = sched;
      },
      actions: [
        { label: "취소", tone: "ghost", value: null },
        {
          label: "저장", tone: "primary",
          onClick: async (h) => {
            const models = h.picker.read();
            if (!models.length) { toast("모델을 하나 이상 고르세요", { tone: "warn" }); return false; }
            const own = h.el.querySelector("#e-own").checked;
            const body2 = {
              token: k.token,
              alias: k.key_alias,
              budget: h.el.querySelector("#e-budget").value,
              team_id: h.el.querySelector("#e-team").value,
              budget_duration: h.el.querySelector("#e-reset").value,
              duration: h.el.querySelector("#e-dur").value,
              rpm_limit: h.el.querySelector("#e-rpm").value,
              tpm_limit: h.el.querySelector("#e-tpm").value,
              models,
              provider_key_id: h.el.querySelector("#e-prov").value,
              schedule: own ? h.sched.read() : [],
            };
            try {
              await this.ctx.api("/api/keys/update", { method: "POST", body: body2 });
              toast(`'${k.key_alias}' 저장`, { tone: "good" });
              await loadKeys();
            } catch (e) { toastError(e, "저장하지 못했습니다"); return false; }
            return true;
          },
        },
      ],
    });
  },

  // ---------------------------------------------------------------- 상세 서랍
  openDetail(token) {
    const k = state.keys.find((x) => x.token === token);
    if (!k) { toast("키를 찾을 수 없습니다. 목록을 새로고침하세요", { tone: "warn" }); return; }
    const self = this;
    drawer({
      title: k.key_alias || "(별칭 없음)", code: "UNIT DOSSIER",
      render(b, h) {
        const paint = (key, remaining = null) => {
          const st = keyState(key);
          const rem = remaining != null ? remaining : key.max_budget == null ? null : key.max_budget - (key.spend || 0);
          const meta = key.metadata || {};
          b.querySelector("#d-now").innerHTML = `
            <div class="row" style="margin-bottom:10px">${stateTag(st)}${isCamp(key) ? '<span class="tag violet">캠프</span>' : ""}${isLocked(key) ? '<span class="tag crit">학급 봉쇄로 차단</span>' : ""}</div>
            ${meterHtml(key.spend, key.max_budget)}
            <dl class="kv" style="margin-top:12px">
              <dt>잔여</dt><dd class="num">${rem == null ? "무제한" : money(rem)}</dd>
              <dt>학급/조</dt><dd>${esc(teamName(key.team_id) || "없음")}</dd>
              <dt>예산 리셋</dt><dd>${esc(DUR_LABEL[key.budget_duration] || "없음")}</dd>
              <dt>만료</dt><dd>${key.expires ? `${fmtDate(key.expires)} <span class="muted">(${esc(relTime(key.expires))})</span>` : "무기한"}</dd>
              <dt>허용 모델</dt><dd>${esc(modelsText(key))}</dd>
              <dt>사용 시간대</dt><dd>${esc(scheduleText(key))}</dd>
              <dt>RPM / TPM</dt><dd class="num">${esc(key.rpm_limit ?? "—")} / ${esc(key.tpm_limit ?? "—")}</dd>
              ${meta.aiapi_camp ? `<dt>캠프 코드</dt><dd class="num">${esc(meta.aiapi_camp.code || "")}</dd>` : ""}
              ${key.created_at ? `<dt>만든 날</dt><dd>${fmtDate(key.created_at)}</dd>` : ""}
            </dl>`;
        };
        b.innerHTML = `
          <div id="d-now"></div>
          <div class="row" style="margin:14px 0 4px">
            <button class="btn sm" type="button" id="d-edit">${icon("edit")}수정</button>
            <button class="btn sm ${k.blocked ? "" : "warn"}" type="button" id="d-block">${k.blocked ? "차단 해제" : "차단"}</button>
            <button class="btn sm" type="button" id="d-reissue" ${isRetired(k) ? "disabled" : ""}>폐기 후 새 키</button>
            <button class="btn sm danger" type="button" id="d-del">${icon("trash")}삭제</button>
          </div>
          <h4 style="margin:18px 0 8px;font-size:14px">충전 · 연장</h4>
          <p class="help">금액은 지금 한도에 <b>더하고</b>, 연장은 기존 만료일에 일수를 더합니다(지났거나 없으면 지금부터).</p>
          <div class="form-grid">
            <label class="field"><span>충전 (USD)</span><input id="d-add" type="number" min="0.5" step="0.5" placeholder="예: 2"></label>
            <label class="field"><span>기존 만료일에 더하기</span><select id="d-days"><option value="">연장 안 함</option><option value="7">7일</option><option value="14">14일</option><option value="30">30일</option><option value="90">90일</option></select></label>
            <label class="field"><span>또는 새 만료일</span><input id="d-exp" type="date" min="${todayYmd()}"></label>
          </div>
          <p class="help" id="d-preview" style="margin-top:8px"></p>
          <button class="btn primary sm" type="button" id="d-apply">충전·연장 적용</button>
          <h4 style="margin:22px 0 8px;font-size:14px">변경 이력</h4>
          <div id="d-hist" class="muted" style="font-size:12px">불러오는 중…</div>
          <h4 style="margin:22px 0 8px;font-size:14px">최근 호출 <span class="muted" style="font-weight:400;font-size:12px">7일 · 최대 15건</span></h4>
          <div id="d-calls" class="muted" style="font-size:12px">불러오는 중…</div>`;
        let cur = { ...k };
        paint(cur);
        const preview = () => {
          const add = Number(b.querySelector("#d-add").value);
          const days = Number(b.querySelector("#d-days").value);
          const exp = b.querySelector("#d-exp").value;
          const bits = [];
          if (add > 0) bits.push(cur.max_budget == null ? "무제한 키는 충전할 수 없습니다. 먼저 수정에서 한도를 정하세요." : `예산 ${money(cur.max_budget)} → ${money(Number(cur.max_budget) + add)}`);
          if (exp && days) bits.push("일수 연장과 새 만료일은 하나만 고르세요.");
          else if (exp) bits.push(`만료 → ${exp} 하루 끝`);
          else if (days) {
            const base = cur.expires && new Date(cur.expires).getTime() > Date.now() ? new Date(cur.expires).getTime() : Date.now();
            bits.push(`만료 → ${fmtDateTime(new Date(base + days * 86400000).toISOString())}`);
          }
          b.querySelector("#d-preview").textContent = bits.length ? `미리보기 · ${bits.join(" · ")}` : "";
        };
        b.addEventListener("input", preview);
        b.addEventListener("change", preview);
        b.querySelector("#d-apply").onclick = (ev) => busy(ev.currentTarget, async () => {
          const payload = { token: cur.token };
          const add = b.querySelector("#d-add").value;
          const days = b.querySelector("#d-days").value;
          const exp = b.querySelector("#d-exp").value;
          if (add) payload.add_budget = add;
          if (days) payload.add_days = Number(days);
          if (exp) payload.expires = exp;
          if (!add && !days && !exp) { toast("충전 금액이나 연장을 입력하세요", { tone: "warn" }); return; }
          try {
            const out = await self.ctx.api("/api/keys/adjust", { method: "POST", body: payload });
            toast(`'${cur.key_alias}' 적용 · 예산 ${out.max_budget == null ? "무제한" : money(out.max_budget)}`, { tone: "good" });
            await loadKeys();
            cur = state.keys.find((x) => x.token === cur.token) || cur;
            paint(cur, out.remaining);
            renderHist(out.history || []);
            b.querySelector("#d-add").value = "";
            b.querySelector("#d-days").value = "";
            b.querySelector("#d-exp").value = "";
            preview();
          } catch (e) { toastError(e, "충전·연장 실패"); }
        });
        const renderHist = (rows) => {
          const box = b.querySelector("#d-hist");
          if (!rows.length) { box.textContent = "아직 충전·연장 이력이 없습니다."; return; }
          box.classList.remove("muted");
          box.innerHTML = `<div class="stack" style="gap:6px">${[...rows].reverse().map((r) => {
            const parts = [];
            if (r.add_budget != null) parts.push(`+${money(r.add_budget)} (${r.max_budget_before != null ? money(r.max_budget_before) : "?"} → ${r.max_budget_after != null ? money(r.max_budget_after) : "?"})`);
            if (r.action === "reissue") parts.push(`폐기 후 새 키${r.replaces ? ` (이전 ${r.replaces})` : ""}`);
            if (r.expires_after) parts.push(`${r.add_days ? `+${r.add_days}일 · ` : ""}만료 ${fmtDateTime(r.expires_after)}`);
            return `<div class="row" style="gap:8px;flex-wrap:nowrap"><span class="led info"></span><span class="num muted nowrap">${esc(fmtDateTime(r.at))}</span><span>${esc(parts.join(" · ") || "변경")}</span><span class="muted" style="margin-left:auto;font-size:11px">${esc(r.by || "")}</span></div>`;
          }).join("")}</div>`;
        };
        self.ctx.api(`/api/keys/info?token=${encodeURIComponent(k.token)}`)
          .then((info) => { if (info.key) { cur = { ...cur, ...info.key, token: k.token }; paint(cur, info.remaining); } renderHist(info.history || []); })
          .catch((e) => { b.querySelector("#d-hist").textContent = `이력을 불러오지 못했습니다: ${e.message}`; });
        self.ctx.api(`/api/activity?token=${encodeURIComponent(k.token)}&limit=15&hours=168`)
          .then((d) => {
            const box = b.querySelector("#d-calls");
            const items = d.items || [];
            if (!items.length) { box.textContent = "최근 7일 호출이 없습니다."; return; }
            box.classList.remove("muted");
            const denied = items.some((it) => it.reason_code === "model_denied");
            const allowed = (cur.models || []).filter(Boolean);
            box.innerHTML = `<div class="stack" style="gap:5px">${items.map((it) => `<div class="row" style="gap:8px;flex-wrap:nowrap"><span class="led ${it.ok ? "good" : "crit"}"></span><span class="num muted nowrap">${esc(fmtDateTime(it.at))}</span><span class="nowrap">${esc(it.model || "")}</span><span class="${it.ok ? "muted" : ""}" style="margin-left:auto;text-align:right">${it.ok ? `${num(it.tokens)} tok · ${it.unpriced ? '<span class="tag warn" title="LiteLLM 가격표에 없는 모델이라 비용이 0 으로 기록됩니다. 예산이 줄지 않습니다.">가격 없음</span>' : money(it.spend)}` : `<span class="tag crit" title="${esc(it.error || "")}">${esc(it.reason || "실패")}</span>`}</span></div>`).join("")}</div>
              ${denied && allowed.length ? `<p class="help" style="margin:10px 0 0">이 키로 쓸 수 있는 모델 이름: ${allowed.map((m) => `<code>${esc(m)}</code>`).join(", ")}. 학생 코드의 <code>model</code> 값을 이 이름 그대로 쓰게 하세요.</p>` : ""}`;
          })
          .catch((e) => { b.querySelector("#d-calls").textContent = `호출 기록을 불러오지 못했습니다: ${e.message}`; });
        b.querySelector("#d-edit").onclick = () => { h.close(); self.openEdit(cur); };
        b.querySelector("#d-block").onclick = () => { h.close(); self.toggleBlock(cur); };
        b.querySelector("#d-reissue").onclick = () => { h.close(); self.reissue(cur); };
        b.querySelector("#d-del").onclick = () => { h.close(); self.remove(cur); };
      },
    });
  },
};
