// AI 엘피 대화창. 하단 오른쪽 홀로그램을 누르거나 E 를 누르면 열린다.
// 질문 → 서버가 모델과 도구를 돌리며 진행 상황을 보내고 → 답과 제안 카드를 그린다.
// 제안 카드의 [실행]을 눌러야 기존 관리 API 가 불린다. 엘피가 직접 바꾸는 길은 없다.
import { $, esc, icon, prefersReducedMotion } from "./util.js";
import { holoImage, STATION_LINES } from "./holo.js";
import * as sfx from "./sfx.js";
import { toast, confirmDialog } from "./ui.js";

const HISTORY_KEY = "aiapi.elfy.history";
const SEEN_KEY = "aiapi.elfy.seen";
// 제안 카드가 부를 수 있는 관리 API. 서버가 만든 카드라도 여기 없는 주소는 부르지 않는다.
const ALLOWED = new Set(["/api/keys/adjust/bulk", "/api/keys/revoke", "/api/teams/lockdown", "/api/teams/update"]);

const CHIPS = {
  bridge: ["지금 상황 브리핑해 줘", "오늘 가장 먼저 챙길 일은?", "최근 실패 원인 요약해 줘"],
  telemetry: ["이번 달 사용량 예측해 줘", "가장 많이 쓴 학급은?", "예산이 먼저 바닥날 학급은?"],
  keys: ["예산 소진된 키 보여줘", "7일 안에 만료되는 키는?", "소진된 키에 1달러씩 충전해 줘"],
  classes: ["학급별 예산 상황 알려줘", "지금 수업 중인 학급은?", "시험 때 학급을 막으려면?"],
  launch: ["캠프 키는 어떻게 만들어?", "명단 일괄 발급 방법 알려줘", "새 학급 예산은 얼마가 좋을까?"],
  engines: ["공급자 잔액 확인해 줘", "공급자 한도는 왜 걸어야 해?"],
  crew: ["학생 계정은 어떻게 연결해?", "등록 사용자는 뭘 볼 수 있어?"],
  log: ["최근 실패 원인 요약해 줘", "최근 관리 작업 알려줘", "허용 안 된 모델 오류는 어떻게 고쳐?"],
  ai: ["자기소개 해 줘", "어떤 걸 도와줄 수 있어?", "지금 상황 브리핑해 줘"],
  pilot: ["왜 호출이 안 돼?", "내 예산 얼마 남았어?", "코드에 어떻게 써?"],
};

const POSE_FOR = { bridge: "dashboard", telemetry: "usage", keys: "keys", classes: "groups", launch: "keys", engines: "dashboard", crew: "users", log: "dashboard", ai: "welcome", pilot: "usage" };

// ---------------------------------------------------------------- 글 다듬기
function inline(s) {
  return s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
}

// 모델 답에는 **굵게**와 "- " 목록만 허용한다. 나머지는 글자 그대로.
export function renderMarkdown(text) {
  let html = "";
  let list = false;
  for (const raw of esc(text).split("\n")) {
    const item = /^\s*[-•*]\s+(.*)$/.exec(raw);
    if (item) {
      if (!list) { html += "<ul>"; list = true; }
      html += `<li>${inline(item[1])}</li>`;
      continue;
    }
    if (list) { html += "</ul>"; list = false; }
    if (raw.trim()) html += `<p>${inline(raw)}</p>`;
  }
  if (list) html += "</ul>";
  return html;
}

const plain = (text) => String(text || "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/^\s*[-•*]\s+/gm, "• ");

function loadHistory() {
  try {
    const list = JSON.parse(sessionStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(list) ? list.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") : [];
  } catch { return []; }
}

// ---------------------------------------------------------------- 대화창
/**
 * @param {object} o
 * @param {function} o.api          createApi() 결과 (api.stream 포함)
 * @param {"admin"|"user"} o.role
 * @param {HTMLElement} o.host      런처를 붙일 하단 줄
 * @param {function} o.getStation   지금 스테이션 id
 * @param {function} [o.go]         (station, params) 화면 이동
 * @param {function} o.getSettings  { voice, voiceName, proactive }
 * @param {function} [o.onExecuted] 제안 실행 뒤 (proposal, result)
 */
export function createElfy(o) {
  const isAdmin = o.role === "admin";
  let cfg = null;
  let history = loadHistory();
  let busy = false;
  let pending = "";
  let controller = null;
  let openState = false;
  let unread = 0;
  let bubbleTimer = null;
  let poseTimer = null;
  const seen = new Set((() => { try { return JSON.parse(sessionStorage.getItem(SEEN_KEY) || "[]"); } catch { return []; } })());

  // ---- 런처(하단 줄의 엘피)
  const launch = document.createElement("button");
  launch.type = "button";
  launch.className = "elfy-launch";
  launch.id = "elfy-launch";
  launch.dataset.state = "idle";
  launch.setAttribute("aria-haspopup", "dialog");
  launch.setAttribute("aria-expanded", "false");
  launch.title = "AI 엘피에게 묻기 (E)";
  launch.innerHTML = `<span class="elfy-fig"><img alt="" src="${holoImage("dashboard")}"><i class="ring"></i></span>
    <span class="elfy-lbl"><b>AI 엘피</b><small id="elfy-launch-sub">묻기 · E</small></span><span class="elfy-badge" hidden>0</span>`;
  o.host.appendChild(launch);
  const launchImg = launch.querySelector("img");
  const badge = launch.querySelector(".elfy-badge");

  // ---- 말풍선(먼저 알려 주기)
  const bubble = document.createElement("div");
  bubble.className = "elfy-bubble";
  bubble.setAttribute("role", "status");
  bubble.hidden = true;
  document.body.appendChild(bubble);

  // ---- 대화창
  const panel = document.createElement("section");
  panel.className = "elfy-panel";
  panel.id = "elfy";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "AI 엘피와 대화");
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canListen = Boolean(SR) && window.isSecureContext;
  panel.innerHTML = `
    <header class="elfy-h">
      <span class="elfy-fig big"><img alt="" id="elfy-img" src="${holoImage("welcome")}"><i class="ring"></i></span>
      <div class="elfy-title"><span class="code">AI COPILOT · ELFY</span><b>AI 엘피</b><span class="elfy-status" id="elfy-status">연결 확인 중…</span></div>
      <div class="elfy-tools">
        <button class="icon-btn" type="button" id="elfy-voice" aria-pressed="false" title="엘피 목소리로 읽기">${icon("volume")}</button>
        <button class="icon-btn" type="button" id="elfy-new" title="새 대화">${icon("refresh")}</button>
        <button class="icon-btn" type="button" id="elfy-close" title="닫기 (Esc)">${icon("x")}</button>
      </div>
    </header>
    <div class="elfy-log" id="elfy-log" aria-live="polite"></div>
    <div class="elfy-chips" id="elfy-chips"></div>
    <form class="elfy-input" id="elfy-form">
      <textarea id="elfy-q" rows="1" placeholder="${isAdmin ? "예: 3학년A반 소진된 키에 2달러씩 충전해 줘" : "예: 왜 호출이 안 돼?"}" aria-label="엘피에게 보낼 말"></textarea>
      ${canListen ? `<button class="icon-btn" type="button" id="elfy-mic" title="말로 묻기">${icon("mic")}</button>` : ""}
      <button class="btn primary" type="submit" id="elfy-send" title="보내기 (Enter)">${icon("send")}</button>
    </form>
    <div class="elfy-foot" id="elfy-foot">${isAdmin ? "바꾸는 작업은 카드의 [실행]을 눌러야 진행돼요." : "키 충전·해제는 선생님께 부탁하세요."}</div>`;
  document.body.appendChild(panel);
  const log = $("#elfy-log", panel);
  const input = $("#elfy-q", panel);
  const sendBtn = $("#elfy-send", panel);
  const statusEl = $("#elfy-status", panel);
  const bigImg = $("#elfy-img", panel);

  // ---------------------------------------------------------------- 표정
  function pose(name, ms = 0) {
    clearTimeout(poseTimer);
    const src = holoImage(name);
    launchImg.src = src;
    bigImg.src = src;
    if (ms) poseTimer = setTimeout(() => pose(POSE_FOR[o.getStation()] || "dashboard"), ms);
  }
  function mood(state) {
    launch.dataset.state = state;
    panel.dataset.state = state;
  }

  // ---------------------------------------------------------------- 설정 상태
  async function refreshConfig() {
    try {
      cfg = await o.api("/api/assistant/config");
    } catch (e) {
      cfg = { error: e.message };
    }
    paintStatus();
    return cfg;
  }
  const ready = () => Boolean(cfg && (isAdmin ? cfg.ready : cfg.available));
  function paintStatus() {
    const sub = $("#elfy-launch-sub");
    if (!cfg) return;
    if (cfg.error) { statusEl.textContent = `상태를 알 수 없음 · ${cfg.error}`; if (sub) sub.textContent = "연결 확인 필요"; mood("off"); return; }
    if (!ready()) {
      statusEl.textContent = isAdmin ? (cfg.enabled ? "모델 연결이 덜 됐어요" : "꺼져 있어요 · 09 AI 엘피에서 켜기") : "선생님이 켜 두지 않았어요";
      if (sub) sub.textContent = isAdmin ? "설정 필요" : "쉬는 중";
      mood("off");
      return;
    }
    if (isAdmin) {
      const model = cfg.mode === "proxy" ? cfg.proxy_model : cfg.model;
      const where = cfg.mode === "proxy" ? "이 프록시" : { ollama: "Ollama", openai: "OpenAI", compatible: "호환 서버" }[cfg.provider] || cfg.provider;
      statusEl.textContent = `${where} · ${model}${cfg.external && cfg.mask_names ? " · 이름 가림" : ""}`;
    } else statusEl.textContent = "내 키 상황을 물어보세요";
    if (sub) sub.textContent = "묻기 · E";
    if (launch.dataset.state === "off") mood("idle");
  }

  // ---------------------------------------------------------------- 대화 기록
  function saveHistory() {
    try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-40))); } catch { /* 저장 공간 없음 */ }
  }
  function scrollDown() {
    log.scrollTop = log.scrollHeight;
  }
  function addNode(cls, html) {
    const el = document.createElement("div");
    el.className = cls;
    el.innerHTML = html;
    log.appendChild(el);
    scrollDown();
    return el;
  }
  function addUser(text) {
    return addNode("msg user", `<div class="bub">${esc(text).replace(/\n/g, "<br>")}</div>`);
  }
  function addElfy(text, { typing = false } = {}) {
    const el = addNode("msg elfy", `<div class="bub"></div>`);
    const bub = el.querySelector(".bub");
    const html = renderMarkdown(text);
    const reduce = prefersReducedMotion() || document.body.classList.contains("reduce-motion");
    if (!typing || reduce || text.length > 900) {
      bub.innerHTML = html;
      scrollDown();
      return el;
    }
    const flat = plain(text);
    let i = 0;
    bub.classList.add("typing");
    const step = () => {
      i = Math.min(flat.length, i + 3);
      bub.textContent = flat.slice(0, i);
      if (i % 6 === 0) sfx.play("type");
      scrollDown();
      if (i < flat.length) requestAnimationFrame(step);
      else { bub.classList.remove("typing"); bub.innerHTML = html; scrollDown(); }
    };
    requestAnimationFrame(step);
    return el;
  }
  function addNote(text, tone = "info") {
    return addNode(`note ${tone}`, `${icon(tone === "crit" ? "ban" : "bolt")}<span>${esc(text)}</span>`);
  }
  function welcome() {
    log.innerHTML = "";
    if (!cfg) return;
    if (!ready()) {
      if (isAdmin) {
        const el = addNode("msg elfy", `<div class="bub"><p>안녕하세요, AI 엘피예요! 아직 제 두뇌(언어 모델)가 연결되지 않았어요.</p>
          <p>Ollama(학교 PC의 로컬 LLM)나 ChatGPT API 키를 연결하면 상황 요약, 실패 원인 분석, 충전·차단 제안까지 도와드릴게요.</p>
          <p><button class="btn primary sm" type="button" data-elfy-setup>${icon("gear")}AI 엘피 설정 열기</button></p></div>`);
        el.querySelector("[data-elfy-setup]").onclick = () => { close(); if (o.go) o.go("ai"); };
      } else addElfy("지금은 엘피 상담이 꺼져 있어요. 궁금한 점은 선생님께 여쭤보세요.");
      return;
    }
    if (!history.length) {
      addElfy(isAdmin
        ? "안녕하세요, AI 엘피예요! 지금 상황을 요약하거나, 왜 호출이 막혔는지 찾아보거나, 충전·차단·봉쇄를 제안 카드로 준비해 드릴게요. 무엇이든 물어보세요."
        : "안녕하세요, AI 엘피예요! 내 키의 예산·사용 시간, 호출이 안 되는 이유, 코드에서 키 쓰는 법을 알려 드릴게요.");
      return;
    }
    for (const m of history.slice(-20)) {
      if (m.role === "user") addUser(m.content);
      else if (/^\((실행 완료|실행 실패|취소함)\)/.test(m.content)) addNote(m.content, /실패/.test(m.content) ? "crit" : "info");
      else addElfy(m.content);
    }
  }

  function renderChips() {
    const box = $("#elfy-chips", panel);
    const station = isAdmin ? o.getStation() : "pilot";
    const list = ready() ? (CHIPS[station] || CHIPS.bridge) : [];
    box.innerHTML = list.map((q) => `<button class="chip" type="button" data-q="${esc(q)}">${esc(q)}</button>`).join("");
  }
  $("#elfy-chips", panel).addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-q]");
    if (b) ask(b.dataset.q);
  });

  // ---------------------------------------------------------------- 제안 카드
  function resultText(out) {
    if (out && Array.isArray(out.results)) {
      const fail = out.results.filter((r) => r.error).length;
      const skipped = out.results.filter((r) => r.skipped).length;
      const done = out.results.length - fail - skipped;
      return { text: `${done}개 완료${skipped ? ` · 건너뜀 ${skipped}` : ""}${fail ? ` · 실패 ${fail}` : ""}`, fail };
    }
    return { text: "완료", fail: 0 };
  }

  function addProposal(p) {
    const tone = p.tone === "danger" ? "danger" : p.tone === "warn" ? "warn" : "primary";
    const el = addNode(`proposal ${tone}`, `
      <div class="p-h"><span class="code">PROPOSAL · 확인이 필요해요</span><b>${esc(p.title)}</b></div>
      <div class="p-sum">${esc(p.summary || "")}</div>
      ${(p.lines || []).length ? `<ul class="p-lines">${p.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}
      ${p.typed ? `<label class="p-typed">확인을 위해 <b>${esc(p.typed)}</b> 를 입력하세요 <input type="text" autocomplete="off" aria-label="확인 낱말"></label>` : ""}
      <div class="p-actions"><button class="btn ghost sm" type="button" data-act="cancel">취소</button>
        <button class="btn ${tone} sm" type="button" data-act="run">${esc(p.confirm || "실행")}</button></div>
      <div class="p-result" hidden></div>`);
    const run = el.querySelector('[data-act="run"]');
    const typed = el.querySelector(".p-typed input");
    if (typed) {
      run.disabled = true;
      typed.addEventListener("input", () => { run.disabled = typed.value.trim() !== p.typed; });
    }
    const result = el.querySelector(".p-result");
    const finish = (cls, html) => {
      el.classList.add(cls);
      el.querySelectorAll(".p-actions button, .p-typed input").forEach((b) => { b.disabled = true; });
      result.hidden = false;
      result.innerHTML = html;
      scrollDown();
    };
    el.querySelector('[data-act="cancel"]').onclick = () => {
      finish("cancelled", "취소했어요. 아무것도 바뀌지 않았어요.");
      history.push({ role: "assistant", content: `(취소함) ${p.title}` });
      saveHistory();
      sfx.play("close");
    };
    run.onclick = async () => {
      if (!ALLOWED.has(p.request && p.request.path)) {
        finish("failed", "알 수 없는 작업이라 실행하지 않았어요.");
        return;
      }
      // 한 번 더 확인: 차단·봉쇄처럼 바로 영향이 큰 작업
      if (p.tone === "danger" && !p.typed) {
        const okGo = await confirmDialog({ title: p.title, message: p.summary || "진행할까요?", confirmLabel: p.confirm || "실행", tone: "danger", code: "ELFY · CONFIRM" });
        if (!okGo) return;
      }
      run.classList.add("busy");
      run.disabled = true;
      try {
        const out = await o.api(p.request.path, { method: "POST", body: p.request.body, headers: { "X-AIAPI-Via": "elfy" } });
        const r = resultText(out);
        const goBtn = p.after && o.go ? ` <button class="btn xs" type="button" data-go>화면에서 보기</button>` : "";
        finish(r.fail ? "failed" : "done", `${icon(r.fail ? "ban" : "bolt")} ${esc(r.text)}${goBtn}`);
        const gb = result.querySelector("[data-go]");
        if (gb) gb.onclick = () => o.go(p.after.station, p.after.params || {});
        history.push({ role: "assistant", content: `(실행 완료) ${p.title} — ${r.text}` });
        saveHistory();
        sfx.play(r.fail ? "warn" : "ok");
        pose("success", 4000);
        mood("done");
        setTimeout(() => mood(ready() ? "idle" : "off"), 2500);
        toast(`${p.title} · ${r.text}`, { tone: r.fail ? "warn" : "good", title: "엘피 제안 실행" });
        if (o.onExecuted) o.onExecuted(p, out);
      } catch (e) {
        finish("failed", `${icon("ban")} ${esc(e.message)}`);
        history.push({ role: "assistant", content: `(실행 실패) ${p.title} — ${e.message}` });
        saveHistory();
        sfx.play("error");
        pose("warn", 4000);
      } finally {
        run.classList.remove("busy");
      }
    };
    return el;
  }

  // ---------------------------------------------------------------- 묻기
  function setBusy(on) {
    busy = on;
    sendBtn.innerHTML = on ? icon("stop") : icon("send");
    sendBtn.title = on ? "멈추기" : "보내기 (Enter)";
    sendBtn.classList.toggle("danger", on);
    sendBtn.classList.toggle("primary", !on);
    mood(on ? "thinking" : ready() ? "idle" : "off");
  }

  async function ask(question) {
    const q = String(question || "").trim();
    if (!q) return;
    // 답하는 중에 또 물으면 버리지 않고 끝난 뒤 이어서 묻는다.
    if (busy) {
      pending = q;
      input.value = "";
      autosize();
      addNote(`"${q.length > 40 ? `${q.slice(0, 40)}…` : q}" — 지금 답이 끝나면 이어서 볼게요.`, "info");
      return;
    }
    if (!openState) open();
    if (!cfg) await refreshConfig();
    if (!ready()) { welcome(); return; }
    if (log.querySelector(".msg.elfy:only-child")) log.innerHTML = "";
    input.value = "";
    autosize();
    addUser(q);
    const past = history.slice(-12);
    history.push({ role: "user", content: q });
    saveHistory();
    sfx.play("send");
    pose("usage");
    setBusy(true);
    const think = addNode("thinking", `<span class="dots"><i></i><i></i><i></i></span><span class="lbl">질문을 읽는 중…</span>`);
    const trace = addNode("trace", "");
    trace.hidden = true;
    controller = new AbortController();
    let answered = false;
    let proposals = 0;
    const started = performance.now();
    try {
      await o.api.stream("/api/assistant/chat", { question: q, history: past, station: isAdmin ? o.getStation() : "pilot" }, (ev, data) => {
        if (ev === "status") {
          think.querySelector(".lbl").textContent = `${data.label}…`;
          if (data.phase === "thinking") sfx.play("think");
        } else if (ev === "tool") {
          trace.hidden = false;
          trace.insertAdjacentHTML("beforeend", `<div class="${data.ok ? "ok" : "bad"}"><span class="led ${data.ok ? "info" : "warn"}"></span>${esc(data.label)}${data.summary ? ` — ${esc(data.summary)}` : ""}</div>`);
          scrollDown();
        } else if (ev === "notice") {
          addNote(data.text, "warn");
        } else if (ev === "proposal") {
          proposals += 1;
          log.appendChild(think);
          addProposal(data);
          log.appendChild(think);
          sfx.play("proposal");
          pose("warn");
        } else if (ev === "navigate") {
          if (o.go) o.go(data.station, data.params || {});
        } else if (ev === "message") {
          think.remove();
          answered = true;
          addElfy(data.text, { typing: true });
          history.push({ role: "assistant", content: data.text });
          saveHistory();
          sfx.play("elfy");
          speak(data.text);
          if (!proposals) pose("success", 3000);
        } else if (ev === "usage") {
          const secs = ((data.elapsed_ms || performance.now() - started) / 1000).toFixed(1);
          addNode("meta", `${esc(data.model || "")} · ${secs}초 · 토큰 ${Number(data.prompt_tokens || 0).toLocaleString("ko-KR")}+${Number(data.completion_tokens || 0).toLocaleString("ko-KR")}${data.tools === false ? " · 도구 없이" : ""}`);
        } else if (ev === "error") {
          think.remove();
          answered = true;
          addNote(data.message || "엘피가 답하지 못했어요", "crit");
          sfx.play("error");
          pose("warn", 4000);
        }
      }, { signal: controller.signal });
    } catch (e) {
      if (e.name === "AbortError") addNote("질문을 멈췄어요.", "info");
      else {
        addNote(e.message, "crit");
        sfx.play("error");
        if (e.status === 409) refreshConfig();
      }
    } finally {
      think.remove();
      if (!trace.childElementCount) trace.remove();
      if (!answered && !controller.signal.aborted) { /* 오류는 위에서 알렸다 */ }
      controller = null;
      setBusy(false);
      if (!unread && !openState) { unread = 1; paintBadge(); }
    }
    if (pending) {
      const next = pending;
      pending = "";
      ask(next);
    }
  }

  // ---------------------------------------------------------------- 목소리
  function speak(text) {
    const s = o.getSettings();
    if (!s.voice || !("speechSynthesis" in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(plain(text).replace(/[•\-]/g, " ").slice(0, 600));
      u.lang = "ko-KR";
      u.rate = 1.05;
      u.pitch = 1.2;
      const voices = speechSynthesis.getVoices();
      const v = voices.find((x) => x.name === s.voiceName) || voices.find((x) => /^ko/i.test(x.lang));
      if (v) u.voice = v;
      speechSynthesis.speak(u);
    } catch { /* 목소리 기능 없음 */ }
  }
  const voiceBtn = $("#elfy-voice", panel);
  const paintVoice = () => voiceBtn.setAttribute("aria-pressed", String(Boolean(o.getSettings().voice)));
  voiceBtn.onclick = () => {
    const s = o.getSettings();
    s.voice = !s.voice;
    if (o.saveSettings) o.saveSettings();
    paintVoice();
    if (!s.voice && "speechSynthesis" in window) speechSynthesis.cancel();
    toast(s.voice ? "엘피가 답을 소리 내어 읽어요" : "엘피 목소리를 껐어요", { timeout: 2000 });
  };

  // ---------------------------------------------------------------- 말로 묻기 (https·localhost 에서만)
  const mic = $("#elfy-mic", panel);
  if (mic) {
    let rec = null;
    mic.onclick = () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = "ko-KR";
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      mic.setAttribute("aria-pressed", "true");
      let finalText = "";
      rec.onresult = (ev) => {
        let interim = "";
        for (const r of ev.results) { if (r.isFinal) finalText = r[0].transcript; else interim += r[0].transcript; }
        input.value = finalText || interim;
        autosize();
      };
      rec.onerror = (ev) => { if (ev.error !== "no-speech") toast(`음성 인식 실패: ${ev.error}`, { tone: "warn" }); };
      rec.onend = () => {
        mic.setAttribute("aria-pressed", "false");
        rec = null;
        if (finalText.trim()) ask(finalText);
      };
      rec.start();
    };
  }

  // ---------------------------------------------------------------- 열고 닫기
  function paintBadge() {
    badge.hidden = !unread;
    badge.textContent = String(unread);
  }
  function open(prefill) {
    if (!openState) {
      openState = true;
      panel.hidden = false;
      panel.classList.remove("closing");
      launch.setAttribute("aria-expanded", "true");
      hideBubble();
      unread = 0;
      paintBadge();
      if (!log.childElementCount) welcome();
      renderChips();
      paintVoice();
      sfx.play("open");
      refreshConfig().then(() => { if (!history.length || !ready()) welcome(); renderChips(); });
    }
    if (prefill) { input.value = prefill; autosize(); }
    setTimeout(() => input.focus(), 60);
  }
  function close() {
    if (!openState) return;
    openState = false;
    launch.setAttribute("aria-expanded", "false");
    sfx.play("close");
    if (document.body.classList.contains("reduce-motion")) { panel.hidden = true; return; }
    panel.classList.add("closing");
    setTimeout(() => { if (!openState) { panel.hidden = true; panel.classList.remove("closing"); } }, 220);
  }
  launch.onclick = () => (openState ? close() : open());
  $("#elfy-close", panel).onclick = () => { close(); launch.focus(); };
  $("#elfy-new", panel).onclick = () => {
    pending = "";
    if (busy && controller) controller.abort();
    history = [];
    saveHistory();
    welcome();
    renderChips();
    input.focus();
  };
  panel.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { ev.stopPropagation(); close(); launch.focus(); }
  });

  function autosize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(140, input.scrollHeight)}px`;
  }
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      ask(input.value);
    }
  });
  $("#elfy-form", panel).addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (busy && controller) controller.abort();
    else ask(input.value);
  });

  // ---------------------------------------------------------------- 먼저 알려 주기
  function hideBubble() {
    clearTimeout(bubbleTimer);
    bubble.hidden = true;
  }
  /**
   * 규칙으로 찾은 소식을 말풍선으로 알린다(모델을 부르지 않는다).
   * ask: 누르면 엘피에게 보낼 질문 · go: [보러 가기] 이동 { station, ...params }
   */
  function notify({ level = "info", text, ask: q = "", go = null, timeout = 12000 } = {}) {
    if (!o.getSettings().proactive && level !== "tip") return;
    if (openState) return;
    clearTimeout(bubbleTimer);
    bubble.className = `elfy-bubble ${level}`;
    bubble.innerHTML = `<div class="who">AI 엘피</div><div class="txt">${esc(text)}</div>
      <div class="acts">${q && ready() ? `<button class="btn xs primary" type="button" data-b="ask">엘피에게 맡기기</button>` : ""}
      ${go && o.go ? `<button class="btn xs" type="button" data-b="go">보러 가기</button>` : ""}
      <button class="btn xs ghost" type="button" data-b="x">닫기</button></div>`;
    bubble.hidden = false;
    bubble.querySelectorAll("[data-b]").forEach((b) => {
      b.onclick = () => {
        hideBubble();
        if (b.dataset.b === "ask") ask(q);
        if (b.dataset.b === "go" && go) {
          const { station, ...params } = go;
          o.go(station, params);
        }
      };
    });
    if (level === "crit" || level === "warn") {
      pose("warn", 6000);
      if (!openState) { unread += 1; paintBadge(); }
    }
    if (timeout) bubbleTimer = setTimeout(hideBubble, timeout);
  }

  function setStation(id) {
    if (openState) renderChips();
    if (busy) return;
    pose(POSE_FOR[id] || "dashboard");
    launch.classList.remove("hop");
    void launch.offsetWidth;
    launch.classList.add("hop");
    // 스테이션에 처음 들어오면 짧게 도움말을 건넨다.
    const line = STATION_LINES[id] && STATION_LINES[id][1];
    if (line && !seen.has(id) && o.getSettings().proactive) {
      seen.add(id);
      try { sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen])); } catch { /* 무시 */ }
      notify({ level: "tip", text: line, timeout: 6500 });
    }
  }

  // 다른 화면의 알림에 표정으로 반응한다.
  window.addEventListener("aiapi:toast", (ev) => {
    if (busy) return;
    const tone = ev.detail && ev.detail.tone;
    if (tone === "good") pose("success", 2500);
    else if (tone === "crit") pose("warn", 3500);
  });

  refreshConfig().then(() => { if (openState) welcome(); });

  return {
    open,
    close,
    toggle: () => (openState ? close() : open()),
    ask,
    notify,
    setStation,
    refreshConfig,
    get isOpen() { return openState; },
    get ready() { return ready(); },
  };
}
