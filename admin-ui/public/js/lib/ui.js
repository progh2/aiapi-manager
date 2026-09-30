// 토스트·대화상자·확인창·키 공개 창·서랍·명령 팔레트.
import { $, esc, icon, copyText } from "./util.js";

const root = () => $("#overlay-root");
const stack = [];

// ---------------------------------------------------------------- 토스트
export function toast(message, { tone = "info", title = "", timeout } = {}) {
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = `toast ${tone}`;
  el.setAttribute("role", tone === "crit" ? "alert" : "status");
  const ledTone = tone === "crit" ? "crit" : tone === "warn" ? "warn" : tone === "good" ? "good" : "info";
  el.innerHTML = `<span class="led ${ledTone}"></span><div>${title ? `<div class="ttl">${esc(title)}</div>` : ""}<div class="msg">${esc(message)}</div></div><button class="x" type="button" aria-label="닫기">×</button>`;
  const close = () => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 300);
  };
  el.querySelector(".x").onclick = close;
  box.appendChild(el);
  while (box.children.length > 5) box.firstElementChild.remove();
  // 오류는 사용자가 닫을 때까지 둔다. 놓치지 않게.
  const ms = timeout ?? (tone === "crit" ? 0 : tone === "warn" ? 7000 : 4200);
  if (ms) setTimeout(close, ms);
  return close;
}

export const toastError = (e, title = "실패") => toast(e && e.message ? e.message : String(e), { tone: "crit", title });

// ---------------------------------------------------------------- 대화상자
function focusables(el) {
  return [...el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((n) => !n.disabled && n.offsetParent !== null);
}

function trap(el, ev) {
  if (ev.key !== "Tab") return;
  const list = focusables(el);
  if (!list.length) return;
  const first = list[0];
  const last = list[list.length - 1];
  if (ev.shiftKey && document.activeElement === first) { last.focus(); ev.preventDefault(); }
  else if (!ev.shiftKey && document.activeElement === last) { first.focus(); ev.preventDefault(); }
}

export function isOverlayOpen() {
  return stack.length > 0;
}

export function closeTop() {
  const top = stack[stack.length - 1];
  if (top) top.close();
}

function mount(node, { scrim = true, onClose, dismissable = true } = {}) {
  const prev = document.activeElement;
  let scrimEl = null;
  if (scrim) {
    scrimEl = document.createElement("div");
    scrimEl.className = "scrim";
    if (dismissable) scrimEl.onclick = () => handle.close();
    root().appendChild(scrimEl);
  }
  root().appendChild(node);
  const onKey = (ev) => {
    if (stack[stack.length - 1] !== handle) return;
    if (ev.key === "Escape" && dismissable) { ev.stopPropagation(); handle.close(); }
    else trap(node, ev);
  };
  document.addEventListener("keydown", onKey, true);
  let closed = false;
  const handle = {
    el: node,
    close(result) {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey, true);
      node.remove();
      if (scrimEl) scrimEl.remove();
      const i = stack.indexOf(handle);
      if (i >= 0) stack.splice(i, 1);
      if (prev && prev.focus) { try { prev.focus({ preventScroll: true }); } catch { /* 이미 사라진 요소 */ } }
      if (onClose) onClose(result);
    },
  };
  stack.push(handle);
  requestAnimationFrame(() => {
    const auto = node.querySelector("[autofocus]") || focusables(node)[0];
    if (auto) auto.focus();
  });
  return handle;
}

/**
 * modal({ title, code, body, actions, size, tone, onOpen })
 * actions: [{ label, tone, value, onClick(handle) → false 이면 닫지 않음 }]
 */
export function modal({ title, code = "", body = "", actions = [{ label: "닫기", value: null }], size = "", tone = "", onOpen, onClose, dismissable = true } = {}) {
  const el = document.createElement("div");
  el.className = `modal ${size} ${tone}`;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", title);
  el.innerHTML = `
    <div class="modal-h">${code ? `<span class="code">${esc(code)}</span>` : ""}<h3>${esc(title)}</h3>
      ${dismissable ? `<button class="icon-btn x" type="button" aria-label="닫기">${icon("x")}</button>` : ""}</div>
    <div class="modal-b"></div>
    ${actions.length ? `<div class="modal-f"></div>` : ""}`;
  const b = el.querySelector(".modal-b");
  if (typeof body === "string") b.innerHTML = body;
  else if (body instanceof Node) b.appendChild(body);
  const handle = mount(el, { onClose, dismissable });
  if (dismissable) el.querySelector(".modal-h .x").onclick = () => handle.close(null);
  const foot = el.querySelector(".modal-f");
  for (const a of actions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `btn ${a.tone || ""}`;
    btn.textContent = a.label;
    if (a.autofocus) btn.setAttribute("autofocus", "");
    btn.onclick = async () => {
      if (a.onClick) {
        btn.classList.add("busy");
        btn.disabled = true;
        let keep;
        try { keep = await a.onClick(handle); } finally { btn.classList.remove("busy"); btn.disabled = false; }
        if (keep === false) return;
      }
      handle.close(a.value !== undefined ? a.value : a.label);
    };
    foot.appendChild(btn);
  }
  if (onOpen) onOpen(handle, b);
  return handle;
}

/**
 * 확인창. typed 가 있으면 그 낱말을 입력해야 실행 버튼이 켜진다(되돌릴 수 없는 작업).
 */
export function confirmDialog({ title, message, detail = "", confirmLabel = "실행", tone = "", typed = "", code = "CONFIRM" }) {
  return new Promise((resolve) => {
    const body = `
      <p style="margin:0 0 10px;line-height:1.6">${esc(message)}</p>
      ${detail ? `<div class="callout ${tone === "danger" ? "crit" : "warn"}" style="white-space:pre-wrap">${esc(detail)}</div>` : ""}
      ${typed ? `<label class="field"><span>확인을 위해 <b style="color:var(--text-primary)">${esc(typed)}</b> 를 입력하세요</span><input type="text" id="cf-typed" autocomplete="off" autofocus></label>` : ""}`;
    let done = false;
    const h = modal({
      title, code, body, tone: tone === "danger" ? "crit" : "",
      actions: [
        { label: "취소", tone: "ghost", value: false },
        { label: confirmLabel, tone: tone === "danger" ? "danger" : tone === "warn" ? "warn" : "primary", value: true, autofocus: !typed },
      ],
      onClose: (v) => { if (!done) { done = true; resolve(v === true); } },
    });
    if (typed) {
      const go = h.el.querySelector(".modal-f .btn:last-child");
      const input = h.el.querySelector("#cf-typed");
      go.disabled = true;
      input.addEventListener("input", () => { go.disabled = input.value.trim() !== typed; });
      input.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !go.disabled) go.click(); });
    }
  });
}

/**
 * 키를 한 번만 보여 주는 창. 복사 버튼과 예제 코드를 곁들인다.
 */
export function reveal({ title = "새 키", secret, lines = [], snippet = "" }) {
  const body = `
    <div class="callout warn">이 키는 <b>지금 한 번만</b> 보입니다. 창을 닫기 전에 복사해 학생에게 전달하세요.</div>
    <div class="secret" id="rv-secret">${esc(secret)}</div>
    <div class="row" style="margin-top:10px"><button class="btn primary sm" type="button" id="rv-copy">${icon("copy")} 키 복사</button>
      ${lines.map((l) => `<span class="tag info">${esc(l)}</span>`).join(" ")}</div>
    ${snippet ? `<h4 style="margin:16px 0 8px;font-size:13px">학생 코드 예시</h4><div class="snippet"><pre>${esc(snippet)}</pre><button class="btn xs" type="button" id="rv-copy-code">복사</button></div>` : ""}`;
  modal({
    title, code: "SECURE CHANNEL", body, size: "wide",
    actions: [{ label: "복사했습니다 · 닫기", tone: "primary", value: true }],
    onOpen: (h) => {
      h.el.querySelector("#rv-copy").onclick = async () => {
        const ok = await copyText(secret);
        toast(ok ? "키를 복사했습니다" : "복사하지 못했습니다. 직접 선택해 복사하세요", { tone: ok ? "good" : "warn" });
      };
      const cc = h.el.querySelector("#rv-copy-code");
      if (cc) cc.onclick = async () => { await copyText(snippet.replace("발급받은_키", secret)); toast("예제 코드를 복사했습니다", { tone: "good" }); };
    },
  });
}

// ---------------------------------------------------------------- 서랍(오른쪽)
export function drawer({ title, code = "", render, onClose }) {
  const el = document.createElement("aside");
  el.className = "drawer";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", title);
  el.innerHTML = `<div class="modal-h">${code ? `<span class="code">${esc(code)}</span>` : ""}<h3>${esc(title)}</h3><button class="icon-btn x" type="button" aria-label="닫기">${icon("x")}</button></div><div class="modal-b"></div>`;
  const handle = mount(el, { onClose });
  el.querySelector(".x").onclick = () => handle.close();
  if (render) render(el.querySelector(".modal-b"), handle);
  return handle;
}

// ---------------------------------------------------------------- 명령 팔레트
export function commandPalette(getItems) {
  const el = document.createElement("div");
  el.className = "palette";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", "명령 팔레트");
  el.innerHTML = `<input type="text" placeholder="스테이션, 키 별칭, 학급, 명령을 입력하세요…" aria-label="명령 검색" autocomplete="off" autofocus><ul role="listbox"></ul>`;
  const input = el.querySelector("input");
  const list = el.querySelector("ul");
  const handle = mount(el);
  let items = [];
  let sel = 0;
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const all = getItems();
    items = (q ? all.filter((it) => `${it.label} ${it.sub || ""} ${it.keywords || ""}`.toLowerCase().includes(q)) : all.filter((it) => !it.searchOnly)).slice(0, 40);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.innerHTML = items.map((it, i) => `<li role="option" data-i="${i}" aria-selected="${i === sel}"><span class="grp">${esc(it.group)}</span><span>${esc(it.label)}</span>${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ""}</li>`).join("")
      || '<li class="muted" aria-disabled="true">맞는 항목이 없습니다</li>';
    const cur = list.querySelector('[aria-selected="true"]');
    if (cur) cur.scrollIntoView({ block: "nearest" });
  };
  const run = (i) => {
    const it = items[i];
    if (!it) return;
    handle.close();
    setTimeout(() => it.run(), 0);
  };
  input.addEventListener("input", () => { sel = 0; render(); });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); render(); ev.preventDefault(); }
    else if (ev.key === "ArrowUp") { sel = Math.max(0, sel - 1); render(); ev.preventDefault(); }
    else if (ev.key === "Enter") { run(sel); ev.preventDefault(); }
  });
  list.addEventListener("click", (ev) => {
    const li = ev.target.closest("li[data-i]");
    if (li) run(Number(li.dataset.i));
  });
  render();
  return handle;
}

// ---------------------------------------------------------------- 3D 툴팁
let sceneTip = null;
export function showSceneTip(html, x, y) {
  if (!sceneTip) {
    sceneTip = document.createElement("div");
    sceneTip.className = "scene-tip";
    document.body.appendChild(sceneTip);
  }
  sceneTip.innerHTML = html;
  sceneTip.style.display = "block";
  const r = sceneTip.getBoundingClientRect();
  sceneTip.style.left = Math.min(window.innerWidth - r.width - 10, x + 16) + "px";
  sceneTip.style.top = Math.max(10, Math.min(window.innerHeight - r.height - 10, y + 12)) + "px";
}

export function hideSceneTip() {
  if (sceneTip) sceneTip.style.display = "none";
}

// 버튼을 누르는 동안 막고 끝나면 푼다.
export async function busy(btn, fn) {
  if (!btn) return fn();
  btn.disabled = true;
  btn.classList.add("busy");
  try { return await fn(); } finally { btn.disabled = false; btn.classList.remove("busy"); }
}
