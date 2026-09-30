// 공용 도우미. 화면에 넣는 값은 모두 esc() 를 거친다.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const DAY = 86400000;

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

export const icon = (name, cls = "") => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

// 1센트 미만은 셋째 자리에서 반올림하면 $0.000 이 되어 비용이 안 잡힌 것처럼 보인다
// (예: GPT-6 Luna 3천 토큰 ≈ $0.0003). 유효 숫자 2자리까지 적는다.
export function tinyAmount(a) {
  if (a < 1e-8) return "0.00000001";
  const digits = Math.min(8, 1 - Math.floor(Math.log10(a)));
  return a.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

export function money(v, { dash = "—" } = {}) {
  if (v == null || !Number.isFinite(Number(v))) return dash;
  const n = Number(v);
  const a = Math.abs(n);
  if (a > 0 && a < 1e-8) return n < 0 ? "-<$0.00000001" : "<$0.00000001";
  const s = a >= 1000 ? a.toLocaleString("en-US", { maximumFractionDigits: 0 })
    : a >= 100 ? a.toFixed(0) : a >= 1 ? a.toFixed(2) : a === 0 ? "0" : a >= 0.01 ? a.toFixed(3) : tinyAmount(a);
  return (n < 0 ? "-$" : "$") + s;
}

export function compact(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (Math.abs(v) >= 1e4) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return v.toLocaleString("ko-KR");
}

export const num = (n) => (Number(n) || 0).toLocaleString("ko-KR");
export const pct = (r) => `${Math.round((Number(r) || 0) * 100)}%`;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const sum = (list, f = (x) => x) => list.reduce((acc, x) => acc + (Number(f(x)) || 0), 0);
export const uniq = (list) => [...new Set(list)];

const seoulFmt = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short",
});

export function seoulParts(date = new Date()) {
  const parts = Object.fromEntries(seoulFmt.formatToParts(date).map((p) => [p.type, p.value]));
  const wd = { 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6, 일: 7 }[parts.weekday] || 0;
  return {
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
    hh: Number(parts.hour) % 24, mm: Number(parts.minute), ss: Number(parts.second),
    isoDay: wd, weekday: parts.weekday,
  };
}

export function todayYmd(date = new Date()) {
  const p = seoulParts(date);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = seoulParts(d);
  return `${p.y}. ${p.m}. ${p.d}.`;
}

export function fmtShortDate(iso) {
  if (!iso) return "—";
  const p = seoulParts(new Date(iso));
  return `${p.m}/${p.d}`;
}

export function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = seoulParts(d);
  return `${p.m}/${p.d} ${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
}

export function fmtTime(iso) {
  if (!iso) return "—";
  const p = seoulParts(new Date(iso));
  return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}:${String(p.ss).padStart(2, "0")}`;
}

export function relTime(iso, now = Date.now()) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.round((now - t) / 1000);
  if (s < 0) {
    const f = -s;
    if (f < 3600) return `${Math.ceil(f / 60)}분 뒤`;
    if (f < 86400) return `${Math.round(f / 3600)}시간 뒤`;
    return `${Math.round(f / 86400)}일 뒤`;
  }
  if (s < 45) return "방금";
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`;
  if (s < 86400 * 2) return "어제";
  return `${Math.round(s / 86400)}일 전`;
}

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function downloadText(filename, text, type = "text/csv;charset=utf-8") {
  // 엑셀이 한글 CSV 를 깨뜨리지 않게 BOM 을 붙인다.
  const body = type.startsWith("text/csv") ? "﻿" + text : text;
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function toCsv(headers, rows) {
  const cell = (v) => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))].join("\n");
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http(내부 IP) 에서는 clipboard API 가 막힌다. 예전 방식으로 복사한다.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

// ---------------------------------------------------------------- 도메인
export const DUR_LABEL = { "1d": "1일마다", "7d": "7일마다", "30d": "30일마다" };
export const DAY_NAMES = ["", "월", "화", "수", "목", "금", "토", "일"];

export function formatSchedule(schedule) {
  const windows = Array.isArray(schedule) ? schedule : [];
  if (!windows.length) return "항상";
  return windows.map((w) => `${(w.days || []).map((d) => DAY_NAMES[d] || "").join("")} ${w.start}–${w.end}`).join(", ");
}

const toMin = (hhmm) => {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// 서버 lib/schedule.js 와 같은 규칙. 서울 시각, 종료는 포함하지 않는다.
export function scheduleAllows(schedule, date = new Date()) {
  const windows = Array.isArray(schedule) ? schedule : [];
  if (!windows.length) return true;
  const p = seoulParts(date);
  const now = p.hh * 60 + p.mm;
  return windows.some((w) => {
    const s = toMin(w.start);
    const e = toMin(w.end);
    return s != null && e != null && (w.days || []).includes(p.isoDay) && now >= s && now < e;
  });
}

// 학급 시간 상태: always(항상 열림) · open(수업 중) · closed(수업 외)
export function sessionState(schedule, date = new Date()) {
  const windows = Array.isArray(schedule) ? schedule : [];
  if (!windows.length) return { code: "always", label: "항상 열림", tone: "info" };
  return scheduleAllows(windows, date)
    ? { code: "open", label: "수업 중", tone: "good" }
    : { code: "closed", label: "수업 외", tone: "off" };
}

export function isExpired(k, now = Date.now()) {
  return Boolean(k.expires) && new Date(k.expires).getTime() < now;
}

export function isExpiringSoon(k, days = 7, now = Date.now()) {
  if (!k.expires) return false;
  const t = new Date(k.expires).getTime();
  return t >= now && t <= now + days * DAY;
}

export const isCamp = (k) => Boolean(k && k.metadata && k.metadata.aiapi_camp);
export const isLocked = (k) => Boolean(k && k.metadata && k.metadata.aiapi_lockdown);
// 도커 네트워크의 게이트웨이(172.16~31.x.0.1). 브리지 네트워크에서 포트를 공개하면 시놀로지 도커가
// 연결을 대신 넘겨 모든 호출이 이 주소로 찍힌다. 학생 PC 의 실제 IP 가 아니다.
export const isDockerGatewayIp = (ip) => /^172\.(1[6-9]|2\d|3[01])\.0\.1$/.test(String(ip || "").trim());

export const isRetired = (k) => /-폐기(-\d+)?$/.test(String((k && k.key_alias) || ""));
// AI 엘피 "프록시 방식"이 쓰는 비서 전용 키. 학생 키 개수·3D 에서 뺀다.
export const isSystemKey = (k) => Boolean(k && k.metadata && k.metadata.aiapi_system);

export function budgetRatio(spend, max) {
  if (max == null || !Number.isFinite(Number(max)) || Number(max) <= 0) return null;
  return (Number(spend) || 0) / Number(max);
}

// 키 한 개의 상태. 우선순위: 봉쇄 > 차단 > 만료 > 소진 > 임박 > 사용 중
export function keyState(k, now = Date.now()) {
  if (k.blocked && isLocked(k)) return { code: "locked", label: "봉쇄", tone: "crit" };
  if (k.blocked) return { code: "blocked", label: isRetired(k) ? "폐기" : "차단", tone: "crit" };
  if (isExpired(k, now)) return { code: "expired", label: "만료", tone: "off" };
  const r = budgetRatio(k.spend, k.max_budget);
  if (r != null && r >= 1) return { code: "over", label: "소진", tone: "crit" };
  if (r != null && r >= 0.8) return { code: "warn", label: "임박", tone: "warn" };
  return { code: "active", label: "사용 중", tone: "good" };
}

export function meterHtml(spend, max, { showText = true } = {}) {
  const s = Number(spend) || 0;
  if (max == null) {
    return `<div class="spend">${showText ? `<div class="t"><span class="num">${money(s)}</span><span class="muted">한도 없음</span></div>` : ""}<div class="meter"><i style="width:0"></i></div></div>`;
  }
  const r = budgetRatio(s, max) ?? 0;
  const cls = r >= 1 ? "crit" : r >= 0.8 ? "warn" : "";
  const flag = r >= 1 ? ' <span class="tag crit">소진</span>' : r >= 0.8 ? ' <span class="tag warn">임박</span>' : "";
  return `<div class="spend">${showText ? `<div class="t"><span class="num">${money(s)} / ${money(max)}</span>${flag}</div>` : ""}<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(Math.min(1, r) * 100)}"><i class="${cls}" style="width:${Math.min(100, r * 100).toFixed(1)}%"></i></div></div>`;
}

export function stateTag(st) {
  const tone = st.tone === "off" ? "mute" : st.tone;
  return `<span class="state"><span class="led ${st.tone === "off" ? "off" : st.tone}"></span><span class="tag ${tone}">${esc(st.label)}</span></span>`;
}

export function snippetPython(baseUrl, model, key = "발급받은_키") {
  return `from openai import OpenAI

client = OpenAI(
    api_key="${key}",
    base_url="${baseUrl}",
)
resp = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "안녕하세요!"}],
)
print(resp.choices[0].message.content)`;
}

export function snippetJs(baseUrl, model, key = "발급받은_키") {
  return `import OpenAI from "openai";

const client = new OpenAI({ apiKey: "${key}", baseURL: "${baseUrl}" });
const resp = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "안녕하세요!" }],
});
console.log(resp.choices[0].message.content);`;
}

export function snippetCurl(baseUrl, model, key = "발급받은_키") {
  return `curl ${baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${model}", "messages": [{"role": "user", "content": "안녕하세요!"}]}'`;
}

export function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
