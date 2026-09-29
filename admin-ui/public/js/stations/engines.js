// 06 공급자(엔진실). 공급자 키와 묶음을 카드로 보여 주고, 등록·수정·점검·최근 호출을 한다.
import { $, $$, esc, icon, money, num, DUR_LABEL, meterHtml, fmtDateTime } from "../lib/util.js";
import { state, loadProviders, loadKeys } from "../lib/store.js";
import { toast, toastError, modal, confirmDialog, busy } from "../lib/ui.js";
import { RESET_OPTIONS } from "../lib/forms.js";

const CAT = ["var(--cat-1)", "var(--cat-2)", "var(--cat-3)", "var(--cat-4)", "var(--cat-5)", "var(--cat-6)", "var(--cat-7)", "var(--cat-8)"];

function remainingLine(p) {
  if (p.max_budget == null) return p.spend != null ? `한도 없음 · 사용 ${money(p.spend)}` : "한도는 회사 사이트에서";
  const left = p.remaining == null ? Number(p.max_budget) - Number(p.spend || 0) : Number(p.remaining);
  return `남은 ${money(Math.max(0, left))} / ${money(p.max_budget)}`;
}

function modelChips(names, name, checked) {
  return names.map((m) => `<label class="chip ${checked.has(m) ? "on" : ""}"><input type="checkbox" name="${esc(name)}" value="${esc(m)}" ${checked.has(m) ? "checked" : ""}>${esc(m)}</label>`).join("")
    || '<span class="muted">모델을 조회하거나 직접 입력하세요</span>';
}

export default {
  id: "engines",
  deps: ["providers", "keys"],
  init(root, ctx) {
    this.ctx = ctx;
    root.innerHTML = `
      <div class="st-inner">
        <div class="st-head">
          <div class="ttl"><div class="code">STATION 06 · ENGINE ROOM</div><h1>공급자 키 · 묶음</h1>
            <p>학생 가상 키가 실제로 호출하는 회사 키입니다. 같은 회사 키도 슬러그만 다르면 여러 개 둘 수 있고, 여러 키를 비율로 나눠 쓰려면 묶음을 만듭니다.</p></div>
          <div class="tools">
            <button class="btn" type="button" id="en-new-pool">${icon("plus")}묶음 만들기</button>
            <button class="btn primary" type="button" id="en-new">${icon("plus")}공급자 키 등록</button>
          </div>
        </div>
        <div class="callout warn"><b>회사 사이트(OpenAI·Anthropic·Google 등)에도 월 지출 한도를 꼭 거세요.</b> 여기 금액은 이 프록시가 센 사용량 기준이라, 집계가 늦거나 원래 키를 다른 곳에서 쓰면 따로 요금이 나갈 수 있습니다. "30일마다" 리셋은 등록 시각부터 30일마다이고 달력의 1일이 아닙니다.</div>
        <h3 style="margin:6px 0 10px;font-size:14px" class="sec">엔진 · 공급자 키</h3>
        <div class="cards" id="en-keys"></div>
        <h3 style="margin:22px 0 10px;font-size:14px" class="sec">묶음 · 비율 분배</h3>
        <div class="cards" id="en-pools"></div>
      </div>`;
    root.querySelector("#en-new").addEventListener("click", () => this.openRegister());
    root.querySelector("#en-new-pool").addEventListener("click", () => this.openPool());
    root.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-act]");
      if (!b) return;
      const p = state.providers.find((x) => x.id === b.dataset.id);
      if (!p) return;
      const act = b.dataset.act;
      if (act === "check") this.check(p, b);
      else if (act === "edit") this.openEdit(p);
      else if (act === "delete") this.remove(p);
      else if (act === "calls") this.calls(p);
      else if (act === "focus") ctx.scene && ctx.scene.focus("engine", p.id);
    });
  },
  enter(params = {}) {
    this.render();
    if (params.id) {
      const card = document.querySelector(`#st-engines [data-card="${CSS.escape(params.id)}"]`);
      if (card) { card.classList.add("focus"); card.scrollIntoView({ block: "center" }); setTimeout(() => card.classList.remove("focus"), 2600); }
      if (this.ctx.scene) this.ctx.scene.focus("engine", params.id);
    }
  },
  refresh() { this.render(); },
  keyUsers(p) {
    const prefix = p.slug ? `${p.slug}/` : null;
    return state.keys.filter((k) => ((k.metadata || {}).aiapi_provider_key_id === p.id) || (prefix && (k.models || []).some((m) => String(m).startsWith(prefix)))).length;
  },
  render() {
    const plain = state.providers.filter((p) => p.kind !== "pool");
    const pools = state.providers.filter((p) => p.kind === "pool");
    $("#en-keys").innerHTML = plain.map((p) => {
      const users = p.builtin ? null : this.keyUsers(p);
      const left = p.max_budget == null ? null : (p.remaining == null ? Number(p.max_budget) - Number(p.spend || 0) : Number(p.remaining));
      const tone = left == null ? "info" : left <= 0 ? "crit" : left / p.max_budget <= 0.2 ? "warn" : "good";
      return `<article class="card" data-card="${esc(p.id)}">
        <div class="card-h"><div class="ttl">${esc(p.label)}<small>${esc(p.provider_label || p.provider)} · ${esc(p.key_hint || "")}</small></div>
          <div class="end"><span class="tag ${tone === "info" ? "info" : tone}"><span class="led ${tone}"></span>${esc(tone === "crit" ? "소진" : tone === "warn" ? "잔액 적음" : p.builtin ? "기본" : "가동")}</span></div></div>
        ${p.max_budget != null ? meterHtml(p.spend, p.max_budget, { showText: false }) : ""}
        <dl class="kv" style="font-size:12px">
          <dt>잔액</dt><dd>${esc(remainingLine(p))}</dd>
          <dt>학생 model 접두사</dt><dd>${p.slug ? `<code>${esc(p.slug)}/</code>` : "없음 (이름 그대로)"}</dd>
          <dt>한도 리셋</dt><dd>${esc(DUR_LABEL[p.budget_duration] || "없음")}</dd>
          ${users != null ? `<dt>쓰는 학생 키</dt><dd class="num">${num(users)}개</dd>` : ""}
          ${p.api_base ? `<dt>주소</dt><dd style="word-break:break-all">${esc(p.api_base)}</dd>` : ""}
        </dl>
        <div class="chips">${(p.models || []).map((m) => `<span class="tag info">${esc(m.call_name)}</span>`).join("")}</div>
        ${p.builtin ? `<p class="help" style="margin:0">${esc(p.note || ".env 의 OPENAI_API_KEY 를 씁니다. 한도는 OpenAI 사이트에서 거세요.")}</p>` : `
        <div class="card-actions">
          <button class="btn xs" type="button" data-act="check" data-id="${esc(p.id)}">${icon("bolt")}상태 점검</button>
          <button class="btn xs" type="button" data-act="edit" data-id="${esc(p.id)}">${icon("edit")}수정</button>
          <span class="push"><button class="btn xs ghost" type="button" data-act="focus" data-id="${esc(p.id)}" title="3D 관제도에서 보기" aria-label="3D 관제도에서 보기">${icon("cube")}</button>
          <button class="btn xs ghost" type="button" data-act="delete" data-id="${esc(p.id)}" aria-label="삭제" title="삭제">${icon("trash")}</button></span>
        </div>`}
      </article>`;
    }).join("");
    $("#en-pools").innerHTML = pools.map((p) => {
      const members = p.members || [];
      const total = members.reduce((a, m) => a + (Number(m.weight) || 0), 0) || 1;
      return `<article class="card" data-card="${esc(p.id)}">
        <div class="card-h"><div class="ttl">${esc(p.label)}<small>학생 model <code>${esc((p.models || []).map((m) => m.call_name).join(", "))}</code></small></div>
          <div class="end"><span class="tag violet">묶음</span></div></div>
        <div>
          <div class="share" role="img" aria-label="${esc(members.map((m) => `${m.label} ${Math.round((m.weight / total) * 100)}%`).join(", "))}">${members.map((m, i) => `<i style="width:${((m.weight / total) * 100).toFixed(2)}%;background:${CAT[i % CAT.length]}"></i>`).join("")}</div>
          <div class="share-legend" style="margin-top:8px">${members.map((m, i) => `<span><i style="background:${CAT[i % CAT.length]}"></i>${esc(m.label)} · ${esc(m.model)} ×${esc(m.weight)} (${Math.round((m.weight / total) * 100)}%)</span>`).join("")}</div>
        </div>
        ${meterHtml(p.spend, p.max_budget, { showText: false })}
        <dl class="kv" style="font-size:12px"><dt>잔액</dt><dd>${esc(remainingLine(p))}</dd><dt>쓰는 학생 키</dt><dd class="num">${num(this.keyUsers(p))}개</dd></dl>
        <p class="help" style="margin:0">한 멤버가 한도·시간 초과·서버 오류를 내면 같은 모델의 다른 멤버로 한 번 더 시도합니다. 인증 실패와 잘못된 요청은 넘기지 않습니다.</p>
        <div class="card-actions">
          <button class="btn xs" type="button" data-act="calls" data-id="${esc(p.id)}">최근 호출</button>
          <span class="push"><button class="btn xs ghost" type="button" data-act="focus" data-id="${esc(p.id)}" title="3D 관제도에서 보기" aria-label="3D 관제도에서 보기">${icon("cube")}</button>
          <button class="btn xs ghost" type="button" data-act="delete" data-id="${esc(p.id)}" aria-label="삭제" title="삭제">${icon("trash")}</button></span>
        </div>
      </article>`;
    }).join("") || `<div class="panel" style="grid-column:1/-1"><p class="muted" style="margin:0">묶음이 없습니다. 공급자 키를 두 개 이상 등록한 뒤 <b>묶음 만들기</b>로 비율을 정해 한 모델 이름으로 쓸 수 있습니다.</p></div>`;
  },

  async check(p, btn) {
    await busy(btn, async () => {
      try {
        const out = await this.ctx.api("/api/provider-keys/preview-stored", { method: "POST", body: { id: p.id } });
        toast(`'${p.label}' 응답 정상 · 모델 ${out.models.length}개${out.latency_ms != null ? ` · ${out.latency_ms}ms` : ""}`, { tone: "good", title: "상태 점검" });
      } catch (e) { toastError(e, `'${p.label}' 점검 실패`); }
    });
  },

  async remove(p) {
    const ok = await confirmDialog({
      title: `'${p.label}' 삭제`,
      message: p.kind === "pool" ? "묶음을 지웁니다. 넣었던 공급자 키는 남습니다. 이 묶음을 쓰는 학생 키가 있으면 거절됩니다." : "공급자 키와 그 모델 배포를 지웁니다. 쓰는 학생 키나 묶음이 있으면 거절됩니다.",
      confirmLabel: "삭제", tone: "danger",
    });
    if (!ok) return;
    try {
      await this.ctx.api("/api/provider-keys/delete", { method: "POST", body: { id: p.id } });
      toast(`'${p.label}' 삭제`, { tone: "good" });
      await loadProviders();
    } catch (e) { toastError(e, "삭제하지 못했습니다"); }
  },

  async calls(p) {
    const h = modal({ title: `${p.label} — 최근 호출`, code: "ROUTING LOG", body: '<p class="muted">불러오는 중…</p>', size: "wide" });
    try {
      const out = await this.ctx.api(`/api/provider-pools/activity?id=${encodeURIComponent(p.id)}`);
      const calls = out.calls || [];
      h.el.querySelector(".modal-b").innerHTML = calls.length ? `<p class="help">최근 7일, 최대 30건. 어느 멤버 키가 처리했는지 보여 줍니다.</p>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>시각</th><th>멤버</th><th>모델</th><th class="r">비율</th><th class="r">금액</th></tr></thead><tbody>
        ${calls.map((c) => `<tr><td class="num">${esc(fmtDateTime(c.at))}</td><td>${esc(c.member)}</td><td>${esc(c.model)}</td><td class="r num">${c.weight ?? "—"}</td><td class="r num">${c.spend == null ? "—" : money(c.spend)}</td></tr>`).join("")}
        </tbody></table></div>` : '<p class="muted">최근 7일 호출 기록이 없습니다.</p>';
    } catch (e) {
      h.el.querySelector(".modal-b").innerHTML = `<div class="callout crit">${esc(e.message)}</div>`;
    }
  },

  // ---------------------------------------------------------------- 등록
  openRegister() {
    const catalog = state.providerCatalog;
    const body = `
      <div class="form-grid">
        <label class="field"><span>표시 이름 <span class="req">*</span></span><input id="pr-label" placeholder="예: 학교 OpenAI A" autofocus></label>
        <label class="field"><span>슬러그 <span class="req">*</span></span><input id="pr-slug" placeholder="openai-a"><span class="hint">영문 소문자·숫자·하이픈. 학생 model 이 <code>슬러그/모델</code> 이 됩니다</span></label>
        <label class="field"><span>회사 <span class="req">*</span></span><select id="pr-provider">${catalog.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join("")}</select></label>
        <label class="field"><span id="pr-secret-l">API 키 <span class="req">*</span></span><input id="pr-secret" type="password" autocomplete="off"></label>
        <label class="field" id="pr-base-w" hidden><span>API 주소 <span class="req">*</span></span><input id="pr-base"></label>
        <label class="field"><span id="pr-budget-l">사용 가능 금액 (USD) <span class="req">*</span></span><input id="pr-budget" type="number" min="0.01" step="1" value="20"><span class="hint">이 키에 잡아 둔 전체 금액</span></label>
        <label class="field"><span>한도 리셋</span><select id="pr-reset">${RESET_OPTIONS}</select><span class="hint">만든 시각부터 셈 · 달력 1일 아님</span></label>
      </div>
      <div class="callout" id="pr-local" hidden>주소는 Ollama 가 도는 기기의 주소입니다(프록시 컨테이너 안의 localhost 는 그 기기가 아닙니다). 그 기기에서 <code>OLLAMA_HOST=0.0.0.0</code> 으로 같은 망 접속을 열어야 합니다. 로컬 모델은 금액이 거의 0이라 학생 키의 금액과 시간대로 막으세요.</div>
      <div class="row" style="margin-top:12px"><button class="btn sm" type="button" id="pr-preview">${icon("bolt")}이 키로 모델 조회</button><span class="muted" style="font-size:12px">조회가 안 되면 아래에 모델 이름을 직접 넣으세요</span></div>
      <div class="chips" id="pr-models" style="margin-top:10px"></div>
      <div class="row" style="margin-top:8px"><input id="pr-manual" placeholder="직접 입력: gpt-4o-mini" style="max-width:280px"><button class="btn xs" type="button" id="pr-add">모델 추가</button></div>`;
    let names = [];
    const checked = new Set();
    const paint = (h) => { h.el.querySelector("#pr-models").innerHTML = modelChips(names, "pr-models", checked); };
    modal({
      title: "공급자 키 등록", code: "ENGINE · MOUNT", body, size: "wide",
      onOpen: (h) => {
        const apply = () => {
          const spec = catalog.find((c) => c.id === h.el.querySelector("#pr-provider").value) || {};
          h.el.querySelector("#pr-base-w").hidden = !spec.needs_base;
          h.el.querySelector("#pr-base").placeholder = spec.base_placeholder || "https://example.com/v1";
          h.el.querySelector("#pr-secret-l").innerHTML = spec.optional_key ? "API 키 (없으면 비움)" : 'API 키 <span class="req">*</span>';
          h.el.querySelector("#pr-budget-l").innerHTML = spec.optional_budget ? "사용 가능 금액 (USD, 비우면 없음)" : '사용 가능 금액 (USD) <span class="req">*</span>';
          h.el.querySelector("#pr-local").hidden = !spec.optional_key;
        };
        h.el.querySelector("#pr-provider").addEventListener("change", apply);
        h.el.querySelector("#pr-reset").value = "30d";
        apply();
        paint(h);
        h.el.querySelector("#pr-models").addEventListener("change", (ev) => { if (ev.target.checked) checked.add(ev.target.value); else checked.delete(ev.target.value); });
        h.el.querySelector("#pr-preview").addEventListener("click", (ev) => busy(ev.currentTarget, async () => {
          try {
            const out = await this.ctx.api("/api/provider-keys/preview", { method: "POST", body: { provider: h.el.querySelector("#pr-provider").value, api_key: h.el.querySelector("#pr-secret").value, api_base: h.el.querySelector("#pr-base").value } });
            names = [...new Set([...names, ...(out.models || [])])];
            if (!checked.size) (out.models || []).filter((m) => /mini|nano|flash|haiku/i.test(m)).slice(0, 3).forEach((m) => checked.add(m));
            paint(h);
            toast(`모델 ${out.models.length}개를 찾았습니다`, { tone: "good" });
          } catch (e) { toastError(e, "모델 조회 실패"); }
        }));
        h.el.querySelector("#pr-add").addEventListener("click", () => {
          const v = h.el.querySelector("#pr-manual").value.trim();
          if (!v) return;
          if (!names.includes(v)) names.push(v);
          checked.add(v);
          h.el.querySelector("#pr-manual").value = "";
          paint(h);
        });
      },
      actions: [
        { label: "취소", tone: "ghost", value: null },
        {
          label: "등록", tone: "primary",
          onClick: async (h) => {
            if (!checked.size) { toast("쓸 모델을 하나 이상 고르세요", { tone: "warn" }); return false; }
            try {
              await this.ctx.api("/api/provider-keys", {
                method: "POST",
                body: {
                  label: h.el.querySelector("#pr-label").value.trim(),
                  slug: h.el.querySelector("#pr-slug").value.trim(),
                  provider: h.el.querySelector("#pr-provider").value,
                  api_key: h.el.querySelector("#pr-secret").value,
                  api_base: h.el.querySelector("#pr-base").value,
                  max_budget: h.el.querySelector("#pr-budget").value,
                  budget_duration: h.el.querySelector("#pr-reset").value,
                  models: [...checked],
                },
              });
              toast("공급자 키를 등록했습니다", { tone: "good" });
              await loadProviders();
            } catch (e) { toastError(e, "등록하지 못했습니다"); return false; }
            return true;
          },
        },
      ],
    });
  },

  openEdit(p) {
    const spec = state.providerCatalog.find((c) => c.id === p.provider) || {};
    let names = (p.models || []).map((m) => m.name);
    const checked = new Set(names);
    const body = `
      <p class="help">슬러그와 회사는 학생 model 이름에 묶여 있어 바꾸지 않습니다. API 키를 비우면 저장된 키를 그대로 씁니다. 학생 키나 묶음이 쓰는 모델은 뺄 수 없습니다.</p>
      <div class="form-grid">
        <label class="field"><span>표시 이름 <span class="req">*</span></span><input id="pe-label" value="${esc(p.label)}"></label>
        <label class="field"><span>슬러그</span><input value="${esc(p.slug)}" readonly></label>
        <label class="field"><span>회사</span><input value="${esc(p.provider_label || p.provider)}" readonly></label>
        <label class="field"><span>API 키 (비우면 유지)</span><input id="pe-secret" type="password" autocomplete="off" placeholder="${esc(p.key_hint || "")}"></label>
        ${spec.needs_base ? `<label class="field"><span>API 주소</span><input id="pe-base" value="${esc(p.api_base || "")}"></label>` : ""}
        <label class="field"><span>사용 가능 금액 (USD)${spec.optional_budget ? "" : ' <span class="req">*</span>'}</span><input id="pe-budget" type="number" min="0" step="1" value="${esc(p.max_budget ?? "")}"></label>
        <label class="field"><span>한도 리셋</span><select id="pe-reset">${RESET_OPTIONS}</select><span class="hint">만든 시각부터 셈 · 달력 1일 아님</span></label>
      </div>
      <div class="row" style="margin-top:12px"><button class="btn sm" type="button" id="pe-preview">${icon("bolt")}저장된 키로 모델 다시 조회</button></div>
      <div class="chips" id="pe-models" style="margin-top:10px"></div>
      <div class="row" style="margin-top:8px"><input id="pe-manual" placeholder="직접 입력" style="max-width:280px"><button class="btn xs" type="button" id="pe-add">모델 추가</button></div>`;
    const paint = (h) => { h.el.querySelector("#pe-models").innerHTML = modelChips(names, "pe-models", checked); };
    modal({
      title: `공급자 키 수정 — ${p.label}`, code: "ENGINE · TUNE", body, size: "wide",
      onOpen: (h) => {
        h.el.querySelector("#pe-reset").value = p.budget_duration || "";
        paint(h);
        h.el.querySelector("#pe-models").addEventListener("change", (ev) => { if (ev.target.checked) checked.add(ev.target.value); else checked.delete(ev.target.value); });
        h.el.querySelector("#pe-preview").addEventListener("click", (ev) => busy(ev.currentTarget, async () => {
          try {
            const out = await this.ctx.api("/api/provider-keys/preview-stored", { method: "POST", body: { id: p.id } });
            names = [...new Set([...names, ...(out.models || [])])];
            paint(h);
            toast(`모델 ${out.models.length}개 · ${out.latency_ms ?? "?"}ms`, { tone: "good" });
          } catch (e) { toastError(e, "조회 실패"); }
        }));
        h.el.querySelector("#pe-add").addEventListener("click", () => {
          const v = h.el.querySelector("#pe-manual").value.trim();
          if (!v) return;
          if (!names.includes(v)) names.push(v);
          checked.add(v);
          h.el.querySelector("#pe-manual").value = "";
          paint(h);
        });
      },
      actions: [
        { label: "취소", tone: "ghost", value: null },
        {
          label: "저장", tone: "primary",
          onClick: async (h) => {
            if (!checked.size) { toast("모델을 하나 이상 고르세요", { tone: "warn" }); return false; }
            const base = h.el.querySelector("#pe-base");
            try {
              await this.ctx.api("/api/provider-keys/update", {
                method: "POST",
                body: {
                  id: p.id,
                  label: h.el.querySelector("#pe-label").value.trim(),
                  api_key: h.el.querySelector("#pe-secret").value,
                  api_base: base ? base.value : undefined,
                  max_budget: h.el.querySelector("#pe-budget").value,
                  budget_duration: h.el.querySelector("#pe-reset").value,
                  models: [...checked],
                },
              });
              toast(`'${p.label}' 저장`, { tone: "good" });
              await Promise.all([loadProviders(), loadKeys()]);
            } catch (e) { toastError(e, "저장하지 못했습니다"); return false; }
            return true;
          },
        },
      ],
    });
  },

  openPool() {
    const sources = state.providers.filter((p) => p.kind !== "pool");
    if (sources.length < 2) { toast("묶음은 공급자 키 두 개부터 만들 수 있습니다", { tone: "warn" }); return; }
    const opts = sources.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}${p.slug ? ` (${esc(p.slug)})` : ""}</option>`).join("");
    const memberRow = (i) => `<div class="row pool-row" style="flex-wrap:nowrap">
        <select class="pm-prov" style="flex:1.2">${opts}</select>
        <select class="pm-model" style="flex:1"></select>
        <input class="pm-weight" type="number" min="1" max="1000" value="1" style="width:84px" aria-label="비율">
        <button class="btn xs ghost pm-del" type="button" aria-label="빼기">${icon("x")}</button></div>`;
    const body = `
      <p class="help">이미 등록한 공급자 키 둘 이상을 학생 모델 이름 하나로 씁니다. 비율 2 와 1 이면 2 인 키가 약 두 배 자주 뽑힙니다. 학생 model 은 <code>묶음슬러그/모델이름</code> 입니다.</p>
      <div class="form-grid">
        <label class="field"><span>표시 이름 <span class="req">*</span></span><input id="po-label" placeholder="예: 수업용 묶음" autofocus></label>
        <label class="field"><span>슬러그 <span class="req">*</span></span><input id="po-slug" placeholder="class-mix"></label>
        <label class="field"><span>학생에게 보일 모델 이름</span><input id="po-model" placeholder="비우면 고른 모델이 같을 때 그 이름"></label>
        <label class="field"><span>사용 가능 금액 (USD) <span class="req">*</span></span><input id="po-budget" type="number" min="0.01" step="1" value="20"></label>
        <label class="field"><span>한도 리셋</span><select id="po-reset">${RESET_OPTIONS}</select><span class="hint">만든 시각부터 셈 · 달력 1일 아님</span></label>
      </div>
      <div class="field" style="margin-top:12px"><span>멤버 · 비율</span><div id="po-members" class="stack" style="gap:6px"></div></div>
      <div class="row" style="margin-top:8px"><button class="btn xs" type="button" id="po-addrow">${icon("plus")}멤버 추가</button><span class="muted" id="po-ratio" style="font-size:12px"></span></div>
      <div class="share" id="po-share" style="margin-top:8px"></div>`;
    modal({
      title: "묶음 만들기", code: "ENGINE · CLUSTER", body, size: "wide",
      onOpen: (h) => {
        const box = h.el.querySelector("#po-members");
        const fillModels = (row) => {
          const p = sources.find((x) => x.id === row.querySelector(".pm-prov").value);
          const cur = row.querySelector(".pm-model").value;
          row.querySelector(".pm-model").innerHTML = (p?.models || []).map((m) => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join("") || '<option value="">모델 없음</option>';
          if ([...row.querySelector(".pm-model").options].some((o) => o.value === cur)) row.querySelector(".pm-model").value = cur;
        };
        const ratio = () => {
          const rows = $$(".pool-row", box);
          const w = rows.map((r) => Number(r.querySelector(".pm-weight").value) || 0);
          const s = w.reduce((a, b) => a + b, 0) || 1;
          h.el.querySelector("#po-ratio").textContent = `호출 비율 ${w.map((x) => `${Math.round((x / s) * 100)}%`).join(" : ")}`;
          h.el.querySelector("#po-share").innerHTML = w.map((x, i) => `<i style="width:${((x / s) * 100).toFixed(2)}%;background:${CAT[i % CAT.length]}"></i>`).join("");
        };
        const add = () => {
          box.insertAdjacentHTML("beforeend", memberRow());
          const row = box.lastElementChild;
          const idx = $$(".pool-row", box).length - 1;
          if (sources[idx]) row.querySelector(".pm-prov").value = sources[idx].id;
          fillModels(row);
          ratio();
        };
        add(); add();
        h.el.querySelector("#po-members").querySelector(".pm-weight").value = "2";
        ratio();
        h.el.querySelector("#po-reset").value = "30d";
        h.el.querySelector("#po-addrow").addEventListener("click", add);
        box.addEventListener("change", (ev) => { if (ev.target.classList.contains("pm-prov")) fillModels(ev.target.closest(".pool-row")); ratio(); });
        box.addEventListener("input", ratio);
        box.addEventListener("click", (ev) => {
          if (!ev.target.closest(".pm-del")) return;
          if ($$(".pool-row", box).length <= 2) { toast("묶음은 멤버 두 개부터입니다", { tone: "warn" }); return; }
          ev.target.closest(".pool-row").remove();
          ratio();
        });
      },
      actions: [
        { label: "취소", tone: "ghost", value: null },
        {
          label: "묶음 만들기", tone: "primary",
          onClick: async (h) => {
            const members = $$(".pool-row", h.el).map((r) => ({ provider_key_id: r.querySelector(".pm-prov").value, model: r.querySelector(".pm-model").value, weight: Number(r.querySelector(".pm-weight").value) })).filter((m) => m.provider_key_id && m.model);
            try {
              await this.ctx.api("/api/provider-pools", {
                method: "POST",
                body: {
                  label: h.el.querySelector("#po-label").value.trim(),
                  slug: h.el.querySelector("#po-slug").value.trim(),
                  model_name: h.el.querySelector("#po-model").value.trim(),
                  max_budget: h.el.querySelector("#po-budget").value,
                  budget_duration: h.el.querySelector("#po-reset").value,
                  members,
                },
              });
              toast("묶음을 만들었습니다", { tone: "good" });
              await loadProviders();
            } catch (e) { toastError(e, "묶음을 만들지 못했습니다"); return false; }
            return true;
          },
        },
      ],
    });
  },
};
