// 학생 차트 오른쪽 숫자·툴팁 문구. remaining은 예산이 있을 때만 온다.
export const money = (v) => "$" + (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(3));

export const hasRemaining = (d) => d != null && d.remaining != null && Number.isFinite(Number(d.remaining));

export function remainingPhrase(remaining) {
  const n = Number(remaining);
  return n < 0 ? `초과 ${money(-n)}` : `잔여 ${money(n)}`;
}

export function remainingTipLine(remaining) {
  const n = Number(remaining);
  return n < 0 ? `잔여 -${money(-n)} (초과)` : `잔여 ${money(n)}`;
}

export function rankValueText(d, { valueKey = "spend", compact = false } = {}) {
  const spendTxt = money(d[valueKey]);
  const budgetTxt = d.budget ? ` / ${money(d.budget)}` : "";
  const over = d.budget && d[valueKey] >= d.budget;
  if (hasRemaining(d)) {
    return remainingPhrase(d.remaining) + (compact ? "" : ` · ${spendTxt}${budgetTxt}`);
  }
  return spendTxt + budgetTxt + (over ? " 초과" : "");
}
