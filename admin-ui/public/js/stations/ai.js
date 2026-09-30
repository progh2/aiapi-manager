// 09 AI 엘피. 언어 모델 연결(Ollama·OpenAI·호환 서버·이 프록시), 엘피의 행동, 목소리·효과음을 정한다.
import { $, $$, esc, icon, num, relTime, fmtDateTime } from "../lib/util.js";
import { toast, toastError, busy } from "../lib/ui.js";
import { holoImage } from "../lib/holo.js";
import * as sfx from "../lib/sfx.js";

const KINDS = [
  { id: "ollama", label: "Ollama (로컬 LLM)", sub: "학교 PC·Mac 에서 돌리는 무료 모델" },
  { id: "openai", label: "ChatGPT (OpenAI API)", sub: "API 키로 OpenAI 모델 사용" },
  { id: "compatible", label: "OpenAI 호환 서버", sub: "LM Studio·vLLM·llama.cpp 등" },
  { id: "proxy", label: "이 프록시의 모델", sub: "이미 등록한 공급자 키를 그대로 사용" },
];
const GRADE_TAG = { 3: "good", 2: "info", 1: "warn", 0: "crit" };
const SOUND_TESTS = [["nav", "전환"], ["open", "창"], ["ok", "성공"], ["warn", "주의"], ["alarm", "경보"], ["elfy", "엘피"], ["proposal", "제안"]];

const kindOf = (cfg) => (cfg.mode === "proxy" ? "proxy" : cfg.provider || "ollama");
const tokensText = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}백만` : n >= 1e4 ? `${Math.round(n / 1e3)}천` : num(n));

export default {
  id: "ai",
  deps: ["status"],
  init(root, ctx) {
    this.ctx = ctx;
    this.cfg = null;
    this.kind = "ollama";
    this.models = [];
    this.model = "";
    root.innerHTML = `
      <div class="st-inner">
        <div class="st-head">
          <div class="ttl"><div class="code">STATION 09 · AI CORE</div><h1>AI 엘피</h1>
            <p>엘피가 쓸 언어 모델을 연결합니다. 상황 요약·실패 원인 분석·조치 제안을 하고, 바꾸는 작업은 선생님이 카드의 [실행]을 눌러야 진행됩니다.</p></div>
          <div class="tools"><button class="btn primary" type="button" id="ai-talk">${icon("elfy")}엘피와 대화 <span class="kbd">E</span></button></div>
        </div>
        <div class="ai-grid">
          <section class="panel ai-core" aria-label="엘피 상태">
            <div class="panel-h"><span class="code">CORE STATUS</span><h2>엘피 상태</h2></div>
            <div class="ai-orb" id="ai-orb"><span class="rings"><i></i><i></i><i></i></span><img alt="" src="${holoImage("welcome")}"></div>
            <div class="vital-rows" id="ai-state"></div>
            <div id="ai-test-box" class="ai-test"></div>
            <div class="ai-usage" id="ai-usage"></div>
          </section>
          <section class="panel ai-conn" aria-label="모델 연결">
            <div class="panel-h"><span class="code">NEURAL LINK</span><h2>모델 연결</h2>
              <span class="end"><label class="switch"><input type="checkbox" id="ai-enabled"><span class="sl"></span><b>엘피 켜기</b></label></span></div>
            <div class="ai-kinds" id="ai-kinds" role="radiogroup" aria-label="연결 방식">
              ${KINDS.map((k) => `<button type="button" class="ai-kind" role="radio" aria-checked="false" data-kind="${k.id}"><b>${esc(k.label)}</b><small>${esc(k.sub)}</small></button>`).join("")}
            </div>
            <div id="ai-fields" class="form-grid" style="margin-top:14px"></div>
            <div class="row" style="margin-top:14px">
              <button class="btn" type="button" id="ai-load">${icon("refresh")}모델 불러오기</button>
              <span class="muted" style="font-size:12px" id="ai-load-note"></span>
            </div>
            <div class="ai-models" id="ai-models" role="radiogroup" aria-label="모델"></div>
            <label class="field" style="margin-top:10px"><span>모델 이름 <span class="hint">목록에 없으면 직접 적으세요 (예: qwen3:8b, gpt-4.1-mini)</span></span><input id="ai-model" autocomplete="off" spellcheck="false"></label>
            <div class="row" style="margin-top:14px;justify-content:flex-end">
              <button class="btn" type="button" id="ai-test">${icon("bolt")}연결 시험</button>
              <button class="btn primary" type="button" id="ai-save">저장</button>
            </div>
          </section>
          <div class="ai-side">
          <section class="panel ai-behave" aria-label="엘피 행동">
            <div class="panel-h"><span class="code">PROTOCOLS</span><h2>행동 규칙</h2></div>
            <div class="stack" style="gap:12px">
              <label class="check"><input type="checkbox" id="ai-mask"> 외부 서비스(OpenAI 등)로 보낼 때 학생 이름 가리기</label>
              <p class="help" id="ai-mask-note" style="margin:-6px 0 0 24px"></p>
              <label class="check"><input type="checkbox" id="ai-users"> 등록 사용자(학생)도 엘피에게 물어볼 수 있게</label>
              <p class="help" style="margin:-6px 0 0 24px">학생은 자기 키 정보만 보고, 충전·해제 같은 제안은 받지 못합니다. 한 사람당 시간당 20번까지.</p>
              <label class="check"><input type="checkbox" id="ai-fast"> 빠른 응답 (생각을 끌 수 있는 모델은 끄고 묻기)</label>
              <p class="help" style="margin:-6px 0 0 24px">생각만 하는 모델(예: Qwen3 Thinking)은 알아서 생각을 켠 채로 묻습니다. 답이 자주 틀리면 끄세요.</p>
              <div class="form-grid">
                <label class="field"><span>이번 달 토큰 상한</span><select id="ai-cap">
                  <option value="0">제한 없음</option><option value="500000">50만</option><option value="1000000">100만</option><option value="3000000">300만</option><option value="10000000">1,000만</option><option value="30000000">3,000만</option></select></label>
                <label class="field"><span>답변 길이</span><select id="ai-len"><option value="400">짧게</option><option value="700">보통</option><option value="1200">길게</option></select></label>
                <label class="field"><span>문맥 길이 <span class="hint">Ollama</span></span><select id="ai-ctx"><option value="8192">8K (가벼움)</option><option value="16384">16K (권장)</option><option value="32768">32K</option></select></label>
              </div>
              <div class="row" style="justify-content:flex-end"><button class="btn primary" type="button" id="ai-save-behave">규칙 저장</button></div>
            </div>
          </section>
          <section class="panel ai-sense" aria-label="목소리와 효과음">
            <div class="panel-h"><span class="code">SENSES</span><h2>목소리·효과음</h2><span class="sub">이 브라우저에만 저장</span></div>
            <div class="stack" style="gap:12px">
              <label class="check"><input type="checkbox" id="sx-on"> 효과음 <span class="kbd">M</span></label>
              <label class="field"><span>음량</span><input type="range" id="sx-vol" min="0" max="1" step="0.05"></label>
              <div class="chips" id="sx-tests">${SOUND_TESTS.map(([id, lb]) => `<button class="chip" type="button" data-sfx="${id}">${icon("volume")}${esc(lb)}</button>`).join("")}</div>
              <label class="check"><input type="checkbox" id="sx-ping"> 학생 호출이 들어올 때 작은 핑 소리</label>
              <label class="check"><input type="checkbox" id="sx-proactive"> 엘피가 먼저 알려 주기 (경보·화면 도움말 말풍선)</label>
              <label class="check"><input type="checkbox" id="sx-voice"> 엘피 답을 목소리로 읽기</label>
              <div class="row"><select id="sx-voice-name" style="flex:1;min-width:0"></select><button class="btn sm" type="button" id="sx-voice-test">${icon("volume")}들어 보기</button></div>
            </div>
          </section>
          </div>
          <section class="panel ai-guide" aria-label="모델 고르는 법">
            <div class="panel-h"><span class="code">FIELD GUIDE</span><h2>어떤 모델이 필요할까요?</h2></div>
            <div class="tbl-wrap" style="max-height:none"><table class="tbl">
              <thead><tr><th>엘피가 할 일</th><th>ChatGPT (OpenAI)</th><th>Ollama (로컬)</th><th>필요한 컴퓨터</th></tr></thead>
              <tbody>
                <tr><td>상황 요약·상담만</td><td>gpt-4o-mini · gpt-5-nano</td><td>gemma4:e2b · qwen3:4b · llama3.2:3b</td><td>GPU 없어도 됨(느림), 메모리 16GB</td></tr>
                <tr><td><b>권장</b> · 조회·원인 분석·충전/차단 제안</td><td><b>gpt-4.1-mini · gpt-5-mini</b></td><td><b>qwen3:8b · gemma4 (8B)</b></td><td>GPU 8GB 이상 또는 Apple M 칩 16GB 이상</td></tr>
                <tr><td>여러 단계 요청도 안정적으로</td><td>gpt-4.1 · gpt-5</td><td>qwen3:30b · qwen3.5:27b · gpt-oss:20b</td><td>GPU 16~24GB 또는 Apple M 칩 32GB 이상</td></tr>
              </tbody></table></div>
            <ul class="ai-notes">
              <li>충전·차단을 <b>제안</b>하려면 "도구 호출(tool calling)"을 지원하는 모델이어야 해요. 모델 목록의 <span class="tag good">도구 ✓</span> 표시를 보세요.</li>
              <li>시놀로지 NAS(DS918+)에서는 LLM 을 돌릴 수 없어요. 교사용 PC(GPU)나 Mac 에 <a href="https://ollama.com/download" target="_blank" rel="noopener">Ollama</a> 를 깔고 네트워크에 열어 주세요.
                <br>Mac: Ollama 설정 → <b>Expose Ollama to the network</b> · Windows/Linux: 환경 변수 <code>OLLAMA_HOST=0.0.0.0</code> 후 다시 시작 · 방화벽 11434 포트 허용</li>
              <li>질문 한 번에 보통 입력 3천~1만 토큰, 출력 수백 토큰을 씁니다. OpenAI mini 급 모델이면 한 번에 1센트가 채 안 됩니다. 이번 달 사용량은 왼쪽 상태판에서 확인하세요.</li>
              <li>학생 이름 가리기를 켜면 외부로 보낼 때 "학생07" 같은 가명으로 바꾸고, 화면에는 원래 이름으로 보여 줍니다. 로컬 Ollama 는 학교 밖으로 나가지 않아 가리지 않아요.</li>
            </ul>
          </section>
        </div>
      </div>`;

    $("#ai-talk").onclick = () => ctx.elfy && ctx.elfy.open();
    $("#ai-kinds").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-kind]");
      if (b) this.setKind(b.dataset.kind);
    });
    $("#ai-models").addEventListener("change", (ev) => {
      if (ev.target.name === "ai-model") this.pickModel(ev.target.value);
    });
    $("#ai-model").addEventListener("input", (ev) => { this.model = ev.target.value.trim(); this.paintModels(); });
    $("#ai-load").onclick = (ev) => busy(ev.currentTarget, () => this.loadModels());
    $("#ai-test").onclick = (ev) => busy(ev.currentTarget, () => this.test());
    $("#ai-save").onclick = (ev) => busy(ev.currentTarget, () => this.saveConn());
    $("#ai-save-behave").onclick = (ev) => busy(ev.currentTarget, () => this.saveBehave());
    this.bindSenses();
  },

  enter() { this.load(); },
  refresh() {},

  async load() {
    try {
      this.cfg = await this.ctx.api("/api/assistant/config");
    } catch (e) {
      toastError(e, "엘피 설정을 불러오지 못했습니다");
      return;
    }
    const c = this.cfg;
    this.kind = kindOf(c);
    this.model = c.mode === "proxy" ? c.proxy_model : c.model;
    this.models = [];
    $("#ai-enabled").checked = Boolean(c.enabled);
    $("#ai-mask").checked = c.mask_names !== false;
    $("#ai-users").checked = Boolean(c.allow_users);
    $("#ai-fast").checked = c.fast_mode !== false;
    $("#ai-cap").value = String(c.monthly_token_cap ?? 3000000);
    if (!$("#ai-cap").value) $("#ai-cap").value = "3000000";
    $("#ai-len").value = String(c.max_output_tokens || 700);
    if (!$("#ai-len").value) $("#ai-len").value = "700";
    $("#ai-ctx").value = String(c.num_ctx || 8192);
    if (!$("#ai-ctx").value) $("#ai-ctx").value = "8192";
    this.setKind(this.kind, { keepModel: true });
    this.paintState();
  },

  // ---------------------------------------------------------------- 연결 방식
  setKind(kind, { keepModel = false } = {}) {
    const c = this.cfg || {};
    const changed = kind !== this.kind;
    this.kind = kind;
    for (const b of $$("#ai-kinds [data-kind]")) b.setAttribute("aria-checked", String(b.dataset.kind === kind));
    if (changed && !keepModel) {
      this.models = [];
      this.model = kind === kindOf(c) ? (kind === "proxy" ? c.proxy_model : c.model) : "";
    }
    const sameProvider = kind === kindOf(c);
    const keyHint = sameProvider && c.has_api_key ? `저장됨 ${esc(c.api_key_hint)} · 바꿀 때만 적으세요` : "";
    const fields = {
      ollama: `
        <label class="field" style="grid-column:1/-1"><span>Ollama 주소 <span class="req">*</span> <span class="hint">예: http://192.168.0.20:11434</span></span>
          <input id="ai-base" autocomplete="off" spellcheck="false" placeholder="http://192.168.0.20:11434" value="${esc(sameProvider ? c.base_url || "" : "")}"></label>
        <p class="help" style="grid-column:1/-1;margin:0">Ollama 를 켠 컴퓨터가 네트워크 연결을 받아야 해요. Mac 은 Ollama 설정의 <b>Expose Ollama to the network</b>, Windows·Linux 는 <code>OLLAMA_HOST=0.0.0.0</code>.</p>`,
      openai: `
        <label class="field" style="grid-column:1/-1"><span>OpenAI API 키 <span class="req">*</span> ${keyHint ? `<span class="hint">${keyHint}</span>` : ""}</span>
          <input id="ai-key" type="password" autocomplete="off" spellcheck="false" placeholder="${keyHint ? "••••••••" : "sk-..."}"></label>
        <p class="help" style="grid-column:1/-1;margin:0">OpenAI 사이트의 프로젝트에 월 한도를 꼭 걸어 두세요. 이 키는 관리 서버에만 저장되고 화면으로 다시 나오지 않아요.${sameProvider && c.has_api_key ? ` <button class="btn xs ghost" type="button" id="ai-key-clear">저장된 키 지우기</button>` : ""}</p>`,
      compatible: `
        <label class="field"><span>서버 주소 <span class="req">*</span> <span class="hint">/v1 까지</span></span>
          <input id="ai-base" autocomplete="off" spellcheck="false" placeholder="http://192.168.0.20:1234/v1" value="${esc(sameProvider ? c.base_url || "" : "")}"></label>
        <label class="field"><span>API 키 <span class="hint">${keyHint || "없으면 비워 두세요"}</span></span>
          <input id="ai-key" type="password" autocomplete="off" spellcheck="false"></label>`,
      proxy: `
        <label class="field"><span>엘피 전용 키 월 예산 (USD)</span>
          <input id="ai-budget" type="number" min="0.5" max="500" step="0.5" value="${esc(String(c.proxy_budget ?? 5))}"></label>
        <p class="help" style="grid-column:1/-1;margin:0">LiteLLM 에 <code>${esc(c.proxy_key_alias || "aiapi-assistant")}</code> 가상 키를 만들어 이 예산을 겁니다. 엘피 사용액이 사용량 화면에 함께 잡혀요.${c.has_proxy_key ? ` 지금 키: ${esc(c.proxy_key_hint)}` : ""}</p>`,
    };
    $("#ai-fields").innerHTML = fields[kind];
    const clear = $("#ai-key-clear");
    if (clear) clear.onclick = () => busy(clear, async () => {
      this.cfg = await this.ctx.api("/api/assistant/config", { method: "POST", body: { clear_api_key: true } });
      toast("저장된 API 키를 지웠습니다", { tone: "good" });
      this.setKind(this.kind, { keepModel: true });
      this.paintState();
    });
    $("#ai-load-note").textContent = kind === "proxy" ? "LiteLLM 에 등록된 모델을 불러옵니다" : "";
    $("#ai-model").value = this.model || "";
    this.paintModels();
  },

  draftBody() {
    const body = { mode: this.kind === "proxy" ? "proxy" : "direct" };
    if (this.kind !== "proxy") body.provider = this.kind;
    const base = $("#ai-base");
    if (base) body.base_url = base.value.trim();
    const key = $("#ai-key");
    if (key && key.value.trim()) body.api_key = key.value.trim();
    if (this.kind === "proxy") {
      body.proxy_model = this.model;
      const bud = $("#ai-budget");
      if (bud && bud.value) body.proxy_budget = Number(bud.value);
    } else body.model = this.model;
    return body;
  },

  // ---------------------------------------------------------------- 모델
  async loadModels() {
    const body = this.draftBody();
    const box = $("#ai-models");
    box.innerHTML = '<p class="muted" style="margin:10px 0 0">모델 목록을 받는 중…</p>';
    try {
      const out = await this.ctx.api("/api/assistant/models", { method: "POST", body });
      this.models = out.models || [];
      if (!this.model && this.models[0]) this.model = this.models[0].id;
      $("#ai-model").value = this.model || "";
      this.paintModels();
      sfx.play("ok");
      $("#ai-load-note").textContent = `${this.models.length}개 · 추천 순서로 정렬`;
    } catch (e) {
      box.innerHTML = `<div class="callout crit" style="margin:10px 0 0">${esc(e.message)}</div>`;
      sfx.play("error");
    }
  },

  pickModel(id) {
    this.model = id;
    $("#ai-model").value = id;
    this.paintModels();
    sfx.play("click");
  },

  paintModels() {
    const box = $("#ai-models");
    if (!this.models.length) {
      if (!box.querySelector(".callout")) box.innerHTML = "";
      return;
    }
    box.innerHTML = this.models.map((m) => {
      const bits = [m.params, m.quant, m.size_gb ? `${m.size_gb}GB` : ""].filter(Boolean).join(" · ");
      const tools = m.tools === true ? '<span class="tag good">도구 ✓</span>' : m.tools === false ? '<span class="tag crit">도구 ✗</span>' : "";
      const think = m.thinking ? '<span class="tag violet">생각</span>' : "";
      return `<label class="ai-model ${m.id === this.model ? "sel" : ""}" data-grade="${m.grade ?? 2}">
        <input type="radio" name="ai-model" value="${esc(m.id)}" ${m.id === this.model ? "checked" : ""}>
        <span class="mo-h"><b>${esc(m.id)}</b>${m.badge ? `<span class="tag ${GRADE_TAG[m.grade] || "info"}">${esc(m.badge)}</span>` : ""}${tools}${think}</span>
        <span class="mo-s">${esc([bits, m.note].filter(Boolean).join(" — "))}</span></label>`;
    }).join("");
  },

  // ---------------------------------------------------------------- 시험·저장
  async test() {
    const body = this.draftBody();
    if (!(body.model || body.proxy_model)) { toast("모델을 먼저 고르세요", { tone: "warn" }); return; }
    const box = $("#ai-test-box");
    box.className = "ai-test run";
    box.innerHTML = `<span class="dots"><i></i><i></i><i></i></span> ${esc(body.model || body.proxy_model)} 에게 말을 거는 중… (처음엔 모델을 불러오느라 수십 초 걸릴 수 있어요)`;
    $("#ai-orb").dataset.state = "thinking";
    try {
      const out = await this.ctx.api("/api/assistant/test", { method: "POST", body });
      box.className = `ai-test ${out.tools_ok ? "ok" : "warn"}`;
      box.innerHTML = `<div class="t">${icon(out.tools_ok ? "bolt" : "ban")} ${out.tools_ok ? "연결됨 · 도구 호출 가능" : "연결됨 · 도구 호출 불안정"} <span class="muted">${(out.latency_ms / 1000).toFixed(1)}초</span></div>
        <div class="q">“${esc(out.reply || "")}”</div>${out.note ? `<div class="n">${esc(out.note)}</div>` : ""}`;
      sfx.play(out.tools_ok ? "elfy" : "warn");
      $("#ai-orb").dataset.state = out.tools_ok ? "done" : "idle";
    } catch (e) {
      box.className = "ai-test bad";
      box.innerHTML = `<div class="t">${icon("ban")} 연결 실패</div><div class="n">${esc(e.message)}</div>`;
      sfx.play("error");
      $("#ai-orb").dataset.state = "off";
    }
    await this.refreshCfg();
  },

  async saveConn() {
    const body = { ...this.draftBody(), enabled: $("#ai-enabled").checked };
    if (body.enabled && !(body.model || body.proxy_model)) { toast("켜려면 모델을 고르세요", { tone: "warn" }); return; }
    try {
      this.cfg = await this.ctx.api("/api/assistant/config", { method: "POST", body });
      toast(body.enabled ? "엘피 연결을 저장했습니다" : "엘피를 껐습니다", { tone: "good" });
      const key = $("#ai-key");
      if (key) key.value = "";
      this.setKind(kindOf(this.cfg), { keepModel: true });
      this.paintState();
      if (this.ctx.elfy) this.ctx.elfy.refreshConfig();
    } catch (e) { toastError(e, "저장하지 못했습니다"); }
  },

  async saveBehave() {
    const body = {
      mask_names: $("#ai-mask").checked,
      allow_users: $("#ai-users").checked,
      fast_mode: $("#ai-fast").checked,
      monthly_token_cap: Number($("#ai-cap").value),
      max_output_tokens: Number($("#ai-len").value),
      num_ctx: Number($("#ai-ctx").value),
    };
    try {
      this.cfg = await this.ctx.api("/api/assistant/config", { method: "POST", body });
      toast("엘피 행동 규칙을 저장했습니다", { tone: "good" });
      this.paintState();
      if (this.ctx.elfy) this.ctx.elfy.refreshConfig();
    } catch (e) { toastError(e, "저장하지 못했습니다"); }
  },

  async refreshCfg() {
    try { this.cfg = await this.ctx.api("/api/assistant/config"); this.paintState(); } catch { /* 다음에 */ }
  },

  paintState() {
    const c = this.cfg;
    if (!c) return;
    const row = (led, k, v) => `<div class="vital-row" style="cursor:default"><span class="led ${led}"></span><span class="k">${esc(k)}</span><span class="v" style="font-size:13px">${v}</span></div>`;
    const kind = KINDS.find((k) => k.id === kindOf(c));
    const model = c.mode === "proxy" ? c.proxy_model : c.model;
    let where = kind ? kind.label : "—";
    if (c.mode !== "proxy" && c.base_url) where += ` · ${esc(c.base_url.replace(/^https?:\/\//, ""))}`;
    const t = c.last_test;
    $("#ai-state").innerHTML = [
      row(c.ready ? "good" : c.enabled ? "warn" : "off", "상태", c.ready ? "가동 중" : c.enabled ? "연결 정보가 덜 됐어요" : "꺼짐"),
      row("info", "연결", esc(where)),
      row(model ? "info" : "off", "모델", model ? `<code>${esc(model)}</code>` : "고르지 않음"),
      row(t ? (t.ok ? (t.tools_ok ? "good" : "warn") : "crit") : "off", "마지막 시험", t ? `${t.ok ? (t.tools_ok ? "도구 호출 가능" : "대화만 가능") : "실패"}${t.latency_ms ? ` · ${(t.latency_ms / 1000).toFixed(1)}초` : ""} · ${esc(relTime(t.at))}` : "아직 안 함"),
      row(c.external ? (c.mask_names ? "good" : "warn") : "good", "개인정보", c.external ? (c.mask_names ? "외부로 보낼 때 이름을 가림" : "이름을 가리지 않고 외부로 보냄") : "학교 안에서 처리"),
      row(c.allow_users ? "info" : "off", "학생 상담", c.allow_users ? "켜짐" : "꺼짐"),
    ].join("");
    $("#ai-mask-note").textContent = c.external
      ? "지금 연결은 학교 밖(외부 서비스)으로 나갑니다. 켜 두기를 권해요."
      : "지금 연결은 학교 안 서버라 이름을 가리지 않아도 돼요.";
    const u = c.usage || { prompt_tokens: 0, completion_tokens: 0, requests: 0 };
    const used = (u.prompt_tokens || 0) + (u.completion_tokens || 0);
    const cap = Number(c.monthly_token_cap) || 0;
    const ratio = cap ? Math.min(1, used / cap) : 0;
    $("#ai-usage").innerHTML = `<div class="k">이번 달 (${esc(u.month || "")}) · 질문 ${num(u.requests || 0)}번 · 토큰 ${tokensText(used)}${cap ? ` / ${tokensText(cap)}` : ""}</div>
      ${cap ? `<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(ratio * 100)}"><i class="${ratio >= 1 ? "crit" : ratio >= 0.8 ? "warn" : ""}" style="width:${(ratio * 100).toFixed(1)}%"></i></div>` : ""}`;
    $("#ai-orb").dataset.state = c.ready ? "idle" : "off";
    const box = $("#ai-test-box");
    if (!box.className.includes("run") && !box.innerHTML && t && !t.ok) {
      box.className = "ai-test bad";
      box.innerHTML = `<div class="t">${icon("ban")} 마지막 시험 실패 · ${esc(fmtDateTime(t.at))}</div><div class="n">${esc(t.error || "")}</div>`;
    }
  },

  // ---------------------------------------------------------------- 목소리·효과음 (이 브라우저)
  bindSenses() {
    const s = this.ctx.settings;
    const save = () => { this.ctx.saveSettings(); this.ctx.applySound(); };
    const on = $("#sx-on");
    const vol = $("#sx-vol");
    on.checked = s.sound !== false;
    vol.value = String(s.volume ?? 0.5);
    on.onchange = () => { s.sound = on.checked; save(); if (on.checked) sfx.play("ok"); };
    vol.oninput = () => { s.volume = Number(vol.value); save(); };
    vol.onchange = () => sfx.play("click", { force: true });
    $("#sx-tests").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-sfx]");
      if (b) sfx.play(b.dataset.sfx, { force: true });
    });
    const ping = $("#sx-ping");
    ping.checked = Boolean(s.sfxTraffic);
    ping.onchange = () => { s.sfxTraffic = ping.checked; save(); };
    const pro = $("#sx-proactive");
    pro.checked = s.proactive !== false;
    pro.onchange = () => { s.proactive = pro.checked; save(); };
    const voice = $("#sx-voice");
    voice.checked = Boolean(s.voice);
    voice.onchange = () => { s.voice = voice.checked; save(); };
    const pick = $("#sx-voice-name");
    const fill = () => {
      const list = "speechSynthesis" in window ? speechSynthesis.getVoices() : [];
      const ko = list.filter((v) => /^ko/i.test(v.lang));
      const use = ko.length ? ko : list;
      pick.innerHTML = use.length
        ? use.map((v) => `<option value="${esc(v.name)}">${esc(v.name)} (${esc(v.lang)})</option>`).join("")
        : '<option value="">이 브라우저에 한국어 목소리가 없어요</option>';
      if (s.voiceName && use.some((v) => v.name === s.voiceName)) pick.value = s.voiceName;
    };
    fill();
    if ("speechSynthesis" in window) speechSynthesis.addEventListener("voiceschanged", fill);
    pick.onchange = () => { s.voiceName = pick.value; save(); };
    $("#sx-voice-test").onclick = () => {
      if (!("speechSynthesis" in window)) { toast("이 브라우저는 목소리 읽기를 지원하지 않습니다", { tone: "warn" }); return; }
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance("안녕하세요, AI 엘피예요. 오늘도 수업 운영을 도와드릴게요!");
      u.lang = "ko-KR";
      u.rate = 1.05;
      u.pitch = 1.2;
      const v = speechSynthesis.getVoices().find((x) => x.name === pick.value);
      if (v) u.voice = v;
      speechSynthesis.speak(u);
    };
  },
};
