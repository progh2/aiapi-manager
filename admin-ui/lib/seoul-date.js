// 사용량 집계의 하루는 학교 달력(Asia/Seoul) 기준이다.
const SEOUL = "Asia/Seoul";

function seoulParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SEOUL,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

function fmtYmd({ y, m, d }) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function addDays(parts, n) {
  const dt = new Date(Date.UTC(parts.y, parts.m - 1, parts.d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function seoulToday(now = new Date()) {
  return seoulParts(now);
}

function ymdInSeoul(date) {
  return fmtYmd(seoulParts(date));
}

function seoulDateRange(days, horizon, now = new Date()) {
  const end = seoulToday(now);
  const start = addDays(end, -(days - 1));
  const dates = [];
  for (let i = 0; i < days; i++) dates.push(fmtYmd(addDays(start, i)));
  const futureDates = [];
  for (let i = 1; i <= horizon; i++) futureDates.push(fmtYmd(addDays(end, i)));
  return { start: fmtYmd(start), end: fmtYmd(end), dates, futureDates };
}

module.exports = { ymdInSeoul, seoulDateRange, fmtYmd, addDays };
