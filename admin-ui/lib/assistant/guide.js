// 모델 목록에 "엘피 일을 얼마나 잘할지" 표시를 붙인다. 이름·크기·도구 지원으로 어림한다.
// grade: 3 추천/좋음 · 2 쓸 만함 · 1 가벼움(간단한 요약만) · 0 도구 없음(대화만)

function openaiGrade(id) {
  const s = id.toLowerCase();
  if (/^(chatgpt-|o1-mini|o1-preview)/.test(s)) return [0, "대화만", "도구 호출을 지원하지 않습니다"];
  if (/^gpt-5(\.\d+)?-mini/.test(s)) return [3, "추천", "똑똑하고 저렴합니다 (추론형이라 조금 느릴 수 있음)"];
  if (/^gpt-4\.1-mini/.test(s)) return [3, "추천", "빠르고 도구 호출이 정확합니다"];
  if (/^gpt-4o-mini/.test(s)) return [2, "저렴", "가장 싸고 쓸 만합니다. 여러 단계 요청은 가끔 틀립니다"];
  if (/nano/.test(s)) return [1, "가벼움", "아주 싸지만 복잡한 요청은 부정확합니다"];
  if (/^gpt-3\.5/.test(s)) return [1, "구형", "오래된 모델입니다"];
  if (/^(gpt-5|gpt-4\.1|gpt-4o|o3|o4)/.test(s)) return [3, "고급", "정확하지만 mini 보다 비쌉니다"];
  return [2, "", ""];
}

function ollamaGrade(m) {
  const id = String(m.id || "").toLowerCase();
  const b = Number(m.params_b);
  if (m.tools === false) return [0, "대화만", "이 모델은 도구 호출을 지원하지 않습니다. 요약·상담만 됩니다"];
  const known = /(qwen3|qwen2\.5|gpt-oss|gemma4|llama3\.[1-3]|llama4|mistral-small|mistral-nemo|command-r|granite3|granite4|hermes|devstral|exaone|kanana)/.test(id);
  if (Number.isFinite(b)) {
    if (b < 3) return [1, "가벼움", "짧은 요약만 권장, 제어 제안은 부정확할 수 있습니다"];
    if (b < 7) return [1, "가벼움", "간단한 질문은 되지만 여러 단계 요청은 자주 틀립니다"];
    if (b < 13) return [known ? 3 : 2, known ? "추천" : "쓸 만함", "조회·요약·제안에 충분합니다 (GPU 8GB 이상 권장)"];
    return [3, "좋음", "여러 단계 요청도 안정적입니다 (GPU 16GB·Apple M 칩 32GB 이상 권장)"];
  }
  return [m.tools ? 2 : 1, m.tools ? "도구 지원" : "", "크기를 알 수 없습니다"];
}

function gradeModels(models, provider) {
  return (models || []).map((m) => {
    const [grade, badge, note] = provider === "openai" ? openaiGrade(m.id)
      : provider === "ollama" ? ollamaGrade(m)
      : m.tools === false ? [0, "대화만", "도구 호출을 지원하지 않습니다"] : [2, "", ""];
    return { ...m, grade, badge, note };
  }).sort((a, b) => b.grade - a.grade || String(a.id).localeCompare(String(b.id)));
}

module.exports = { gradeModels, openaiGrade, ollamaGrade };
