// 발급 전에 별칭이 이미 있는지 본다. 집합은 바꾸지 않는다.
// 발급에 성공한 뒤에만 호출자가 별칭을 넣어야 같은 요청의 다음 줄이 건너뛴다.

function checkAlias(existing, alias) {
  const name = String(alias || "").trim();
  if (!name) return { alias: name, error: "별칭이 필요합니다" };
  if (existing.has(name)) return { alias: name, error: "이미 있는 별칭", skipped: true };
  return { alias: name };
}

module.exports = { checkAlias };
