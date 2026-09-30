// 명단에 이메일이 있으면 학생 계정을 등록하거나 키를 연결한다.
// 학생은 그 구글 계정으로 로그인해 조종석에서 자기 키를 본다.

/**
 * @param {UsersStore} usersStore
 * @param {Array} rows   assignClassBudgets() 결과 줄. email·alias·key(발급 성공)·skipped(이미 있는 별칭)
 * @param {object} o     by: 등록한 관리자, adminEmails: 관리자 이메일 Set(학생 계정으로 만들지 않는다)
 * 줄마다 account 를 붙인다: created · linked · unchanged · admin · error
 */
function linkStudentAccounts(usersStore, rows, { by = null, adminEmails = new Set() } = {}) {
  const out = { created: 0, linked: 0, unchanged: 0, failed: 0 };
  for (const r of rows || []) {
    if (!r || !r.email || !r.alias) continue;
    // 발급했거나 이미 있던 별칭일 때만 연결한다. 해석 실패·발급 실패 줄은 건드리지 않는다.
    if (!r.key && !r.skipped) continue;
    const email = String(r.email).toLowerCase();
    if (adminEmails.has(email)) {
      r.account = "admin";
      continue;
    }
    try {
      if (usersStore.isCorrupt()) throw new Error("users.json 이 손상되어 계정을 등록하지 못했습니다");
      const user = usersStore.get(email);
      if (!user) {
        usersStore.add({ email, name: r.name || r.alias, key_aliases: [r.alias] }, by);
        r.account = "created";
        out.created += 1;
      } else if (!(user.key_aliases || []).includes(r.alias)) {
        usersStore.update(email, { key_aliases: [...(user.key_aliases || []), r.alias] });
        r.account = "linked";
        out.linked += 1;
      } else {
        r.account = "unchanged";
        out.unchanged += 1;
      }
    } catch (e) {
      r.account = "error";
      r.account_error = e.message;
      out.failed += 1;
    }
  }
  return out;
}

module.exports = { linkStudentAccounts };
