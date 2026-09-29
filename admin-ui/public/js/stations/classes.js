// 04 학급/조. 학급 카드, 생성·수정, 학급 전체 충전, 봉쇄·해제.
import { $, esc, icon, money, num, formatSchedule, DUR_LABEL, sessionState, meterHtml, fmtDateTime } from "../lib/util.js";
import { state, teamStats, loadTeams, loadKeys, providerIdFromModels } from "../lib/store.js";
import { toast, toastError, modal, confirmDialog, busy } from "../lib/ui.js";
import { RESET_OPTIONS, providerOptions, bindModelPicker, scheduleEditor, weekPreview } from "../lib/forms.js";

export default {
  id: "classes",
  deps: ["teams", "keys", "providers"],
  init(root, ctx) {
    this.ctx = ctx;
    root.innerHTML = `
      <div class="st-inner">
        <div class="st-head">
          <div class="ttl"><div class="code">STATION 04 · SQUADRON</div><h1>학급 / 조</h1>
            <p>학급 예산은 소속 학생 키의 <b>합계</b>에 걸리고, 개별 키 예산과 겹쳐 적용됩니다. 시간표를 넣으면 시간대를 따로 정하지 않은 소속 키가 그 시간에만 열립니다.</p></div>
          <div class="tools"><button class="btn primary" type="button" id="c-new">${icon("plus")}새 학급/조</button></div>
        </div>
        <div class="cards" id="c-cards"></div>
      </div>`;
    root.querySelector("#c-new").addEventListener("click", () => this.openForm(null));
    root.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-act]");
      if (!b) return;
      const t = state.teams.find((x) => x.team_id === b.dataset.id);
      if (!t) return;
      const act = b.dataset.act;
      if (act === "keys") ctx.go("keys", { team: t.team_id });
      else if (act === "edit") this.openForm(t);
      else if (act === "topup") ctx.topup({ teamId: t.team_id, title: `${t.team_alias} 전체 충전·연장` });
      else if (act === "lock") this.lock(t);
      else if (act === "unlock") this.unlock(t);
      else if (act === "delete") this.remove(t);
      else if (act === "focus") ctx.scene && ctx.scene.focus("team", t.team_id);
    });
  },
  enter(params = {}) {
    this.render();
    if (params.team_id) this.focusCard(params.team_id);
  },
  refresh() { this.render(); },
  focusCard(id) {
    const card = document.querySelector(`#c-cards [data-card="${CSS.escape(id)}"]`);
    if (!card) return;
    card.classList.add("focus");
    card.scrollIntoView({ block: "center", behavior: document.body.classList.contains("reduce-motion") ? "auto" : "smooth" });
    setTimeout(() => card.classList.remove("focus"), 2600);
    if (this.ctx.scene) this.ctx.scene.focus("team", id);
  },
  render() {
    const teams = [...state.teams].sort((a, b) => String(a.team_alias).localeCompare(String(b.team_alias), "ko", { numeric: true }));
    $("#c-cards").innerHTML = teams.map((t) => {
      const st = teamStats(t.team_id);
      const meta = t.metadata || {};
      const sess = sessionState(meta.aiapi_schedule);
      const lock = meta.aiapi_lockdown;
      const sessTag = lock ? `<span class="tag crit">${icon("lock")} 봉쇄 중</span>` : `<span class="tag ${sess.tone === "off" ? "mute" : sess.tone}"><span class="led ${sess.tone === "off" ? "off" : sess.tone} ${sess.code === "open" ? "pulse" : ""}"></span>${esc(sess.label)}</span>`;
      return `<article class="card ${lock ? "locked" : ""}" data-card="${esc(t.team_id)}">
        <div class="card-h">
          <div class="ttl">${esc(t.team_alias || t.team_id.slice(0, 8))}<small>키 ${num(st.total)}개 · 사용 중 ${num(st.active)} · 차단 ${num(st.blocked)}${st.over ? ` · 소진 ${num(st.over)}` : ""}${st.expired ? ` · 만료 ${num(st.expired)}` : ""}</small></div>
          <div class="end">${sessTag}</div>
        </div>
        ${lock ? `<div class="callout crit" style="margin:0">봉쇄 ${esc(fmtDateTime(lock.at))} · ${esc(lock.by || "")}${lock.reason ? ` · ${esc(lock.reason)}` : ""}<br>봉쇄 해제 시 봉쇄로 막은 키 ${num(lock.keys ?? 0)}개만 다시 열립니다.</div>` : ""}
        ${meterHtml(t.spend, t.max_budget)}
        <dl class="kv" style="font-size:12px">
          <dt>예산 리셋</dt><dd>${esc(DUR_LABEL[t.budget_duration] || "없음")}</dd>
          <dt>허용 모델</dt><dd>${esc((t.models || []).join(", ") || "제한 없음")}</dd>
          <dt>RPM / TPM</dt><dd class="num">${esc(t.rpm_limit ?? "—")} / ${esc(t.tpm_limit ?? "—")}</dd>
          <dt>시간표</dt><dd>${esc(formatSchedule(meta.aiapi_schedule))}</dd>
        </dl>
        ${weekPreview(meta.aiapi_schedule || [])}
        <div class="card-actions">
          <button class="btn xs" type="button" data-act="keys" data-id="${esc(t.team_id)}">키 보기</button>
          <button class="btn xs" type="button" data-act="edit" data-id="${esc(t.team_id)}">${icon("edit")}수정</button>
          <button class="btn xs" type="button" data-act="topup" data-id="${esc(t.team_id)}">${icon("coin")}전체 충전</button>
          ${lock ? `<button class="btn xs" type="button" data-act="unlock" data-id="${esc(t.team_id)}">${icon("unlock")}봉쇄 해제</button>`
            : `<button class="btn xs danger" type="button" data-act="lock" data-id="${esc(t.team_id)}">${icon("lock")}봉쇄</button>`}
          <span class="push">
            <button class="btn xs ghost" type="button" data-act="focus" data-id="${esc(t.team_id)}" title="3D 관제도에서 보기" aria-label="3D 관제도에서 보기">${icon("cube")}</button>
            <button class="btn xs ghost" type="button" data-act="delete" data-id="${esc(t.team_id)}" aria-label="학급 삭제" title="학급 삭제">${icon("trash")}</button>
          </span>
        </div>
      </article>`;
    }).join("") || `<div class="panel" style="grid-column:1/-1"><p class="muted" style="margin:0">아직 학급/조가 없습니다. <b>새 학급/조</b>로 만들거나, <b>키 발급 → 학급 일괄</b>에서 새 학급 이름을 적으면 함께 만들어집니다.</p></div>`;
  },

  openForm(t) {
    const editing = Boolean(t);
    const meta = (t && t.metadata) || {};
    const providerId = t ? providerIdFromModels(t.models) : "env";
    const body = `
      <div class="form-grid">
        ${editing ? "" : `<label class="field"><span>학급/조 이름 <span class="req">*</span></span><input id="t-name" placeholder="예: 3학년A반, 캡스톤1조" autofocus></label>`}
        <label class="field"><span>학급 예산 (USD)</span><input id="t-budget" type="number" min="0" step="1" value="${esc(t && t.max_budget != null ? t.max_budget : "")}" placeholder="비우면 한도 없음"></label>
        <label class="field"><span>예산 리셋</span><select id="t-reset">${RESET_OPTIONS}</select><span class="hint">만든 시각부터 셈 · 달력 1일 아님</span></label>
        <label class="field"><span>학급 RPM</span><input id="t-rpm" type="number" min="1" value="${esc((t && t.rpm_limit) ?? "")}" placeholder="무제한"></label>
        <label class="field"><span>학급 TPM</span><input id="t-tpm" type="number" min="1" value="${esc((t && t.tpm_limit) ?? "")}" placeholder="무제한"></label>
      </div>
      <div class="form-grid" style="margin-top:12px"><label class="field"><span>공급자 키</span><select id="t-prov">${providerOptions(providerId)}</select></label></div>
      <div class="field" style="margin-top:12px"><span>허용 모델</span><div class="chips" id="t-models"></div><span class="hint">고르지 않으면 이 공급자의 모델 전체. 목록은 새로 발급하는 키에도 복사되고, 목록 밖 모델은 프록시가 거부합니다.</span></div>
      <div class="field" style="margin-top:14px"><span>학급 시간표</span><div id="t-sched"></div></div>`;
    modal({
      title: editing ? `학급 수정 — ${t.team_alias}` : "새 학급/조", code: editing ? "SQUADRON · EDIT" : "SQUADRON · NEW", body, size: "wide",
      onOpen: (h) => {
        h.el.querySelector("#t-reset").value = (t && t.budget_duration) || "";
        h.picker = bindModelPicker({ select: h.el.querySelector("#t-prov"), box: h.el.querySelector("#t-models"), name: "t-models" });
        if (editing) h.picker.set(providerId, t.models || []);
        h.sched = scheduleEditor(h.el.querySelector("#t-sched"), meta.aiapi_schedule || [], { note: "비우면 항상. 시간대를 따로 넣지 않은 소속 키가 이 시간을 따릅니다." });
      },
      actions: [
        { label: "취소", tone: "ghost", value: null },
        {
          label: editing ? "저장" : "만들기", tone: "primary",
          onClick: async (h) => {
            const payload = {
              budget: h.el.querySelector("#t-budget").value,
              budget_duration: h.el.querySelector("#t-reset").value,
              rpm_limit: h.el.querySelector("#t-rpm").value,
              tpm_limit: h.el.querySelector("#t-tpm").value,
              models: h.picker.read(),
              provider_key_id: h.el.querySelector("#t-prov").value,
              schedule: h.sched.read(),
            };
            try {
              if (editing) {
                const out = await this.ctx.api("/api/teams/update", { method: "POST", body: { team_id: t.team_id, alias: t.team_alias, ...payload } });
                toast(`'${t.team_alias}' 저장${out.schedule_keys ? ` · 학급 시간표를 따르는 키 ${out.schedule_keys}개에 반영` : ""}`, { tone: "good" });
              } else {
                const alias = h.el.querySelector("#t-name").value.trim();
                if (!alias) { toast("학급/조 이름을 입력하세요", { tone: "warn" }); return false; }
                await this.ctx.api("/api/teams", { method: "POST", body: { alias, ...payload } });
                toast(`'${alias}' 만들었습니다`, { tone: "good" });
              }
              await Promise.all([loadTeams(), loadKeys()]);
            } catch (e) { toastError(e, "저장하지 못했습니다"); return false; }
            return true;
          },
        },
      ],
    });
  },

  async lock(t) {
    const st = teamStats(t.team_id);
    const body = `
      <p style="margin:0 0 10px;line-height:1.6"><b>${esc(t.team_alias)}</b>의 열린 키를 모두 막습니다. 시험 중이거나 사고가 났을 때 씁니다.</p>
      <div class="callout warn">지금 사용 중인 키 약 ${num(st.active)}개가 곧바로 막힙니다. 이미 막혀 있던 키는 건드리지 않고, 해제할 때도 그대로 둡니다.</div>
      <label class="field"><span>사유 (선택)</span><input id="lk-reason" maxlength="120" placeholder="예: 중간고사, 키 유출 점검" autofocus></label>`;
    modal({
      title: `${t.team_alias} 봉쇄`, code: "RED ALERT · LOCKDOWN", body, tone: "crit",
      actions: [
        { label: "취소", tone: "ghost", value: null },
        {
          label: "봉쇄", tone: "danger",
          onClick: async (h) => {
            try {
              const out = await this.ctx.api("/api/teams/lockdown", { method: "POST", body: { team_id: t.team_id, action: "lock", reason: h.el.querySelector("#lk-reason").value.trim() } });
              const n = out.results.filter((r) => r.blocked && !r.skipped).length;
              const fail = out.results.filter((r) => r.error).length;
              toast(`${t.team_alias} 봉쇄 · 키 ${n}개 차단${fail ? ` · 실패 ${fail}` : ""}`, { tone: fail ? "warn" : "good", title: "학급 봉쇄" });
              await Promise.all([loadTeams(), loadKeys()]);
            } catch (e) { toastError(e, "봉쇄하지 못했습니다"); return false; }
            return true;
          },
        },
      ],
    });
  },

  async unlock(t) {
    const lock = (t.metadata || {}).aiapi_lockdown || {};
    const ok = await confirmDialog({
      title: `${t.team_alias} 봉쇄 해제`, message: `봉쇄로 막은 키 ${lock.keys ?? "?"}개를 다시 엽니다. 봉쇄 전부터 막혀 있던 키와 폐기된 키는 그대로 둡니다.`,
      confirmLabel: "봉쇄 해제",
    });
    if (!ok) return;
    try {
      const out = await this.ctx.api("/api/teams/lockdown", { method: "POST", body: { team_id: t.team_id, action: "unlock" } });
      const n = out.results.filter((r) => r.unblocked).length;
      toast(`${t.team_alias} 봉쇄 해제 · 키 ${n}개 다시 열림`, { tone: "good", title: "봉쇄 해제" });
      await Promise.all([loadTeams(), loadKeys()]);
    } catch (e) { toastError(e, "봉쇄를 풀지 못했습니다"); }
  },

  async remove(t) {
    const st = teamStats(t.team_id);
    const ok = await confirmDialog({
      title: `'${t.team_alias}' 삭제`, message: `학급과 소속 키 ${st.total}개가 LiteLLM 에서 함께 지워집니다. 되돌릴 수 없습니다.`,
      confirmLabel: "학급 삭제", tone: "danger", typed: t.team_alias,
    });
    if (!ok) return;
    try {
      await this.ctx.api("/api/teams/delete", { method: "POST", body: { team_id: t.team_id } });
      toast(`'${t.team_alias}' 삭제`, { tone: "good" });
      await Promise.all([loadTeams(), loadKeys()]);
    } catch (e) { toastError(e, "삭제하지 못했습니다"); }
  },
};
