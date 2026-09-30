// 학생이 로그인해 자기 키를 다시 볼 수 있게, 발급 때 받은 키 원문을 암호화해 보관한다.
// LiteLLM 은 키 원문을 저장하지 않고 sha256 해시(token)만 남긴다. 보관함의 이름표도 같은 해시라
// /key/list 의 token 으로 바로 찾는다.
// 암호화: AES-256-GCM. 비밀 값(KEY_VAULT_SECRET, 없으면 LITELLM_MASTER_KEY)이 바뀌면 옛 항목은 풀리지 않는다.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const hashKey = (key) => crypto.createHash("sha256").update(String(key)).digest("hex");

class KeyVault {
  constructor(filePath, secret) {
    if (!secret) throw new Error("키 보관함 비밀 값이 필요합니다");
    this.filePath = filePath;
    this.aesKey = crypto.createHash("sha256").update(`aiapi-key-vault:${secret}`).digest();
    this.entries = {};
    this.corrupt = false;
    this.load();
  }

  load() {
    this.corrupt = false;
    this.entries = {};
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!parsed || typeof parsed.entries !== "object" || Array.isArray(parsed.entries)) throw new Error("entries 가 없습니다");
      this.entries = parsed.entries;
    } catch (e) {
      // 깨진 파일을 빈 보관함으로 덮어쓰지 않는다.
      console.error("key-vault.json 로드 실패:", e.message);
      this.corrupt = true;
    }
  }

  isCorrupt() {
    return this.corrupt;
  }

  save() {
    if (this.corrupt) throw new Error("key-vault.json 이 손상되어 저장할 수 없습니다");
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: this.entries }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  /** 키 원문을 보관하고 해시(token)를 돌려준다. */
  put(key, { alias = null } = {}) {
    const plain = String(key || "");
    if (!plain) throw new Error("키가 비어 있습니다");
    const token = hashKey(plain);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.aesKey, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    this.entries[token] = {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
      // 끝 네 글자는 LiteLLM 도 key_name 으로 보여 주는 값이라 가린 표시용으로 따로 둔다.
      hint: plain.slice(-4),
      alias: alias || null,
      at: new Date().toISOString(),
    };
    this.save();
    return token;
  }

  has(token) {
    return Boolean(token && this.entries[token]);
  }

  hint(token) {
    const e = token && this.entries[token];
    return e ? e.hint || null : null;
  }

  /** 원문을 돌려준다. 없거나 풀리지 않으면 null. */
  get(token) {
    const e = token && this.entries[token];
    if (!e) return null;
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.aesKey, Buffer.from(e.iv, "base64"));
      decipher.setAuthTag(Buffer.from(e.tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(e.data, "base64")), decipher.final()]).toString("utf8");
      return hashKey(plain) === token ? plain : null;
    } catch {
      return null;
    }
  }

  remove(tokens) {
    let n = 0;
    for (const t of Array.isArray(tokens) ? tokens : [tokens]) {
      if (t && this.entries[t]) {
        delete this.entries[t];
        n += 1;
      }
    }
    if (n) this.save();
    return n;
  }

  size() {
    return Object.keys(this.entries).length;
  }
}

module.exports = { KeyVault, hashKey };
