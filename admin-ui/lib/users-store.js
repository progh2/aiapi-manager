// 등록 사용자 목록을 JSON 파일로 저장한다.
const fs = require("fs");
const path = require("path");

class UsersStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { users: [] };
    this.load();
  }

  load() {
    this.corrupt = false;
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!parsed || !Array.isArray(parsed.users)) throw new Error("users 배열이 없습니다");
      this.data = parsed;
    } catch (e) {
      // 깨진 파일을 빈 목록으로 바꾸지 않는다. save()가 거절한다.
      console.error("users.json 로드 실패:", e.message);
      this.corrupt = true;
      this.data = { users: [] };
    }
  }

  isCorrupt() {
    return Boolean(this.corrupt);
  }

  save() {
    if (this.corrupt) {
      throw new Error("users.json이 손상되어 저장할 수 없습니다. 파일을 복구한 뒤 다시 시작하세요.");
    }
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  list() {
    return this.data.users;
  }

  get(email) {
    return this.data.users.find((u) => u.email === email.toLowerCase());
  }

  add(user, by) {
    const email = user.email.toLowerCase().trim();
    if (!email) throw new Error("이메일이 필요합니다");
    if (this.get(email)) throw new Error("이미 등록된 이메일입니다");
    const record = {
      email,
      name: (user.name || email.split("@")[0]).trim(),
      key_aliases: Array.isArray(user.key_aliases) ? user.key_aliases : [],
      created_at: new Date().toISOString(),
      created_by: by,
    };
    this.data.users.push(record);
    this.save();
    return record;
  }

  update(email, patch) {
    const u = this.get(email);
    if (!u) throw new Error("사용자를 찾을 수 없습니다");
    if (patch.name !== undefined) u.name = String(patch.name).trim() || u.name;
    if (patch.key_aliases !== undefined) {
      u.key_aliases = Array.isArray(patch.key_aliases) ? patch.key_aliases : u.key_aliases;
    }
    this.save();
    return u;
  }

  remove(email) {
    const i = this.data.users.findIndex((u) => u.email === email.toLowerCase());
    if (i < 0) throw new Error("사용자를 찾을 수 없습니다");
    this.data.users.splice(i, 1);
    this.save();
  }
}

module.exports = { UsersStore };
