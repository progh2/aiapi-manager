// 여러 스테이션이 같이 쓰는 입력 부품: 공급자·모델 칩, 시간표 편집기, 학급 선택.
import { $, $$, esc, DAY_NAMES, seoulParts } from "./util.js";
import { state, providerById, providerEntries, isCampLowCost } from "./store.js";

export const RESET_OPTIONS = `
  <option value="">없음 (총액 한도)</option>
  <option value="1d">1일마다 0으로</option>
  <option value="7d">7일마다 0으로</option>
  <option value="30d">30일마다 0으로</option>`;
// 리셋은 발급·등록 시각부터 센다. 달력의 매월 1일이 아니다.
export const RESET_HINT = "리셋은 만든 시각부터 셉니다(달력 1일 아님). 없음이면 총액에 닿는 순간 멈춥니다.";

export const DURATION_OPTIONS = `
  <option value="">무기한</option>
  <option value="7d">7일</option>
  <option value="30d">30일</option>
  <option value="90d">90일 (한 학기)</option>
  <option value="120d">120일</option>`;

// :has() 를 모르는 브라우저를 위해 칩 선택 상태를 클래스로도 단다.
document.addEventListener("change", (ev) => {
  const chip = ev.target.closest && ev.target.closest(".chip");
  if (chip && ev.target.type === "checkbox") chip.classList.toggle("on", ev.target.checked);
});

export function readChecked(name, scope = document) {
  return $$(`input[name="${name}"]:checked`, scope).map((c) => c.value);
}

export function teamOptions({ selected = "", none = "학급 없음", withNew = false } = {}) {
  const teams = [...state.teams].sort((a, b) => String(a.team_alias).localeCompare(String(b.team_alias), "ko"));
  return `<option value="">${esc(none)}</option>`
    + (withNew ? `<option value="__new__">+ 새 학급 만들기</option>` : "")
    + teams.map((t) => `<option value="${esc(t.team_id)}" ${t.team_id === selected ? "selected" : ""}>${esc(t.team_alias || t.team_id.slice(0, 8))}</option>`).join("");
}

export function providerOptions(selected = "", { pools = true } = {}) {
  const list = state.providers.filter((p) => pools || p.kind !== "pool");
  if (!list.length) return `<option value="env">기본 OpenAI (.env)</option>`;
  return list.map((p) => `<option value="${esc(p.id)}" ${p.id === selected ? "selected" : ""}>${esc(p.label)}${p.slug ? ` (${esc(p.slug)})` : ""}${p.kind === "pool" ? " · 묶음" : ""}</option>`).join("");
}

function chipsHtml(name, entries, checked, { campOnly = false } = {}) {
  if (!entries.length) return '<span class="muted">이 공급자에 등록된 모델이 없습니다</span>';
  return entries.map((m) => {
    const blocked = campOnly && !(isCampLowCost(m.value) || isCampLowCost(m.label));
    const on = !blocked && checked.includes(m.value);
    const extra = m.value !== m.label ? ` <small>${esc(m.value)}</small>` : "";
    if (blocked) return `<span class="chip off" title="캠프 키는 저가 모델만 됩니다">${esc(m.label)}${extra} <span class="tag mute">캠프 불가</span></span>`;
    return `<label class="chip ${on ? "on" : ""}"><input type="checkbox" name="${esc(name)}" value="${esc(m.value)}" ${on ? "checked" : ""}>${esc(m.label)}${extra}</label>`;
  }).join("");
}

/**
 * 공급자 선택 + 모델 칩. 선택한 공급자의 모델만 보인다.
 * checked 가 null 이면 gpt-4o-mini 계열을 미리 고른다(캠프는 저가 모델 하나).
 */
export function bindModelPicker({ select, box, name, hint = null, campOnly = false }) {
  const defaults = (entries) => {
    const mini = entries.filter((m) => m.value === "gpt-4o-mini" || m.value.endsWith("/gpt-4o-mini"));
    if (campOnly) {
      const cheap = entries.filter((m) => isCampLowCost(m.value) || isCampLowCost(m.label));
      return (mini.length ? mini : cheap).slice(0, 1).map((m) => m.value);
    }
    return mini.map((m) => m.value);
  };
  // 폼은 데이터보다 먼저 만들어질 수 있다. 모델 목록이 처음 도착하면 기본 선택을 넣는다.
  let seeded = false;
  const apply = (checked = null) => {
    const entries = providerEntries(select.value);
    const useDefault = checked == null || (!seeded && entries.length > 0 && checked.length === 0);
    box.innerHTML = chipsHtml(name, entries, useDefault ? defaults(entries) : checked, { campOnly });
    if (entries.length) seeded = true;
    if (hint) {
      const p = providerById(select.value);
      const example = p?.models?.[0]?.call_name || "gpt-4o-mini";
      hint.innerHTML = p?.kind === "pool"
        ? `묶음입니다. 학생 코드의 <code>model</code> 은 <code>${esc(example)}</code> 이고, 정한 비율대로 여러 키에 나뉩니다.`
        : p?.slug
          ? `학생 코드의 <code>model</code> 은 <code>${esc(example)}</code> 처럼 <code>${esc(p.slug)}/</code> 로 시작합니다.`
          : `기본 키는 모델 이름 그대로 씁니다. 예: <code>gpt-4o-mini</code>`;
    }
    box.dispatchEvent(new Event("change", { bubbles: true }));
  };
  select.addEventListener("change", () => apply(null));
  apply(null);
  return {
    refresh(checked = null) {
      const cur = select.value;
      select.innerHTML = providerOptions(cur, { pools: select.dataset.pools !== "no" });
      if ([...select.options].some((o) => o.value === cur)) select.value = cur;
      apply(checked);
    },
    set(providerId, checked) {
      if ([...select.options].some((o) => o.value === providerId)) select.value = providerId;
      apply(checked);
    },
    read: () => readChecked(name, box),
  };
}

// ---------------------------------------------------------------- 시간표 편집기
const DAY_CHOICES = [1, 2, 3, 4, 5, 6, 7];

function rowHtml(row) {
  const days = new Set((row.days || []).map(Number));
  return `<div class="sched-row">
    <span class="days" role="group" aria-label="요일">${DAY_CHOICES.map((d) => `<label class="day"><input type="checkbox" value="${d}" ${days.has(d) ? "checked" : ""}><span>${DAY_NAMES[d]}</span></label>`).join("")}</span>
    <input class="s-start" type="time" value="${esc(row.start || "09:00")}" aria-label="시작">
    <span class="muted">–</span>
    <input class="s-end" type="time" value="${esc(row.end || "16:30")}" aria-label="끝">
    <button type="button" class="btn xs ghost s-del" aria-label="이 시간대 빼기">빼기</button>
  </div>`;
}

function weekHtml(rows) {
  const now = seoulParts();
  const cover = (d, h) => rows.some((w) => {
    if (!(w.days || []).includes(d)) return false;
    const [sh, sm] = String(w.start || "").split(":").map(Number);
    const [eh, em] = String(w.end || "").split(":").map(Number);
    if (![sh, sm, eh, em].every(Number.isFinite)) return false;
    const s = sh * 60 + sm;
    const e = eh * 60 + em;
    return s < (h + 1) * 60 && e > h * 60;
  });
  let html = '<div class="week" aria-hidden="true"><span></span>';
  for (let h = 0; h < 24; h++) html += `<span class="h">${h % 6 === 0 ? h : ""}</span>`;
  for (const d of DAY_CHOICES) {
    html += `<span class="d">${DAY_NAMES[d]}</span>`;
    for (let h = 0; h < 24; h++) {
      const cls = `${cover(d, h) ? "on" : ""} ${d === now.isoDay && h === now.hh ? "now" : ""}`;
      html += `<span class="c ${cls}"></span>`;
    }
  }
  return html + "</div>";
}

/**
 * 시간표 편집기. 비우면 "항상". read() 는 서버 lib/schedule.js 가 받는 모양을 돌려준다.
 */
export function scheduleEditor(container, rows = [], { note = "비우면 항상 허용됩니다. 한국(서울) 시간 기준." } = {}) {
  container.innerHTML = `<div class="sched">
    <div class="sched-rows"></div>
    <div class="row"><button type="button" class="btn xs s-add">+ 시간대 추가</button><span class="muted" style="font-size:12px">${esc(note)}</span></div>
    <div class="sched-week"></div>
  </div>`;
  const list = container.querySelector(".sched-rows");
  const week = container.querySelector(".sched-week");
  const read = () => $$(".sched-row", list).map((r) => ({
    days: $$('.day input:checked', r).map((c) => Number(c.value)),
    start: r.querySelector(".s-start").value,
    end: r.querySelector(".s-end").value,
  })).filter((r) => r.days.length || r.start || r.end);
  const paint = () => {
    const rows2 = read();
    week.innerHTML = rows2.length ? weekHtml(rows2) : "";
  };
  const set = (next) => {
    list.innerHTML = (next || []).map(rowHtml).join("");
    paint();
  };
  container.addEventListener("click", (ev) => {
    if (ev.target.closest(".s-add")) {
      list.insertAdjacentHTML("beforeend", rowHtml({ days: [1, 2, 3, 4, 5], start: "09:00", end: "16:30" }));
      paint();
    } else if (ev.target.closest(".s-del")) {
      ev.target.closest(".sched-row").remove();
      paint();
    }
  });
  container.addEventListener("change", paint);
  container.addEventListener("input", paint);
  set(rows);
  return { read, set };
}

export function weekPreview(rows) {
  return (rows && rows.length) ? weekHtml(rows) : "";
}

// 폼 안의 값 읽기
export const val = (root, sel) => {
  const el = $(sel, root);
  return el ? el.value.trim() : "";
};
