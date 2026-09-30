// 가려진 API 키. 마우스를 올리거나 초점이 가 있는 동안 보이고(터치는 보기 버튼을 누르면 10초),
// 복사는 복사 버튼으로만 한다. 원문은 처음 필요할 때만 서버에서 받아(작업 기록에 남는다) 이 페이지 메모리에만 둔다.
import { esc, icon, copyText } from "./util.js";
import { toast } from "./ui.js";

const DOTS = "•".repeat(16);
export const maskedKey = (hint) => `sk-${DOTS}${hint || "••••"}`;

/**
 * @param {HTMLElement} el
 * @param {object} o
 * @param {string} o.hint                  끝 네 글자
 * @param {(purpose: "view"|"copy") => Promise<string>} o.fetchSecret
 * @param {string} [o.note]
 * @param {string} [o.copied]              복사했을 때 알림
 */
export function mountSecret(el, { hint, fetchSecret, note = "마우스를 올리면 보여요 · 친구에게 보여 주거나 나누지 마세요", copied = "키를 복사했어요. 코드의 api_key 자리에 붙여 넣으세요." }) {
  el.classList.add("keybox");
  el.innerHTML = `
    <code class="k-val" tabindex="0" aria-label="API 키, 가려져 있음. 초점을 두거나 보기 버튼을 누르면 보입니다">${esc(maskedKey(hint))}</code>
    <button class="icon-btn k-peek" type="button" title="10초 동안 보기" aria-pressed="false">${icon("eye")}</button>
    <button class="btn xs primary k-copy" type="button">${icon("copy")}복사</button>
    <div class="k-note">${esc(note)}</div>`;
  const val = el.querySelector(".k-val");
  const peek = el.querySelector(".k-peek");
  const copy = el.querySelector(".k-copy");
  let secret = null;
  let pending = null;
  let timer = null;
  let holding = false;

  const get = (purpose) => {
    if (secret) return Promise.resolve(secret);
    if (!pending) {
      pending = fetchSecret(purpose).then((s) => { secret = s; return s; }).finally(() => { pending = null; });
    }
    return pending;
  };
  const hide = () => {
    clearTimeout(timer);
    timer = null;
    val.textContent = maskedKey(hint);
    val.classList.remove("shown");
    peek.setAttribute("aria-pressed", "false");
  };
  const show = async () => {
    val.classList.add("loading");
    try {
      const s = await get("view");
      if (!holding && !timer) return;
      val.textContent = s;
      val.classList.add("shown");
      peek.setAttribute("aria-pressed", "true");
    } catch (e) {
      toast(e.message, { tone: "warn" });
    } finally {
      val.classList.remove("loading");
    }
  };

  val.addEventListener("mouseenter", () => { holding = true; show(); });
  val.addEventListener("mouseleave", () => { holding = false; if (!timer) hide(); });
  val.addEventListener("focus", () => { holding = true; show(); });
  val.addEventListener("blur", () => { holding = false; if (!timer) hide(); });
  peek.addEventListener("click", () => {
    if (val.classList.contains("shown")) { hide(); return; }
    timer = setTimeout(hide, 10000);
    show();
  });
  copy.addEventListener("click", async () => {
    try {
      const s = await get("copy");
      const ok = await copyText(s);
      if (!ok) { toast("복사하지 못했습니다. 보기를 눌러 직접 선택해 복사하세요.", { tone: "warn" }); return; }
      copy.innerHTML = `${icon("copy")}복사됨 ✓`;
      setTimeout(() => { copy.innerHTML = `${icon("copy")}복사`; }, 2000);
      toast(copied, { tone: "good", timeout: 3500 });
    } catch (e) {
      toast(e.message, { tone: "warn" });
    }
  });
  // 창을 떠나면 다시 가린다.
  document.addEventListener("visibilitychange", () => { if (document.hidden) { holding = false; hide(); } });
  return { get, hide };
}
