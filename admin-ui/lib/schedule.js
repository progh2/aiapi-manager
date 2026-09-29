// 학생 키의 사용 가능 시간대. 서울 시각 기준.
// 비어 있으면 항상 허용. 창이 여러 개면 하나라도 겹치면 허용한다.
// days: 1=월 … 7=일. start/end 는 HH:MM, 종료는 포함하지 않는다.

const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function toMinutes(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || ""));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function seoulParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  const minute = Number(get("minute"));
  return {
    isoDay: WEEKDAY[get("weekday")] || 0,
    minutes: hour * 60 + minute,
  };
}

function normalizeSchedule(input) {
  if (input == null || input === "") return [];
  if (!Array.isArray(input)) throw httpError("사용 시간대는 목록이어야 합니다", 400);
  return input.map((row, i) => {
    const src = row && typeof row === "object" ? row : {};
    const days = [...new Set((src.days || []).map((d) => Number(d)))]
      .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)
      .sort((a, b) => a - b);
    const start = String(src.start || "").trim();
    const end = String(src.end || "").trim();
    const where = `${i + 1}번째 시간대`;
    if (!days.length) throw httpError(`${where}: 요일을 하나 이상 고르세요`, 400);
    const startMin = toMinutes(start);
    const endMin = toMinutes(end);
    if (startMin == null || endMin == null) {
      throw httpError(`${where}: 시작과 종료는 09:00처럼 적으세요`, 400);
    }
    if (startMin >= endMin) {
      throw httpError(`${where}: 종료는 시작보다 뒤여야 합니다`, 400);
    }
    return { days, start, end };
  });
}

function scheduleAllows(schedule, date = new Date()) {
  const windows = Array.isArray(schedule) ? schedule : [];
  if (!windows.length) return true;
  const now = seoulParts(date);
  return windows.some((w) => {
    const start = toMinutes(w.start);
    const end = toMinutes(w.end);
    if (start == null || end == null) return false;
    return (w.days || []).includes(now.isoDay) && now.minutes >= start && now.minutes < end;
  });
}

function formatSchedule(schedule) {
  const windows = Array.isArray(schedule) ? schedule : [];
  if (!windows.length) return "항상";
  const names = ["", "월", "화", "수", "목", "금", "토", "일"];
  return windows.map((w) => {
    const days = (w.days || []).map((d) => names[d] || "").join("");
    return `${days} ${w.start}–${w.end}`;
  }).join(", ");
}

module.exports = {
  WEEKDAY,
  toMinutes,
  seoulParts,
  normalizeSchedule,
  scheduleAllows,
  formatSchedule,
};
