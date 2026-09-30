// 08 기록. 실시간 호출 · 작업 기록 · 시스템 상태 · 학생 접속 안내.
import {
  $, $$, esc, icon, money, num, fmtDateTime, fmtTime, relTime, copyText, snippetPython, snippetJs, snippetCurl, toCsv, downloadText, todayYmd,
} from "../lib/util.js";
import { state, loadActivity, loadStatus } from "../lib/store.js";
import { toast, toastError, busy } from "../lib/ui.js";
import { teamOptions } from "../lib/forms.js";

const TABS = [["activity", "COMMS", "실시간 호출"], ["audit", "AUDIT", "작업 기록"], ["system", "SYSTEMS", "시스템 상태"], ["guide", "GUIDE", "학생 접속 안내"]];

export const ACTION_LABEL = {
  "key.issue": "키 발급", "key.update": "키 수정", "key.adjust": "키 충전·연장", "key.reissue": "폐기 후 새 키",
  "key.block": "키 차단", "key.unblock": "키 차단 해제", "key.delete": "키 삭제",
  "keys.bulk": "학급 일괄 발급", "keys.camp": "캠프 키 발급", "keys.camp.revoke": "캠프 키 회수",
  "keys.block": "일괄 차단", "keys.unblock": "일괄 해제", "keys.delete": "일괄 회수", "keys.adjust": "일괄 충전·연장",
  "team.create": "학급 생성", "team.update": "학급 수정", "team.delete": "학급 삭제", "team.lock": "학급 봉쇄", "team.unlock": "봉쇄 해제",
  "provider.create": "공급자 키 등록", "provider.update": "공급자 키 수정", "provider.delete": "공급자 키 삭제",
  "pool.create": "묶음 등록", "pool.delete": "묶음 삭제",
  "user.create": "사용자 등록", "user.update": "사용자 수정", "user.delete": "사용자 삭제",
  "assistant.config": "AI 엘피 설정",
};
const DETAIL_LABEL = {
  count: "개수", failed: "실패", budget: "예산", add_budget: "충전", add_days: "연장(일)", expires: "만료", models: "모델",
  team: "학급", team_id: "학급 id", reason: "사유", keys: "키", aliases: "대상", filter: "필터", action: "동작",
  retired_alias: "이전 별칭", schedule_keys: "시간표 반영 키", label: "이름", provider: "회사", secret_changed: "비밀 키 변경",
  members: "멤버", name: "이름", key_aliases: "연결 키", max_budget: "예산", rpm_limit: "RPM", tpm_limit: "TPM", duration: "기간",
  enabled: "켜짐", mode: "방식", model: "모델", server: "서버", mask_names: "이름 가림", allow_users: "학생 상담", proxy_key_created: "전용 키 새로 만듦",
};

function detailText(d) {
  if (!d || typeof d !== "object") return d ? String(d) : "";
  return Object.entries(d).filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && !v.length)).map(([k, v]) => {
    const val = Array.isArray(v) ? (v.length > 6 ? `${v.slice(0, 6).join(", ")} 외 ${v.length - 6}` : v.join(", ")) : typeof v === "boolean" ? (v ? "예" : "아니오") : String(v);
    if (k === "via") return "";
    return `${DETAIL_LABEL[k] || k} ${val}`;
  }).filter(Boolean).join(" · ");
}

export default {
  id: "log",
  deps: ["activity", "status", "teams"],
  init(root, ctx) {
    this.ctx = ctx;
    this.tab = "activity";
    root.innerHTML = `
      <div class="st-inner">
        <div class="st-head">
          <div class="ttl"><div class="code">STATION 08 · SHIP LOG</div><h1>기록 · 상태</h1>
            <p>막힌 호출의 이유, 누가 무엇을 바꿨는지, 프록시가 살아 있는지 여기서 봅니다. 학생 질문("왜 안 돼요?")에 바로 답할 수 있게 실패 이유를 한국어로 보여 줍니다.</p></div>
        </div>
        <div class="tabs" role="tablist">${TABS.map(([id, code, label]) => `<button class="tab" role="tab" type="button" data-tab="${id}" aria-selected="false"><span class="code">${code}</span>${label}</button>`).join("")}</div>
        <div data-pane="activity">
          <div class="tiles" id="lg-tiles"></div>
          <section class="panel" style="margin-top:14px">
            <div class="row" style="margin-bottom:10px">
              <div class="seg" role="group" aria-label="결과"><button type="button" data-res="" aria-pressed="true">전체</button><button type="button" data-res="ok" aria-pressed="false">성공</button><button type="button" data-res="fail" aria-pressed="false">실패</button></div>
              <select id="lg-team" style="width:auto" aria-label="학급"></select>
              <label class="search"><svg><use href="#i-cmd"/></svg><input id="lg-q" type="search" placeholder="별칭·모델·이유 검색"></label>
              <span style="flex:1"></span>
              <span class="muted" id="lg-at" style="font-size:12px"></span>
              <button class="btn sm ghost" type="button" id="lg-reload">${icon("refresh")}새로고침</button>
              <button class="btn sm" type="button" id="lg-csv">${icon("down")}CSV</button>
            </div>
            <div class="tbl-wrap" style="max-height:calc(100vh - 380px)"><table class="tbl"><thead><tr><th>시각</th><th>결과</th><th>별칭</th><th>학급</th><th>모델</th><th class="r">토큰</th><th class="r">금액</th><th class="r">소요</th><th>IP</th></tr></thead><tbody id="lg-rows"></tbody></table></div>
            <p class="help" style="margin:8px 0 0">최근 24시간 중 최신 60건을 10초마다 받아 옵니다. 프롬프트와 응답 내용은 저장하지도 보여 주지도 않습니다.</p>
          </section>
        </div>
        <div data-pane="audit" hidden>
          <section class="panel">
            <div class="row" style="margin-bottom:10px">
              <select id="au-kind" style="width:auto" aria-label="종류"><option value="">모든 작업</option><option value="key.">키 (한 개)</option><option value="keys.">일괄 작업</option><option value="team.">학급</option><option value="provider.">공급자 키</option><option value="pool.">묶음</option><option value="user.">사용자</option></select>
              <label class="search"><svg><use href="#i-cmd"/></svg><input id="au-q" type="search" placeholder="사람·대상·내용 검색"></label>
              <span style="flex:1"></span><span class="muted" id="au-total" style="font-size:12px"></span>
              <button class="btn sm ghost" type="button" id="au-reload">${icon("refresh")}새로고침</button>
            </div>
            <div class="tbl-wrap" style="max-height:calc(100vh - 300px)"><table class="tbl"><thead><tr><th>시각</th><th>누가</th><th>작업</th><th>대상</th><th>내용</th></tr></thead><tbody id="au-rows"></tbody></table></div>
            <p class="help" style="margin:8px 0 0">관리 작업은 <code>admin-ui/data/audit.jsonl</code> 에 최근 5000건까지 남습니다. 비밀 키 값은 남기지 않습니다.</p>
          </section>
        </div>
        <div data-pane="system" hidden><div class="grid g2" id="sy-body"></div></div>
        <div data-pane="guide" hidden><div id="gd-body"></div></div>
      </div>`;
    root.querySelector(".tabs").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-tab]");
      if (b) { this.show(b.dataset.tab); ctx.replaceParams({ tab: b.dataset.tab }); }
    });
    root.querySelector(".seg").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-res]");
      if (!b) return;
      for (const x of $$(".seg button", root)) x.setAttribute("aria-pressed", String(x === b));
      this.renderActivity();
    });
    root.querySelector("#lg-team").addEventListener("change", () => this.renderActivity());
    root.querySelector("#lg-q").addEventListener("input", () => this.renderActivity());
    root.querySelector("#lg-reload").addEventListener("click", (ev) => busy(ev.currentTarget, () => loadActivity().catch((e) => toastError(e))));
    root.querySelector("#lg-csv").addEventListener("click", () => {
      const rows = this.filteredActivity().map((it) => [it.at, it.ok ? "성공" : `실패: ${it.reason || ""}`, it.alias || "", it.team || "", it.model || "", it.tokens, it.spend, it.duration_ms ?? "", it.ip || ""]);
      downloadText(`calls_${todayYmd()}.csv`, toCsv(["시각", "결과", "별칭", "학급", "모델", "토큰", "금액(USD)", "소요(ms)", "IP"], rows));
    });
    root.querySelector("#lg-rows").addEventListener("click", (ev) => {
      const a = ev.target.closest("[data-token]");
      if (a && a.dataset.token) ctx.openKey(a.dataset.token);
    });
    root.querySelector("#au-kind").addEventListener("change", () => this.loadAudit());
    root.querySelector("#au-q").addEventListener("input", () => { clearTimeout(this.auT); this.auT = setTimeout(() => this.loadAudit(), 250); });
    root.querySelector("#au-reload").addEventListener("click", (ev) => busy(ev.currentTarget, () => this.loadAudit()));
  },
  show(tab) {
    this.tab = TABS.some(([id]) => id === tab) ? tab : "activity";
    for (const b of $$("#st-log .tab")) b.setAttribute("aria-selected", String(b.dataset.tab === this.tab));
    for (const p of $$("#st-log [data-pane]")) p.hidden = p.dataset.pane !== this.tab;
    if (this.tab === "audit") this.loadAudit();
    if (this.tab === "system") { this.renderSystem(); loadStatus().catch(() => {}); }
    if (this.tab === "guide") this.renderGuide();
    if (this.tab === "activity") this.renderActivity();
  },
  enter(params = {}) {
    const sel = $("#lg-team");
    const cur = sel.value;
    sel.innerHTML = teamOptions({ selected: cur, none: "전체 학급" });
    this.show(params.tab || this.tab);
  },
  refresh(ev) {
    if (ev === "teams") { const sel = $("#lg-team"); const cur = sel.value; sel.innerHTML = teamOptions({ selected: cur, none: "전체 학급" }); }
    if (this.tab === "activity") this.renderActivity();
    if (this.tab === "system") this.renderSystem();
  },

  filteredActivity() {
    const res = ($('#st-log .seg [aria-pressed="true"]') || {}).dataset?.res || "";
    const team = $("#lg-team").value;
    const q = $("#lg-q").value.trim().toLowerCase();
    return state.activity.items.filter((it) => {
      if (res === "ok" && !it.ok) return false;
      if (res === "fail" && it.ok) return false;
      if (team && it.team_id !== team) return false;
      if (q && !`${it.alias || ""} ${it.model || ""} ${it.reason || ""} ${it.error || ""} ${it.team || ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  },
  renderActivity() {
    const sum = state.activity.summary;
    const reasons = sum ? Object.entries(sum.by_reason || {}).sort((a, b) => b[1] - a[1]) : [];
    const topReason = reasons.length ? state.activity.items.find((it) => it.reason_code === reasons[0][0])?.reason : null;
    $("#lg-tiles").innerHTML = sum ? [
      `<div class="tile"><div class="k">최근 호출</div><div class="v">${num(sum.total)}</div><div class="s">최근 24시간 중 최신 ${num(sum.total)}건</div></div>`,
      `<div class="tile"><div class="k"><span class="led ${sum.failed ? "crit" : "good"}"></span>실패</div><div class="v">${num(sum.failed)}</div><div class="s">${sum.total ? Math.round((sum.failed / sum.total) * 100) : 0}%${topReason ? ` · 가장 많은 이유: ${esc(topReason)}` : ""}</div></div>`,
      `<div class="tile"><div class="k">호출한 키</div><div class="v">${num(sum.active_keys)}</div><div class="s">서로 다른 별칭</div></div>`,
      `<div class="tile"><div class="k">이 호출들의 금액</div><div class="v">${money(sum.spend)}</div><div class="s">토큰 ${num(sum.tokens)}</div></div>`,
    ].join("") : "";
    $("#lg-at").textContent = state.activity.at ? `갱신 ${fmtTime(state.activity.at)}` : "";
    const rows = this.filteredActivity();
    $("#lg-rows").innerHTML = rows.map((it) => `<tr class="${it.ok ? "" : "bad"}">
      <td class="nowrap"><span class="num">${esc(fmtTime(it.at))}</span> <span class="muted" style="font-size:11px">${esc(relTime(it.at))}</span></td>
      <td>${it.ok ? '<span class="state"><span class="led good"></span>성공</span>' : `<span class="tag crit" title="${esc(it.error || "")}">${esc(it.reason || "실패")}</span>`}</td>
      <td>${it.token ? `<span class="alias" data-token="${esc(it.token)}" role="button" tabindex="0">${esc(it.alias || "(별칭 없음)")}</span>` : esc(it.alias || "—")}</td>
      <td>${esc(it.team || "—")}</td>
      <td class="sec" style="font-size:12px">${esc(it.model || "")}</td>
      <td class="r num">${num(it.tokens)}</td>
      <td class="r num">${it.ok ? money(it.spend) : "—"}</td>
      <td class="r num muted">${it.duration_ms != null ? `${(it.duration_ms / 1000).toFixed(1)}s` : "—"}</td>
      <td class="num muted" style="font-size:11px">${esc(it.ip || "")}</td></tr>`).join("") || `<tr><td colspan="9" class="tbl-empty">${state.loaded.activity ? "조건에 맞는 호출이 없습니다." : "불러오는 중…"}</td></tr>`;
  },

  async loadAudit() {
    const kind = $("#au-kind").value;
    const q = $("#au-q").value.trim();
    try {
      const out = await this.ctx.api(`/api/audit?limit=300&action=${encodeURIComponent(kind)}&q=${encodeURIComponent(q)}`);
      $("#au-total").textContent = `보관 ${num(out.total)}건 중 ${num(out.entries.length)}건`;
      $("#au-rows").innerHTML = out.entries.map((e) => `<tr class="${e.ok ? "" : "bad"}">
        <td class="nowrap num">${esc(fmtDateTime(e.at))}</td>
        <td class="sec" style="font-size:12px">${esc(e.actor || "—")}</td>
        <td><span class="tag ${/delete|lock|block|revoke/.test(e.action) ? "warn" : "info"}">${esc(ACTION_LABEL[e.action] || e.action)}</span>${e.detail && e.detail.via === "elfy" ? ' <span class="tag violet" title="AI 엘피의 제안 카드로 실행">엘피 제안</span>' : ""}</td>
        <td>${esc(e.target || "—")}</td>
        <td class="sec" style="font-size:12px;max-width:520px">${esc(detailText(e.detail))}</td></tr>`).join("") || '<tr><td colspan="5" class="tbl-empty">아직 기록이 없습니다. 이 업데이트 뒤의 관리 작업부터 남습니다.</td></tr>';
    } catch (e) { toastError(e, "작업 기록을 불러오지 못했습니다"); }
  },

  renderSystem() {
    const s = state.status;
    const box = $("#sy-body");
    if (!s) { box.innerHTML = '<p class="muted">상태를 불러오는 중…</p>'; return; }
    const light = (ok, label, sub) => `<div class="vital-row" style="cursor:default"><span class="led ${ok === true ? "good" : ok === false ? "crit" : "warn"}"></span><span class="k">${esc(label)}</span><span class="v" style="font-size:13px">${esc(sub)}</span></div>`;
    const proxy = this.ctx.proxyUrl();
    box.innerHTML = `
      <section class="panel"><div class="panel-h"><span class="code">SYSTEMS</span><h2>구성 요소</h2><span class="end"><button class="btn xs" type="button" id="sy-reload">${icon("refresh")}다시 점검</button></span></div>
        <div class="vital-rows" style="margin-top:0">
          ${light(s.litellm.live, "프록시 (LiteLLM)", s.litellm.live ? `응답 ${s.litellm.latency_ms}ms` : s.litellm.error || "응답 없음")}
          ${light(s.litellm.db === "connected" ? true : s.litellm.live ? null : false, "데이터베이스 (Postgres)", s.litellm.db || "알 수 없음")}
          ${light(s.stores.users.ok, "사용자 명단 (users.json)", s.stores.users.ok ? `${num(s.stores.users.count)}명` : "손상")}
          ${light(s.stores.providers.ok, "공급자 키 (provider-keys.json)", s.stores.providers.ok ? `${num(s.stores.providers.count)}개` : "손상")}
          ${light(true, "작업 기록 (audit.jsonl)", `${num(s.stores.audit.count)}건`)}
          ${light(true, "관리 화면 (admin-ui)", `v${s.version} · 가동 ${Math.floor(s.uptime_s / 3600)}시간 ${Math.floor((s.uptime_s % 3600) / 60)}분`)}
        </div></section>
      <section class="panel"><div class="panel-h"><span class="code">PORTS</span><h2>포트와 화면</h2></div>
        <dl class="kv" style="font-size:13px">
          <dt>관리 화면</dt><dd><code>${esc(location.origin)}</code></dd>
          <dt>학생용 프록시 주소</dt><dd><code>${esc(proxy)}</code></dd>
        </dl>
        <div class="callout" style="margin-top:12px">
          <b>프록시 주소(${esc(String(s.proxy_port))}번 포트)를 브라우저로 열면</b> LiteLLM 이 자동으로 만든 API 문서(Swagger)가 보입니다. 학생 코드가 접속하는 엔진이라 <b>꺼서는 안 되지만, 화면에서 할 일은 없습니다.</b>
          그 주소 뒤의 <code>/ui</code> 는 LiteLLM 자체 관리 화면인데, 이 관리 화면이 대신하므로 기본으로 꺼 둡니다(<code>.env</code> 의 <code>LITELLM_DISABLE_ADMIN_UI</code>).
        </div>
      </section>`;
    box.querySelector("#sy-reload").onclick = (ev) => busy(ev.currentTarget, () => loadStatus().catch((e) => toastError(e)));
  },

  renderGuide() {
    const proxy = this.ctx.proxyUrl();
    const models = [...new Set([...(state.models || []), ...state.providers.flatMap((p) => (p.models || []).map((m) => m.call_name))])];
    const sel = this.guideModel && models.includes(this.guideModel) ? this.guideModel : (models.find((m) => /gpt-4o-mini$/.test(m)) || models[0] || "gpt-4o-mini");
    this.guideModel = sel;
    const lang = this.guideLang || "python";
    const code = lang === "js" ? snippetJs(proxy, sel) : lang === "curl" ? snippetCurl(proxy, sel) : snippetPython(proxy, sel);
    $("#gd-body").innerHTML = `
      <div class="grid g2">
        <section class="panel"><div class="panel-h"><span class="code">ACCESS</span><h2>접속 정보</h2></div>
          <dl class="kv" style="font-size:13px"><dt>base_url</dt><dd><code>${esc(proxy)}</code></dd><dt>API 키</dt><dd>발급받은 가상 키 (<code>sk-…</code>)</dd><dt>model</dt><dd><select id="gd-model" style="width:auto">${models.map((m) => `<option ${m === sel ? "selected" : ""}>${esc(m)}</option>`).join("")}</select></dd></dl>
          <p class="help" style="margin-top:12px">학생은 OpenAI SDK 코드에서 <code>base_url</code> 만 이 주소로 바꾸면 됩니다. 학교 밖에서는 접속되지 않습니다. 주소가 다르면 <b>설정 → 학생 안내 주소</b>에서 바꾸세요.</p>
          <p class="help"><b>자주 묻는 오류</b><br>· 수업 시간대 밖 — 학급 시간표 밖 호출입니다.<br>· 예산 초과 — 키 예산을 다 썼습니다. 선생님께 충전을 요청하세요.<br>· 허용 안 된 모델 — model 이름을 위 목록에서 고르세요.<br>· 잘못된 키 — 키를 다시 복사하세요. 앞뒤 공백을 확인하세요.</p>
        </section>
        <section class="panel"><div class="panel-h"><span class="code">SNIPPET</span><h2>예제 코드</h2><span class="end"><div class="seg" id="gd-lang"><button type="button" data-lang="python" aria-pressed="${lang === "python"}">Python</button><button type="button" data-lang="js" aria-pressed="${lang === "js"}">JavaScript</button><button type="button" data-lang="curl" aria-pressed="${lang === "curl"}">curl</button></div></span></div>
          <div class="snippet"><pre>${esc(code)}</pre><button class="btn xs" type="button" id="gd-copy">${icon("copy")}복사</button></div>
          <div class="row" style="margin-top:12px"><button class="btn sm" type="button" id="gd-print">${icon("print")}안내문 인쇄 (키 칸 비움)</button></div>
        </section>
      </div>`;
    $("#gd-model").onchange = (ev) => { this.guideModel = ev.target.value; this.renderGuide(); };
    $("#gd-lang").onclick = (ev) => { const b = ev.target.closest("[data-lang]"); if (b) { this.guideLang = b.dataset.lang; this.renderGuide(); } };
    $("#gd-copy").onclick = async () => toast((await copyText(code)) ? "예제 코드를 복사했습니다" : "복사하지 못했습니다", { tone: "good" });
    $("#gd-print").onclick = () => {
      $("#print-root").innerHTML = `<div class="p-sheet"><h1>AI API 접속 안내</h1><p>접속 주소 <b>${esc(proxy)}</b> · 모델 <b>${esc(sel)}</b> · 키는 선생님께 받은 값을 넣으세요.</p><pre style="font-size:10pt;background:#f4f4f4;padding:10pt">${esc(snippetPython(proxy, sel))}</pre><pre style="font-size:10pt;background:#f4f4f4;padding:10pt">${esc(snippetJs(proxy, sel))}</pre></div>`;
      window.print();
    };
  },
};
