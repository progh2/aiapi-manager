// 학급 명단 파서 + LiteLLM duration 변환.
// 서버(require)와 브라우저(<script src="/roster.js">)에서 같이 쓴다.
// CLI `name,student_id` 와 UI `학번,이름` 둘 다 받는다.

const NAME_HEADERS = new Set([
  "name", "이름", "성명", "학생", "학생이름", "student_name", "studentname",
]);
const ID_HEADERS = new Set([
  "student_id", "studentid", "학번", "id", "번호", "sid",
]);

function aliasFor(studentId, name) {
  const id = String(studentId || "").trim();
  const n = String(name || "").trim();
  if (id && n) return `${id}-${n}`;
  return id || n;
}

function normalizeHeader(h) {
  return String(h || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function splitLine(line) {
  const t = String(line || "").replace(/^\uFEFF/, "").trim();
  if (!t) return [];
  if (t.includes(",")) return t.split(",").map((c) => c.trim());
  if (t.includes("\t")) return t.split("\t").map((c) => c.trim());
  return t.split(/[ ]+/).map((c) => c.trim()).filter(Boolean);
}

function looksLikeId(value) {
  return /^\d{4,}$/.test(String(value || "").trim());
}

function headerRoles(cells) {
  const norms = cells.map(normalizeHeader);
  const nameIdx = norms.findIndex((h) => NAME_HEADERS.has(h));
  const idIdx = norms.findIndex((h) => ID_HEADERS.has(h));
  if (nameIdx >= 0 && idIdx >= 0) return { nameIdx, idIdx };
  return null;
}

function rowFromCells(cells, roles, line) {
  const raw = cells.join(",");
  if (!cells.length) return { error: { line, raw, error: "빈 줄" } };
  let student_id = "";
  let name = "";
  if (roles) {
    student_id = cells[roles.idIdx] || "";
    name = cells[roles.nameIdx] || "";
  } else if (cells.length === 1) {
    const only = cells[0];
    if (only.includes("-")) {
      const i = only.indexOf("-");
      student_id = only.slice(0, i).trim();
      name = only.slice(i + 1).trim();
    } else if (looksLikeId(only)) {
      student_id = only;
    } else {
      name = only;
    }
  } else if (looksLikeId(cells[0])) {
    student_id = cells[0];
    name = cells.slice(1).join(" ").trim();
  } else if (looksLikeId(cells[1])) {
    name = cells[0];
    student_id = cells[1];
  } else {
    // 헤더 없는 CLI 관례: name,student_id
    name = cells[0];
    student_id = cells[1];
  }
  student_id = String(student_id || "").trim();
  name = String(name || "").trim();
  if (!student_id && !name) {
    return { error: { line, raw, error: "학번 또는 이름이 필요합니다" } };
  }
  return {
    student: {
      student_id: student_id || null,
      name: name || null,
      alias: aliasFor(student_id, name),
    },
  };
}

/**
 * 명단 텍스트를 학생 배열로 바꾼다.
 * @returns {{ students: Array<{student_id: string|null, name: string|null, alias: string}>, errors: Array<{line: number, raw?: string, alias?: string, error: string}> }}
 */
function parseRoster(text) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const students = [];
  const errors = [];
  let roles = null;
  let started = false;
  let lineNo = 0;

  for (const rawLine of lines) {
    lineNo += 1;
    if (!rawLine.trim()) continue;
    const cells = splitLine(rawLine);
    if (!cells.length) continue;

    if (!started) {
      const header = headerRoles(cells);
      if (header) {
        roles = header;
        started = true;
        continue;
      }
    }
    started = true;
    const parsed = rowFromCells(cells, roles, lineNo);
    if (parsed.error) errors.push(parsed.error);
    else students.push(parsed.student);
  }

  return { students, errors };
}

/**
 * 기존 POST /api/keys/bulk 의 students 배열을 같은 형태로 맞춘다.
 */
function normalizeStudentList(students) {
  if (!Array.isArray(students) || !students.length) {
    return { students: [], errors: [] };
  }
  const out = [];
  const errors = [];
  students.forEach((s, i) => {
    const line = i + 1;
    if (!s || typeof s !== "object") {
      errors.push({ line, error: "학생 항목이 올바르지 않습니다" });
      return;
    }
    if (s.alias && String(s.alias).trim()) {
      out.push({
        alias: String(s.alias).trim(),
        student_id: s.student_id != null ? String(s.student_id).trim() || null : null,
        name: s.name != null ? String(s.name).trim() || null : null,
      });
      return;
    }
    const id = s.student_id != null ? String(s.student_id).trim() : "";
    const name = s.name != null ? String(s.name).trim() : "";
    if (!id && !name) {
      errors.push({ line, error: "alias 또는 학번/이름이 필요합니다" });
      return;
    }
    out.push({ student_id: id || null, name: name || null, alias: aliasFor(id, name) });
  });
  return { students: out, errors };
}

/**
 * 달력 만료일(YYYY-MM-DD, 그날 23:59:59 로컬)을 LiteLLM duration 문자열로 바꾼다.
 * /key/generate 는 duration("30s"|"30m"|"30h"|"30d")만 받고 expires 입력은 없다.
 */
function durationFromExpiryDate(dateStr, now = new Date()) {
  const m = String(dateStr || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    const err = new Error("만료일은 YYYY-MM-DD 형식이어야 합니다");
    err.status = 400;
    throw err;
  }
  const end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  const ms = end.getTime() - now.getTime();
  if (ms <= 0) {
    const err = new Error("만료일은 오늘 이후여야 합니다");
    err.status = 400;
    throw err;
  }
  return `${Math.max(1, Math.ceil(ms / 1000))}s`;
}

const Roster = {
  NAME_HEADERS,
  ID_HEADERS,
  aliasFor,
  normalizeHeader,
  parseRoster,
  normalizeStudentList,
  durationFromExpiryDate,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = Roster;
}
if (typeof window !== "undefined") {
  window.Roster = Roster;
}
