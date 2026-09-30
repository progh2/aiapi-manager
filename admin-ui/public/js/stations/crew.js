// 07 사용자. 구글 계정 등록, 연결 키 수정(검색되는 별칭 선택기), 삭제.
import { $, $$, esc, icon, fmtDate } from "../lib/util.js";
import { state, loadUsers, teamName } from "../lib/store.js";
import { toast, toastError, modal, confirmDialog, busy } from "../lib/ui.js";

function aliasPicker(container, selected = []) {
  const chosen = new Set(selected);
  const aliases = state.keys.map((k) => ({ alias: k.key_alias, team: teamName(k.team_id) })).filter((a) => a.alias && !/-폐기(-\d+)?$/.test(a.alias))
    .sort((a, b) => a.alias.localeCompare(b.alias, "ko", { numeric: true }));
  container.innerHTML = `
    <div class="row" style="margin-bottom:8px"><label class="search" style="flex:1"><svg><use href="#i-cmd"/></svg><input type="search" class="ap-q" placeholder="별칭·학급 검색"></label><span class="muted ap-n" style="font-size:12px"></span></div>
    <div class="chips ap-list" style="max-height:220px;overflow:auto;padding:2px"></div>`;
  const paint = () => {
    const q = container.querySelector(".ap-q").value.trim().toLowerCase();
    const list = aliases.filter((a) => !q || `${a.alias} ${a.team}`.toLowerCase().includes(q) || chosen.has(a.alias));
    container.querySelector(".ap-list").innerHTML = list.slice(0, 300).map((a) => `<label class="chip ${chosen.has(a.alias) ? "on" : ""}"><input type="checkbox" value="${esc(a.alias)}" ${chosen.has(a.alias) ? "checked" : ""}>${esc(a.alias)}${a.team ? ` <small>${esc(a.team)}</small>` : ""}</label>`).join("") || '<span class="muted">발급된 키가 없습니다</span>';
    container.querySelector(".ap-n").textContent = `${chosen.size}개 선택`;
  };
  container.querySelector(".ap-q").addEventListener("input", paint);
  container.querySelector(".ap-list").addEventListener("change", (ev) => {
    if (ev.target.checked) chosen.add(ev.target.value); else chosen.delete(ev.target.value);
    container.querySelector(".ap-n").textContent = `${chosen.size}개 선택`;
  });
  paint();
  return { read: () => [...chosen] };
}

export default {
  id: "crew",
  deps: ["users", "keys"],
  init(root, ctx) {
    this.ctx = ctx;
    root.innerHTML = `
      <div class="st-inner">
        <div class="st-head">
          <div class="ttl"><div class="code">STATION 07 · CREW</div><h1>사용자</h1>
            <p>여기 등록한 구글 계정만 로그인합니다. 학생·교사는 연결된 키의 사용량과 최근 호출만 보고, 키 문자열은 보지 못합니다. 관리자는 <code>.env</code> 의 <code>ADMIN_EMAILS</code> 입니다.</p></div>
          <div class="tools"><button class="btn primary" type="button" id="cr-new">${icon("plus")}사용자 등록</button></div>
        </div>
        <section class="panel">
          <div class="row" style="margin-bottom:10px"><label class="search"><svg><use href="#i-cmd"/></svg><input id="cr-q" type="search" placeholder="이름·이메일·키 검색"></label><span class="muted" id="cr-count" style="font-size:12px"></span></div>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th>이름</th><th>구글 이메일</th><th>연결된 키</th><th>등록</th><th class="r">작업</th></tr></thead><tbody id="cr-rows"></tbody></table></div>
        </section>
      </div>`;
    root.querySelector("#cr-new").addEventListener("click", () => this.openForm(null));
    root.querySelector("#cr-q").addEventListener("input", () => this.render());
    root.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-act]");
      if (!b) return;
      const u = state.users.find((x) => x.email === b.dataset.email);
      if (!u) return;
      if (b.dataset.act === "edit") this.openForm(u);
      else if (b.dataset.act === "delete") this.remove(u);
    });
  },
  enter() {
    if (!state.loaded.users) loadUsers().catch((e) => toastError(e));
    this.render();
  },
  refresh() { this.render(); },
  render() {
    const q = $("#cr-q").value.trim().toLowerCase();
    const list = state.users.filter((u) => !q || `${u.name} ${u.email} ${(u.key_aliases || []).join(" ")}`.toLowerCase().includes(q));
    $("#cr-count").textContent = `${list.length}명`;
    const known = new Set(state.keys.map((k) => k.key_alias));
    $("#cr-rows").innerHTML = list.map((u) => `<tr>
      <td><b>${esc(u.name)}</b></td>
      <td class="sec">${esc(u.email)}</td>
      <td><div class="chips">${(u.key_aliases || []).map((a) => `<span class="tag ${known.has(a) ? "info" : "mute"}" title="${known.has(a) ? "" : "지금은 없는 키"}">${esc(a)}</span>`).join("") || '<span class="muted">없음</span>'}</div></td>
      <td class="nowrap muted" style="font-size:12px">${u.created_at ? fmtDate(u.created_at) : "—"}${u.created_by ? `<br>${esc(u.created_by)}` : ""}</td>
      <td class="act"><button class="btn xs" type="button" data-act="edit" data-email="${esc(u.email)}">${icon("edit")}수정</button> <button class="btn xs danger" type="button" data-act="delete" data-email="${esc(u.email)}" aria-label="삭제">${icon("trash")}</button></td>
    </tr>`).join("") || `<tr><td colspan="5" class="tbl-empty">${state.loaded.users ? "등록된 사용자가 없습니다." : "불러오는 중…"}</td></tr>`;
  },
  openForm(u) {
    const editing = Boolean(u);
    const body = `
      <div class="form-grid">
        <label class="field"><span>구글 이메일 <span class="req">*</span></span><input id="u-email" type="email" value="${esc(u ? u.email : "")}" ${editing ? "readonly" : "autofocus"} placeholder="student@school.edu"></label>
        <label class="field"><span>이름</span><input id="u-name" value="${esc(u ? u.name : "")}" placeholder="홍길동"></label>
      </div>
      <div class="field" style="margin-top:12px"><span>연결할 키 별칭</span><div id="u-aliases"></div><span class="hint">연결한 키의 사용량·최근 호출만 보입니다.</span></div>`;
    modal({
      title: editing ? `사용자 수정 — ${u.email}` : "사용자 등록", code: editing ? "CREW · EDIT" : "CREW · ENLIST", body, size: "wide",
      onOpen: (h) => { h.picker = aliasPicker(h.el.querySelector("#u-aliases"), u ? u.key_aliases || [] : []); },
      actions: [
        { label: "취소", tone: "ghost", value: null },
        {
          label: editing ? "저장" : "등록", tone: "primary",
          onClick: async (h) => {
            const email = h.el.querySelector("#u-email").value.trim();
            if (!email) { toast("이메일을 입력하세요", { tone: "warn" }); return false; }
            try {
              await this.ctx.api(editing ? "/api/users/update" : "/api/users", { method: "POST", body: { email, name: h.el.querySelector("#u-name").value.trim(), key_aliases: h.picker.read() } });
              toast(editing ? "저장했습니다" : `${email} 등록`, { tone: "good" });
              await loadUsers();
            } catch (e) { toastError(e, "저장하지 못했습니다"); return false; }
            return true;
          },
        },
      ],
    });
  },
  async remove(u) {
    const ok = await confirmDialog({ title: `'${u.email}' 삭제`, message: "이 계정은 더 이상 로그인할 수 없습니다. 연결된 키 자체는 지우지 않습니다.", confirmLabel: "삭제", tone: "danger" });
    if (!ok) return;
    try {
      await this.ctx.api("/api/users/delete", { method: "POST", body: { email: u.email } });
      toast("삭제했습니다", { tone: "good" });
      await loadUsers();
    } catch (e) { toastError(e); }
  },
};
