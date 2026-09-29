// 외부 LLM 으로 보낼 때 학생 이름을 가린다. "20261001-홍길동" → "20261001-학생07".
// 서버가 LLM 의 답과 도구 인자를 되돌려(unmask) 화면에는 원래 이름이 보인다.

const NAME_RE = /^[가-힣]{2,4}$/;
// 별칭에 자주 들어가지만 사람 이름이 아닌 말
const STOP = new Set([
  "폐기", "교사", "시연", "실습", "캠프", "동아리", "캡스톤", "학급", "학생", "테스트", "검증", "기본",
  "수업", "선생님", "관리자", "담임", "시험", "연습", "예시", "샘플", "대회", "방과후",
]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function namesFrom({ keys = [], users = [] } = {}) {
  const out = new Set();
  for (const k of keys) {
    const parts = String((k && k.key_alias) || "").split("-");
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i].trim();
      if (NAME_RE.test(p) && !STOP.has(p)) out.add(p);
    }
  }
  for (const u of users) {
    const n = String((u && u.name) || "").trim();
    if (NAME_RE.test(n) && !STOP.has(n)) out.add(n);
  }
  return [...out];
}

class NameMask {
  constructor(names = []) {
    const list = [...new Set(names)].sort((a, b) => a.localeCompare(b, "ko"));
    const width = list.length >= 100 ? 3 : 2;
    this.toCode = new Map(list.map((n, i) => [n, `학생${String(i + 1).padStart(width, "0")}`]));
    this.toName = new Map([...this.toCode].map(([n, c]) => [c, n]));
    const byLen = (a, b) => b.length - a.length;
    const names2 = [...this.toCode.keys()].sort(byLen);
    const codes = [...this.toName.keys()].sort(byLen);
    this.nameRe = names2.length ? new RegExp(names2.map(escapeRe).join("|"), "g") : null;
    this.codeRe = codes.length ? new RegExp(codes.map(escapeRe).join("|"), "g") : null;
  }

  static fromData(data) {
    return new NameMask(namesFrom(data));
  }

  static none() {
    return new NameMask([]);
  }

  get size() {
    return this.toCode.size;
  }

  mask(text) {
    if (text == null) return text;
    return this.nameRe ? String(text).replace(this.nameRe, (m) => this.toCode.get(m)) : String(text);
  }

  unmask(text) {
    if (text == null) return text;
    return this.codeRe ? String(text).replace(this.codeRe, (m) => this.toName.get(m)) : String(text);
  }

  maskDeep(value) {
    return walk(value, (s) => this.mask(s));
  }

  unmaskDeep(value) {
    return walk(value, (s) => this.unmask(s));
  }
}

function walk(value, fn, depth = 0) {
  if (typeof value === "string") return fn(value);
  if (depth > 6 || value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => walk(v, fn, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = walk(v, fn, depth + 1);
  return out;
}

module.exports = { NameMask, namesFrom, STOP };
