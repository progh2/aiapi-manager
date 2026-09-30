// 관리 작업 기록. JSON Lines 파일에 한 줄씩 붙이고 최근 N건만 메모리에 둔다.
// 비밀 키는 남기지 않는다. 기록이 실패해도 관리 작업 자체는 막지 않는다.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_MAX = 5000;
// 이름에 이런 말이 들어간 값은 기록하지 않는다. key_alias 는 별칭이라 남긴다.
const SECRET_RE = /(^|_)(key|api_key|secret|password|master_key|token)$/i;
const KEEP = new Set(["key_alias", "key_aliases"]);

function sanitizeDetail(detail, depth = 0) {
  if (detail == null) return null;
  if (typeof detail !== "object") return String(detail).slice(0, 500);
  if (depth > 2) return null;
  if (Array.isArray(detail)) return detail.slice(0, 50).map((v) => sanitizeDetail(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(detail)) {
    if (SECRET_RE.test(k) && !KEEP.has(k)) continue;
    if (v === undefined) continue;
    out[k] = typeof v === "object" && v !== null ? sanitizeDetail(v, depth + 1) : v;
  }
  return out;
}

class AuditLog {
  constructor(filePath, { maxEntries = DEFAULT_MAX } = {}) {
    this.filePath = filePath;
    this.maxEntries = Math.max(10, Number(maxEntries) || DEFAULT_MAX);
    this.entries = [];
    this.fileLines = 0;
    this.skipped = 0;
    this.load();
  }

  load() {
    this.entries = [];
    this.fileLines = 0;
    this.skipped = 0;
    let raw = "";
    try {
      if (!fs.existsSync(this.filePath)) return;
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (e) {
      console.error("audit 기록을 읽지 못했습니다:", e.message);
      return;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      this.fileLines += 1;
      try {
        const entry = JSON.parse(line);
        if (entry && entry.at && entry.action) this.entries.push(entry);
        else this.skipped += 1;
      } catch {
        // 반쯤 쓰인 줄은 건너뛴다. 파일은 다음 정리 때 다시 쓴다.
        this.skipped += 1;
      }
    }
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  append({ actor, action, target = null, detail = null, ok = true, at = new Date() } = {}) {
    if (!action) throw new Error("action이 필요합니다");
    const entry = {
      id: crypto.randomBytes(6).toString("hex"),
      at: (at instanceof Date ? at : new Date(at)).toISOString(),
      actor: actor || null,
      action: String(action),
      target: target == null ? null : String(target).slice(0, 200),
      ok: ok !== false,
      detail: sanitizeDetail(detail),
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
      this.fileLines += 1;
      // 파일이 보관 한도보다 한참 길어지면 최근 것만 남기고 다시 쓴다.
      if (this.fileLines > this.maxEntries * 1.25) this.compact();
    } catch (e) {
      console.error("audit 기록을 쓰지 못했습니다:", e.message);
    }
    return entry;
  }

  compact() {
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const body = this.entries.map((e) => JSON.stringify(e)).join("\n") + (this.entries.length ? "\n" : "");
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, this.filePath);
    this.fileLines = this.entries.length;
    this.skipped = 0;
  }

  list({ limit = 100, action = "", actor = "", q = "" } = {}) {
    const n = Math.min(1000, Math.max(1, Number(limit) || 100));
    const needle = String(q || "").trim().toLowerCase();
    const out = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < n; i--) {
      const e = this.entries[i];
      if (action && !e.action.startsWith(action)) continue;
      if (actor && e.actor !== actor) continue;
      if (needle) {
        const hay = `${e.action} ${e.actor || ""} ${e.target || ""} ${JSON.stringify(e.detail || "")}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      out.push(e);
    }
    return out;
  }

  size() {
    return this.entries.length;
  }
}

module.exports = { AuditLog, sanitizeDetail, DEFAULT_MAX };
