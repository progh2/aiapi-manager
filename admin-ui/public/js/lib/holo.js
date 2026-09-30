// 홀로그램 AI "엘피". 스테이션마다 자세를 바꾸고 짧게 말한다. 대사는 글자를 한 자씩 찍는다.
import { $, esc, prefersReducedMotion } from "./util.js";

const POSES = ["welcome", "dashboard", "keys", "groups", "usage", "users", "warn", "success"];
const img = (pose) => `/mascot/holo/elf-${POSES.includes(pose) ? pose : "dashboard"}.webp`;

export const STATION_LINES = {
  bridge: ["dashboard", ""],
  telemetry: ["usage", "사용량은 서울 시각 하루 단위로 모아요. 예측은 최근 속도를 그대로 이어 본 값이에요."],
  keys: ["keys", "별칭을 누르면 상세가 열려요. 여러 키를 골라 한 번에 막거나 충전할 수 있어요."],
  classes: ["groups", "학급 예산은 소속 학생 합계에 걸려요. 시험 때는 '봉쇄'로 한 번에 막을 수 있어요."],
  launch: ["keys", "새 키는 발급 직후 한 번만 보여요. CSV와 학생 안내문을 꼭 챙기세요!"],
  engines: ["dashboard", "공급자 회사 사이트에도 월 한도를 꼭 걸어 두세요. 여기 한도와 따로 요금이 나갈 수 있어요."],
  crew: ["users", "등록한 구글 계정만 들어와요. 학생은 연결된 키의 사용량만 봐요."],
  log: ["dashboard", "막힌 호출은 이유까지 보여 드려요. 학생에게 그대로 알려 주면 돼요."],
  ai: ["welcome", "여기서 제 두뇌(언어 모델)를 연결해요. Ollama 나 ChatGPT API 키를 넣고 모델을 고르면 돼요!"],
};

let typingTimer = null;

export function holoImage(pose) {
  return img(pose);
}

export function say(target, pose, text, { who = "AI 엘피" } = {}) {
  const box = typeof target === "string" ? $(target) : target;
  if (!box) return;
  const fig = box.querySelector(".holo-fig img");
  if (fig && pose) fig.src = img(pose);
  const bubble = box.querySelector(".holo-say");
  if (!bubble) return;
  clearInterval(typingTimer);
  const full = String(text || "");
  if (prefersReducedMotion() || document.body.classList.contains("reduce-motion") || full.length > 140) {
    bubble.innerHTML = `<span class="who">${esc(who)}</span>${esc(full)}`;
    return;
  }
  let i = 0;
  bubble.innerHTML = `<span class="who">${esc(who)}</span><span class="txt"></span><span class="caret"></span>`;
  const out = bubble.querySelector(".txt");
  typingTimer = setInterval(() => {
    i += 2;
    out.textContent = full.slice(0, i);
    if (i >= full.length) {
      clearInterval(typingTimer);
      const caret = bubble.querySelector(".caret");
      if (caret) setTimeout(() => caret.remove(), 1200);
    }
  }, 22);
}

export function footPose(pose) {
  const el = $("#foot-holo");
  if (el) el.src = img(pose);
}
