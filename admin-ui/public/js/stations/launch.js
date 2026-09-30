// 05 키 발급. 학급 일괄 · 캠프 짧은 키 · 한 명. 발급 직후에만 키가 보이므로 CSV·안내문을 바로 준다.
import { $, $$, esc, icon, money, num, todayYmd, toCsv, downloadText, copyText, snippetPython } from "../lib/util.js";
import { state, teamById, loadKeys, loadTeams, providerIdFromModels } from "../lib/store.js";
import { toast, toastError, confirmDialog, reveal, busy, modal } from "../lib/ui.js";
import { RESET_OPTIONS, DURATION_OPTIONS, teamOptions, providerOptions, bindModelPicker, scheduleEditor } from "../lib/forms.js";

const TABS = [["bulk", "CLASS", "학급 일괄"], ["camp", "CAMP", "캠프 짧은 키"], ["single", "SINGLE", "한 명"]];

function printHandouts(cards, { title, proxyUrl }) {
  const root = $("#print-root");
  root.innerHTML = `<div class="p-sheet"><h1>${esc(title)}</h1><p>접속 주소 <b>${esc(proxyUrl)}</b> · 키는 다른 사람과 나누지 마세요. 키를 잃어버리면 <b>${esc(location.origin)}</b> 에 학교 구글 계정으로 로그인해 다시 볼 수 있어요(선생님이 계정을 등록한 경우).</p>
    <div class="p-cards">${cards.map((c) => `<div class="p-card"><div class="nm">${esc(c.name)}</div>
      <div>API 키</div><div class="key">${esc(c.key)}</div>
      <div>모델 <b>${esc(c.model)}</b>${c.expires ? ` · 만료 ${esc(c.expires)}` : ""}${c.budget != null ? ` · 예산 ${esc(money(c.budget))}` : ""}</div>
      <pre>${esc(snippetPython(proxyUrl, c.model, c.key))}</pre></div>`).join("")}</div></div>`;
  window.print();
}

function printCodes(rows, expires) {
  $("#print-root").innerHTML = `<div class="p-sheet"><h1>캠프 키 ${rows.length}개 · ${esc(expires)} 당일 종료</h1>
    <p>굵은 짧은 코드를 칠판·명찰에 적고, 아래 작은 글씨의 API 키를 실습 코드에 넣습니다.</p>
    <ol class="p-codes">${rows.map((r) => `<li>${esc(r.code)}<small>${esc(r.key)}</small></li>`).join("")}</ol></div>`;
  window.print();
}

export default {
  id: "launch",
  deps: ["teams", "providers", "keys"],
  init(root, ctx) {
    this.ctx = ctx;
    this.tab = "bulk";
    root.innerHTML = `
      <div class="st-inner">
        <div class="st-head">
          <div class="ttl"><div class="code">STATION 05 · LAUNCH BAY</div><h1>키 발급</h1>
            <p>새 키의 비밀값은 <b>발급 직후 한 번만</b> 보입니다. 결과 화면에서 CSV 를 받거나 학생 안내문을 인쇄하세요. 이미 있는 별칭은 다시 만들지 않습니다.</p></div>
        </div>
        <div class="tabs" role="tablist">${TABS.map(([id, code, label]) => `<button class="tab" role="tab" type="button" data-tab="${id}" aria-selected="false"><span class="code">${code}</span>${label}</button>`).join("")}</div>
        <div data-pane="bulk"></div>
        <div data-pane="camp" hidden></div>
        <div data-pane="single" hidden></div>
      </div>`;
    root.querySelector(".tabs").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-tab]");
      if (b) this.show(b.dataset.tab);
    });
    this.buildBulk(root.querySelector('[data-pane="bulk"]'));
    this.buildCamp(root.querySelector('[data-pane="camp"]'));
    this.buildSingle(root.querySelector('[data-pane="single"]'));
    this.show("bulk");
  },
  show(tab) {
    this.tab = TABS.some(([id]) => id === tab) ? tab : "bulk";
    for (const b of $$("#st-launch .tab")) b.setAttribute("aria-selected", String(b.dataset.tab === this.tab));
    for (const p of $$("#st-launch [data-pane]")) p.hidden = p.dataset.pane !== this.tab;
  },
  enter(params = {}) {
    if (params.tab) this.show(params.tab);
    this.refresh();
  },
  // 입력 중인 폼을 흔들지 않게, 바뀐 데이터에 해당하는 부분만 다시 그린다.
  refresh(ev) {
    if (!ev || ev === "teams") {
      for (const sel of $$("#st-launch select[data-teams]")) {
        const cur = sel.value;
        sel.innerHTML = teamOptions({ selected: cur, withNew: sel.dataset.teams === "new" });
        sel.value = cur;
      }
    }
    if (!ev || ev === "providers") {
      for (const p of [this.bulkPicker, this.campPicker, this.singlePicker]) if (p) p.refresh(p.read());
    }
    if (this.updateBulkPreview) this.updateBulkPreview();
    if (this.updateCampPreview) this.updateCampPreview();
  },

  // 학급을 고르면 그 학급의 공급자·모델을 맞춘다.
  syncFromTeam(teamId, picker) {
    const t = teamById(teamId);
    if (t && (t.models || []).length) picker.set(providerIdFromModels(t.models), t.models);
  },

  // ---------------------------------------------------------------- 학급 일괄
  buildBulk(pane) {
    pane.innerHTML = `
      <div class="grid" style="grid-template-columns:minmax(0,1.15fr) minmax(0,1fr)">
        <section class="panel">
          <div class="panel-h"><span class="code">CLASS ROSTER</span><h2>학급 일괄 발급</h2></div>
          <p class="help">명단 전원에게 <b>같은 금액·같은 기간</b>의 키를 줍니다. 별칭은 <code>학번-이름</code> 입니다.</p>
          <div class="form-grid">
            <label class="field"><span>학급/조</span><select id="lb-team" data-teams="new"></select></label>
            <label class="field" id="lb-newname-wrap" hidden><span>새 학급 이름 <span class="req">*</span></span><input id="lb-newname" placeholder="예: 3학년A반"></label>
            <label class="field"><span>인당 예산 (USD) <span class="req">*</span></span><input id="lb-budget" type="number" min="0" step="0.5" value="2"></label>
            <label class="field"><span>만료일</span><input id="lb-expires" type="date" min="${todayYmd()}"><span class="hint">그날 하루 끝까지</span></label>
            <label class="field"><span>또는 상대 만료</span><select id="lb-duration">${DURATION_OPTIONS}</select></label>
            <label class="field"><span>예산 리셋</span><select id="lb-reset">${RESET_OPTIONS}</select><span class="hint">만든 시각부터 셈 · 달력 1일 아님</span></label>
          </div>
          <div class="form-grid" style="margin-top:12px"><label class="field"><span>공급자 키 <span class="req">*</span></span><select id="lb-prov">${providerOptions()}</select></label></div>
          <div class="field" style="margin-top:12px"><span>허용 모델</span><div class="chips" id="lb-models"></div><span class="hint" id="lb-hint"></span></div>
          <div class="field" style="margin-top:12px"><span>사용 시간대</span><div id="lb-sched"></div><span class="hint">비우면 학급 시간표를 따릅니다. 여기에 넣으면 이번에 만드는 키만 그 시간입니다.</span></div>
        </section>
        <section class="panel">
          <div class="panel-h"><span class="code">MANIFEST</span><h2>명단</h2><span class="end"><label class="btn xs" style="cursor:pointer">${icon("down")}CSV 불러오기<input id="lb-file" type="file" accept=".csv,text/csv,text/plain,.txt" hidden></label></span></div>
          <p class="help">한 줄에 <code>학번,이름,이메일</code> (쉼표·탭·공백). 헤더 <code>학번,이름</code> 과 <code>name,student_id</code> 도 됩니다.
            <b>이메일(학생 구글 계정)</b>을 넣으면 학생 계정도 함께 등록되어, 학생은 그 계정으로 로그인해 <b>자기 키를 직접 보고 복사</b>합니다. 키를 하나하나 나눠 줄 필요가 없어요.</p>
          <textarea id="lb-roster" rows="9" spellcheck="false" autocomplete="off" placeholder="학번,이름,이메일&#10;20261001,홍길동,hong@school.kr&#10;20261002,김철수,kim@school.kr"></textarea>
          <div id="lb-preview" style="margin-top:10px"></div>
          <div class="row" style="margin-top:12px"><button class="btn primary" type="button" id="lb-go">${icon("launch")}일괄 발급</button><span class="muted" style="font-size:12px">이미 있는 별칭은 실패로 남기고 나머지는 계속 발급합니다.</span></div>
        </section>
      </div>
      <div id="lb-result" style="margin-top:14px"></div>`;
    const team = pane.querySelector("#lb-team");
    team.innerHTML = teamOptions({ withNew: true });
    this.bulkPicker = bindModelPicker({ select: pane.querySelector("#lb-prov"), box: pane.querySelector("#lb-models"), name: "lb-models", hint: pane.querySelector("#lb-hint") });
    this.bulkSched = scheduleEditor(pane.querySelector("#lb-sched"), []);
    team.addEventListener("change", () => {
      pane.querySelector("#lb-newname-wrap").hidden = team.value !== "__new__";
      if (team.value && team.value !== "__new__") this.syncFromTeam(team.value, this.bulkPicker);
      this.updateBulkPreview();
    });
    const parse = () => (window.Roster ? window.Roster.parseRoster(pane.querySelector("#lb-roster").value) : { students: [], errors: [{ error: "명단 해석기를 불러오지 못했습니다" }] });
    this.updateBulkPreview = () => {
      const { students, errors } = parse();
      const box = pane.querySelector("#lb-preview");
      if (!students.length && !errors.length) { box.innerHTML = '<p class="muted" style="margin:0;font-size:12px">명단을 붙여넣거나 CSV 를 불러오면 미리보기가 나옵니다.</p>'; return; }
      const exp = pane.querySelector("#lb-expires").value;
      const dur = pane.querySelector("#lb-duration").value;
      const existing = new Set(state.keys.map((k) => k.key_alias));
      const dup = students.filter((s) => existing.has(s.alias)).length;
      box.innerHTML = `
        <div class="row" style="margin-bottom:8px;font-size:12px">
          <span class="tag info">${num(students.length)}명</span>
          <span class="tag">인당 ${esc(money(Number(pane.querySelector("#lb-budget").value) || 0))}</span>
          <span class="tag">${esc(exp ? `${exp} 하루 끝` : dur || "무기한")}</span>
          ${dup ? `<span class="tag warn">이미 있는 별칭 ${dup}</span>` : ""}
          ${students.some((s) => s.email) ? `<span class="tag good">로그인 계정 ${students.filter((s) => s.email).length}명</span>` : '<span class="tag">이메일 없음 — 학생 로그인 없이 발급만</span>'}
          ${errors.length ? `<span class="tag crit">해석 실패 ${errors.length}줄</span>` : ""}
          ${exp && dur ? '<span class="tag warn">만료일이 있으면 상대 만료는 무시</span>' : ""}
        </div>
        <div class="tbl-wrap" style="max-height:220px"><table class="tbl"><thead><tr><th>#</th><th>별칭</th><th>학번</th><th>이름</th><th>이메일(로그인 계정)</th></tr></thead><tbody>
          ${students.slice(0, 60).map((s, i) => `<tr class="${existing.has(s.alias) ? "bad" : ""}"><td class="num muted">${i + 1}</td><td>${esc(s.alias)}${existing.has(s.alias) ? ' <span class="tag warn">있음</span>' : ""}</td><td class="num">${esc(s.student_id || "")}</td><td>${esc(s.name || "")}</td><td class="sec" style="font-size:12px">${s.email ? esc(s.email) : '<span class="muted">없음 — 학생이 로그인해 볼 수 없음</span>'}</td></tr>`).join("")}
          ${errors.slice(0, 10).map((e) => `<tr class="bad"><td class="num muted">${esc(e.line ?? "")}</td><td colspan="4"><span class="tag crit">해석 실패</span> ${esc(e.raw || "")} — ${esc(e.error || "")}</td></tr>`).join("")}
        </tbody></table></div>
        ${students.length > 60 ? `<p class="muted" style="font-size:12px;margin:6px 0 0">처음 60명만 표시</p>` : ""}`;
    };
    for (const id of ["#lb-roster", "#lb-budget", "#lb-expires", "#lb-duration"]) pane.querySelector(id).addEventListener("input", this.updateBulkPreview);
    pane.querySelector("#lb-duration").addEventListener("change", this.updateBulkPreview);
    pane.querySelector("#lb-file").addEventListener("change", (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { pane.querySelector("#lb-roster").value = String(reader.result || ""); this.updateBulkPreview(); };
      reader.readAsText(f, "utf-8");
    });
    this.updateBulkPreview();
    pane.querySelector("#lb-go").addEventListener("click", (ev) => busy(ev.currentTarget, async () => {
      const { students, errors } = parse();
      if (!students.length && !errors.length) { toast("명단을 붙여넣거나 CSV 를 불러오세요", { tone: "warn" }); return; }
      const budget = pane.querySelector("#lb-budget").value;
      if (budget === "" || Number(budget) < 0) { toast("인당 예산을 입력하세요", { tone: "warn" }); return; }
      const models = this.bulkPicker.read();
      if (!models.length) { toast("허용 모델을 하나 이상 고르세요", { tone: "warn" }); return; }
      const payload = {
        csv: pane.querySelector("#lb-roster").value,
        budget,
        budget_duration: pane.querySelector("#lb-reset").value,
        duration: pane.querySelector("#lb-duration").value,
        expires: pane.querySelector("#lb-expires").value,
        models,
        provider_key_id: pane.querySelector("#lb-prov").value,
        schedule: this.bulkSched.read(),
      };
      if (team.value === "__new__") {
        const name = pane.querySelector("#lb-newname").value.trim();
        if (!name) { toast("새 학급 이름을 입력하세요", { tone: "warn" }); return; }
        payload.team = name;
      } else if (team.value) payload.team_id = team.value;
      const ok = await confirmDialog({ title: `${students.length}명에게 키 발급`, message: `인당 ${money(Number(budget))} · 모델 ${models.join(", ")}`, confirmLabel: "발급" });
      if (!ok) return;
      try {
        const out = await this.ctx.api("/api/keys/bulk", { method: "POST", body: payload });
        this.renderBulkResult(out);
        if (out.results.some((r) => r.key)) {
          pane.querySelector("#lb-roster").value = "";
          pane.querySelector("#lb-file").value = "";
          this.updateBulkPreview();
        }
        await Promise.all([loadKeys(), loadTeams()]);
      } catch (e) { toastError(e, "일괄 발급 실패"); }
    }));
  },
  renderBulkResult(out) {
    const rows = out.results || [];
    const okRows = rows.filter((r) => r.key);
    const bad = rows.filter((r) => r.error);
    const model = (out.models || [])[0] || "gpt-4o-mini";
    const proxy = this.ctx.proxyUrl();
    const acc = out.accounts || { created: 0, linked: 0, unchanged: 0, failed: 0 };
    const accountTag = (r) => {
      if (!r.email) return '<span class="muted">—</span>';
      const label = { created: '<span class="tag good">계정 등록</span>', linked: '<span class="tag info">키 연결</span>', unchanged: '<span class="tag">이미 연결</span>', admin: '<span class="tag">관리자</span>', error: `<span class="tag crit" title="${esc(r.account_error || "")}">등록 실패</span>` }[r.account] || "";
      return `${label} ${esc(r.email)}`;
    };
    toast(`${okRows.length}명 발급${bad.length ? ` · 실패 ${bad.length}` : ""}${acc.created + acc.linked ? ` · 학생 계정 ${acc.created + acc.linked}명 연결` : ""}`, { tone: bad.length ? "warn" : "good", title: "학급 일괄 발급" });
    const box = $("#lb-result");
    box.innerHTML = `<section class="panel">
      <div class="panel-h"><span class="code">LAUNCH REPORT</span><h2>발급 결과</h2>
        <span class="end"><span class="tag good">성공 ${okRows.length}</span>${bad.length ? `<span class="tag crit">실패 ${bad.length}</span>` : ""}${out.team_created ? '<span class="tag info">학급 새로 만듦</span>' : ""}</span></div>
      ${acc.created || acc.linked || acc.unchanged
    ? `<div class="callout">이메일을 넣은 학생 <b>${acc.created + acc.linked + acc.unchanged}명</b>은 이 관리 화면 주소(<code>${esc(location.origin)}</code>)에 그 구글 계정으로 로그인하면 <b>자기 키를 보고 복사</b>할 수 있습니다. 계정 새로 등록 ${acc.created} · 키 연결 ${acc.linked}${acc.failed ? ` · <span style="color:#ffc9c9">계정 등록 실패 ${acc.failed}</span>` : ""}</div>`
    : `<div class="callout warn">이메일이 없어 학생이 로그인해 키를 볼 수 없습니다. CSV 를 받거나 안내문을 인쇄해 나눠 주세요. (명단에 이메일 칸을 넣으면 학생이 직접 봅니다)</div>`}
      <div class="row" style="margin-bottom:10px">
        <button class="btn primary sm" type="button" id="lr-csv" ${okRows.length ? "" : "disabled"}>${icon("down")}키 CSV 받기</button>
        <button class="btn sm" type="button" id="lr-print" ${okRows.length ? "" : "disabled"}>${icon("print")}학생 안내문 인쇄</button>
        <span class="muted" style="font-size:12px">인당 ${out.max_budget != null ? money(out.max_budget) : "—"} · ${esc(out.expires || out.duration || "무기한")} · 모델 ${esc((out.models || []).join(", "))}</span>
      </div>
      <div class="tbl-wrap" style="max-height:340px"><table class="tbl"><thead><tr><th>상태</th><th>별칭</th><th>학번</th><th>이름</th><th>로그인 계정</th><th>키 / 오류</th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="${r.key ? "ok" : "bad"}"><td>${r.key ? '<span class="tag good">성공</span>' : r.skipped ? '<span class="tag warn">이미 있음</span>' : '<span class="tag crit">실패</span>'}</td><td>${esc(r.alias)}</td><td class="num">${esc(r.student_id || "")}</td><td>${esc(r.name || "")}</td><td style="font-size:12px">${accountTag(r)}</td><td>${r.key ? `<code>${esc(r.key)}</code>` : `<span style="color:#ffc9c9">${esc(r.error)}</span>`}</td></tr>`).join("")}
      </tbody></table></div></section>`;
    box.querySelector("#lr-csv").onclick = () => downloadText(`issued_keys_${todayYmd()}.csv`, toCsv(["alias", "student_id", "name", "api_key", "base_url", "model"], okRows.map((r) => [r.alias, r.student_id || "", r.name || "", r.key, proxy, model])));
    box.querySelector("#lr-print").onclick = () => printHandouts(okRows.map((r) => ({ name: r.name ? `${r.name} (${r.student_id || r.alias})` : r.alias, key: r.key, model, budget: out.max_budget, expires: out.expires || "" })), { title: `${out.team_alias || "학급"} AI API 키 안내`, proxyUrl: proxy });
    box.scrollIntoView({ block: "start", behavior: "smooth" });
  },

  // ---------------------------------------------------------------- 캠프
  buildCamp(pane) {
    pane.innerHTML = `
      <div class="grid" style="grid-template-columns:minmax(0,1.15fr) minmax(0,1fr)">
        <section class="panel">
          <div class="panel-h"><span class="code">CAMP</span><h2>캠프 짧은 키 (명단 없이 N개)</h2></div>
          <p class="help">체험 캠프처럼 명단이 없을 때 인원수만큼 <code>CAMP-A7K2</code> 같은 짧은 코드를 만듭니다. 학생 API 키는 앞에 <code>sk-</code> 를 붙인 값입니다. 만료는 <b>오늘 23:59</b> 고정, 모델은 <b>저가 모델만</b> 됩니다. 헷갈리는 글자(0/O, 1/I/L)는 빼 둡니다.</p>
          <div class="form-grid">
            <label class="field"><span>인원 N <span class="req">*</span></span><input id="lc-count" type="number" min="1" max="200" value="30"></label>
            <label class="field"><span>짧은 접두어</span><input id="lc-prefix" value="CAMP" maxlength="8"></label>
            <label class="field"><span>인당 예산 (USD)</span><input id="lc-budget" type="number" min="0" step="0.5" value="1"></label>
            <label class="field"><span>만료</span><input id="lc-expires" type="text" readonly value="${todayYmd()} 23:59 당일 종료"></label>
            <label class="field"><span>소속 학급/조</span><select id="lc-team" data-teams="new"></select></label>
            <label class="field" id="lc-newname-wrap" hidden><span>새 학급 이름 <span class="req">*</span></span><input id="lc-newname" placeholder="예: 캠프1일차"></label>
            <label class="field"><span>분당 요청 (RPM)</span><input id="lc-rpm" type="number" min="1" value="10"></label>
          </div>
          <div class="form-grid" style="margin-top:12px"><label class="field"><span>공급자 키 <span class="req">*</span></span><select id="lc-prov">${providerOptions()}</select></label></div>
          <div class="field" style="margin-top:12px"><span>허용 모델 <span class="req">*</span></span><div class="chips" id="lc-models"></div></div>
          <div class="field" style="margin-top:12px"><span>사용 시간대</span><div id="lc-sched"></div><span class="hint">비우면 당일 항상. 체험 시간만 열려면 시간대를 넣으세요.</span></div>
          <p class="help" id="lc-preview" style="margin-top:10px"></p>
          <button class="btn primary" type="button" id="lc-go">${icon("launch")}짧은 키 만들기</button>
        </section>
        <section class="panel">
          <div class="panel-h"><span class="code">CAMP · END</span><h2>캠프 끝나면</h2></div>
          <p class="help">키는 오늘 23:59 에 만료됩니다. 일찍 끝났거나 확실히 막으려면 차단하세요. 학급 일괄 키는 건드리지 않습니다. 매일 자정 뒤 <code>scripts/revoke_camp_keys.py</code> 를 cron 으로 돌려도 됩니다.</p>
          <div class="stack" style="gap:8px">
            <button class="btn warn" type="button" id="lc-rev-today">${icon("ban")}오늘 캠프 키 모두 차단</button>
            <button class="btn" type="button" id="lc-rev-due">${icon("ban")}만료된 캠프 키 차단</button>
          </div>
          <div id="lc-rev-result" style="margin-top:10px"></div>
        </section>
      </div>
      <div id="lc-result" style="margin-top:14px"></div>`;
    const team = pane.querySelector("#lc-team");
    team.innerHTML = teamOptions({ withNew: true });
    this.campPicker = bindModelPicker({ select: pane.querySelector("#lc-prov"), box: pane.querySelector("#lc-models"), name: "lc-models", campOnly: true });
    this.campSched = scheduleEditor(pane.querySelector("#lc-sched"), [], { note: "비우면 당일 항상. 한국(서울) 시간." });
    team.addEventListener("change", () => {
      pane.querySelector("#lc-newname-wrap").hidden = team.value !== "__new__";
      if (team.value && team.value !== "__new__") this.syncFromTeam(team.value, this.campPicker);
      this.updateCampPreview();
    });
    this.updateCampPreview = () => {
      const n = Number(pane.querySelector("#lc-count").value);
      const prefix = (pane.querySelector("#lc-prefix").value || "CAMP").toUpperCase().replace(/[^A-Z0-9]/g, "") || "CAMP";
      const models = this.campPicker.read();
      pane.querySelector("#lc-preview").innerHTML = Number.isInteger(n) && n > 0
        ? `미리보기 <b>${num(n)}개</b> · 예: <code>${esc(prefix)}-A7K2</code> → API 키 <code>sk-${esc(prefix)}-A7K2</code> · 인당 ${esc(money(Number(pane.querySelector("#lc-budget").value) || 1))} · 모델 <b>${esc(models.join(", ") || "선택 필요")}</b>`
        : "인원 N 을 넣으세요.";
    };
    for (const id of ["#lc-count", "#lc-prefix", "#lc-budget"]) pane.querySelector(id).addEventListener("input", this.updateCampPreview);
    pane.querySelector("#lc-models").addEventListener("change", this.updateCampPreview);
    this.updateCampPreview();
    pane.querySelector("#lc-go").addEventListener("click", (ev) => busy(ev.currentTarget, async () => {
      const count = Number(pane.querySelector("#lc-count").value);
      if (!Number.isInteger(count) || count < 1) { toast("인원 N 은 1 이상의 정수입니다", { tone: "warn" }); return; }
      const models = this.campPicker.read();
      if (!models.length) { toast("캠프 키는 저가 모델을 하나 이상 골라야 합니다", { tone: "warn" }); return; }
      const payload = {
        count,
        prefix: pane.querySelector("#lc-prefix").value,
        budget: pane.querySelector("#lc-budget").value,
        expires: todayYmd(),
        rpm_limit: pane.querySelector("#lc-rpm").value,
        models,
        provider_key_id: pane.querySelector("#lc-prov").value,
        schedule: this.campSched.read(),
      };
      if (team.value === "__new__") {
        const name = pane.querySelector("#lc-newname").value.trim();
        if (!name) { toast("새 학급 이름을 입력하세요", { tone: "warn" }); return; }
        payload.team = name;
      } else if (team.value) payload.team_id = team.value;
      try {
        const out = await this.ctx.api("/api/keys/camp", { method: "POST", body: payload });
        this.renderCampResult(out);
        await Promise.all([loadKeys(), loadTeams()]);
      } catch (e) { toastError(e, "캠프 키를 만들지 못했습니다"); }
    }));
    const revoke = (when) => async (ev) => {
      const today = when === "today";
      const ok = await confirmDialog({
        title: today ? "오늘 캠프 키 모두 차단" : "만료된 캠프 키 차단",
        message: today ? "오늘 발급한 캠프 키를 모두 막습니다. 학생은 곧바로 호출할 수 없습니다. 나중에 해제할 수 있습니다." : "어제 이전에 끝난 캠프 키를 막습니다. 학급 키는 건드리지 않습니다.",
        confirmLabel: "차단", tone: "warn",
      });
      if (!ok) return;
      await busy(ev.currentTarget, async () => {
        try {
          const out = await this.ctx.api("/api/keys/camp/revoke", { method: "POST", body: { action: "block", when } });
          const fail = out.results.filter((r) => r.error).length;
          pane.querySelector("#lc-rev-result").innerHTML = `<p class="help"><span class="tag good">${out.results.length - fail}개 처리</span> ${fail ? `<span class="tag crit">실패 ${fail}</span>` : ""} 필터 <code>${esc(out.filter || when)}</code></p>`;
          toast(`캠프 키 ${out.results.length - fail}개 차단`, { tone: fail ? "warn" : "good" });
          await loadKeys();
        } catch (e) { toastError(e, "캠프 키 차단 실패"); }
      });
    };
    pane.querySelector("#lc-rev-today").addEventListener("click", revoke("today"));
    pane.querySelector("#lc-rev-due").addEventListener("click", revoke("due"));
  },
  renderCampResult(out) {
    const rows = out.results || [];
    const okRows = rows.filter((r) => r.key);
    const bad = rows.filter((r) => r.error);
    const mapped = okRows.filter((r) => r.mapped).length;
    const model = (out.models || [])[0] || "gpt-4o-mini";
    const proxy = this.ctx.proxyUrl();
    toast(`캠프 키 ${okRows.length}개${bad.length ? ` · 실패 ${bad.length}` : ""}`, { tone: bad.length ? "warn" : "good", title: "캠프 키" });
    const box = $("#lc-result");
    box.innerHTML = `<section class="panel">
      <div class="panel-h"><span class="code">CAMP REPORT</span><h2>캠프 키 ${okRows.length}개 · ${esc(out.expires || "")} 당일 종료</h2>
        <span class="end">${bad.length ? `<span class="tag crit">실패 ${bad.length}</span>` : ""}${mapped ? `<span class="tag warn">장문 키 매핑 ${mapped}</span>` : ""}</span></div>
      <div class="callout warn">칠판에는 짧은 코드만 적으세요. 학생 코드의 <code>api_key</code> 는 ${mapped ? "아래 카드의 긴 키" : "짧은 코드 앞에 <code>sk-</code> 를 붙인 값"}입니다. 이 화면을 벗어나면 다시 볼 수 없습니다.</div>
      <div class="row" style="margin-bottom:12px">
        <button class="btn primary sm" type="button" id="cr-copy">${icon("copy")}짧은 코드 복사</button>
        <button class="btn sm" type="button" id="cr-copy-keys">${icon("copy")}API 키 복사</button>
        <button class="btn sm" type="button" id="cr-csv">${icon("down")}CSV</button>
        <button class="btn sm" type="button" id="cr-print">${icon("print")}코드 목록 인쇄</button>
        <button class="btn sm" type="button" id="cr-hand">${icon("print")}학생 안내문 인쇄</button>
      </div>
      <div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">
        ${okRows.map((r, i) => `<div class="card" style="gap:4px"><span class="muted" style="font-size:11px">${i + 1} / ${okRows.length}</span><span class="num" style="font-size:24px;font-weight:700;letter-spacing:.06em">${esc(r.code)}</span><code style="font-size:11px;word-break:break-all">${esc(r.key)}</code></div>`).join("")}
      </div>
      ${bad.length ? `<div class="tbl-wrap" style="margin-top:12px"><table class="tbl"><tbody>${bad.map((r) => `<tr class="bad"><td><code>${esc(r.code)}</code></td><td>${esc(r.error)}</td></tr>`).join("")}</tbody></table></div>` : ""}
    </section>`;
    box.querySelector("#cr-copy").onclick = async () => toast((await copyText(okRows.map((r) => r.code).join("\n"))) ? "짧은 코드를 복사했습니다" : "복사하지 못했습니다", { tone: "good" });
    box.querySelector("#cr-copy-keys").onclick = async () => toast((await copyText(okRows.map((r) => `${r.code}\t${r.key}`).join("\n"))) ? "코드와 API 키를 복사했습니다" : "복사하지 못했습니다", { tone: "good" });
    box.querySelector("#cr-csv").onclick = () => downloadText(`camp_keys_${out.expires || todayYmd()}.csv`, (out.print && out.print.csv) || toCsv(["no", "code", "api_key", "alias", "expires"], okRows.map((r, i) => [i + 1, r.code, r.key, r.alias || r.code, out.expires || ""])));
    box.querySelector("#cr-print").onclick = () => printCodes(okRows, out.expires || todayYmd());
    box.querySelector("#cr-hand").onclick = () => printHandouts(okRows.map((r) => ({ name: r.code, key: r.key, model, budget: out.max_budget, expires: `${out.expires} 23:59` })), { title: `AI 체험 캠프 키 안내 (${out.expires})`, proxyUrl: proxy });
    box.scrollIntoView({ block: "start", behavior: "smooth" });
  },

  // ---------------------------------------------------------------- 한 명
  buildSingle(pane) {
    pane.innerHTML = `
      <section class="panel" style="max-width:980px">
        <div class="panel-h"><span class="code">SINGLE</span><h2>키 한 개 발급</h2></div>
        <p class="help">교사 시연용이나 한 학생 추가용입니다. 여러 명은 <b>학급 일괄</b>, 명단 없는 캠프는 <b>캠프 짧은 키</b>를 쓰세요.</p>
        <div class="form-grid">
          <label class="field"><span>공급자 키 <span class="req">*</span></span><select id="ls-prov">${providerOptions()}</select></label>
          <label class="field"><span>별칭 <span class="req">*</span></span><input id="ls-alias" placeholder="예: 20261001-홍길동"></label>
          <label class="field"><span>소속 학급/조</span><select id="ls-team" data-teams=""></select></label>
          <label class="field"><span>예산 (USD) <span class="req">*</span></span><input id="ls-budget" type="number" min="0" step="0.5" value="2"></label>
          <label class="field"><span>예산 리셋</span><select id="ls-reset">${RESET_OPTIONS}</select><span class="hint">만든 시각부터 셈 · 달력 1일 아님</span></label>
          <label class="field"><span>키 만료</span><select id="ls-dur">${DURATION_OPTIONS}</select></label>
          <label class="field"><span>또는 만료일</span><input id="ls-expires" type="date" min="${todayYmd()}"></label>
          <label class="field"><span>분당 요청 (RPM)</span><input id="ls-rpm" type="number" min="1" placeholder="무제한"></label>
          <label class="field"><span>분당 토큰 (TPM)</span><input id="ls-tpm" type="number" min="1" placeholder="무제한"></label>
        </div>
        <div class="field" style="margin-top:12px"><span>허용 모델</span><div class="chips" id="ls-models"></div><span class="hint" id="ls-hint"></span></div>
        <div class="field" style="margin-top:12px"><span>사용 시간대</span><div id="ls-sched"></div><span class="hint">비우면 학급 시간표를 따릅니다.</span></div>
        <div style="margin-top:14px"><button class="btn primary" type="button" id="ls-go">${icon("launch")}발급</button></div>
      </section>`;
    const team = pane.querySelector("#ls-team");
    team.innerHTML = teamOptions();
    this.singlePicker = bindModelPicker({ select: pane.querySelector("#ls-prov"), box: pane.querySelector("#ls-models"), name: "ls-models", hint: pane.querySelector("#ls-hint") });
    this.singleSched = scheduleEditor(pane.querySelector("#ls-sched"), []);
    team.addEventListener("change", () => { if (team.value) this.syncFromTeam(team.value, this.singlePicker); });
    pane.querySelector("#ls-go").addEventListener("click", (ev) => busy(ev.currentTarget, async () => {
      const alias = pane.querySelector("#ls-alias").value.trim();
      if (!alias) { toast("별칭을 입력하세요", { tone: "warn" }); return; }
      const budget = pane.querySelector("#ls-budget").value;
      if (budget === "") { toast("예산을 입력하세요", { tone: "warn" }); return; }
      const models = this.singlePicker.read();
      if (!models.length) { toast("허용 모델을 하나 이상 고르세요", { tone: "warn" }); return; }
      try {
        const out = await this.ctx.api("/api/keys", {
          method: "POST",
          body: {
            alias, team_id: team.value, budget,
            budget_duration: pane.querySelector("#ls-reset").value,
            duration: pane.querySelector("#ls-dur").value,
            expires: pane.querySelector("#ls-expires").value,
            rpm_limit: pane.querySelector("#ls-rpm").value,
            tpm_limit: pane.querySelector("#ls-tpm").value,
            models,
            provider_key_id: pane.querySelector("#ls-prov").value,
            schedule: this.singleSched.read(),
          },
        });
        reveal({ title: `${alias} — 새 키`, secret: out.key, lines: [`모델 ${models.join(", ")}`, `예산 ${money(Number(budget))}`], snippet: snippetPython(this.ctx.proxyUrl(), models[0]) });
        pane.querySelector("#ls-alias").value = "";
        await loadKeys();
      } catch (e) { toastError(e, "발급하지 못했습니다"); }
    }));
  },
};
