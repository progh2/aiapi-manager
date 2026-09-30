// 학생 차트 오른쪽 숫자·툴팁 문구. remaining은 예산이 있을 때만 온다.
// 1센트 미만은 유효 숫자 2자리까지 적는다. 셋째 자리 반올림이면 아주 싼 모델 호출이 $0.000 으로 보인다.
const tiny = (v) => v.toFixed(Math.min(8, 1 - Math.floor(Math.log10(v)))).replace(/0+$/, "").replace(/\.$/, "");
export const money = (v) => "$" + (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v >= 0.01 || v <= 0 ? v.toFixed(3) : tiny(v));

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
