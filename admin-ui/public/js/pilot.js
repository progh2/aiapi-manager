// 등록 사용자(학생·교사) 조종석. 연결된 키의 상태·사용량·최근 호출·접속 안내만 본다.
import {
  $, esc, icon, money, num, fmtDate, fmtTime, relTime, formatSchedule, scheduleAllows, keyState, stateTag, meterHtml,
  DUR_LABEL, copyText, snippetPython, seoulParts,
} from "./lib/util.js";
import { dailyBarChart, rankBarChart } from "../charts.js";
import { toast, toastError } from "./lib/ui.js";
import { say } from "./lib/holo.js";
import { createElfy } from "./lib/assistant.js";
import { mountSecret } from "./lib/secret.js";

export async function startPilot({ api, me, auth, proxyUrl, scene, settings = {}, saveSettings = () => {} }) {
  const root = $("#pilot");
  root.hidden = false;
  root.innerHTML = `
    <header class="hud">
      <div class="brand" title="AIAPI"><svg class="brand-mark" style="color:var(--hud)"><use href="#i-logo"/></svg><span class="brand-name">AIAPI</span></div>
      <div class="hud-title"><span class="code">COCKPIT · 개인 조종석</span><span class="name">${esc(me.name)}님의 AI API</span></div>
      <div class="hud-spacer"></div>
      <div class="clock"><div class="t num" id="pl-clock">--:--:--</div><div class="d" id="pl-date"></div></div>
      <div class="hud-actions"><div class="who"><span class="em">${esc(me.email)}</span><button class="icon-btn" id="pl-logout" type="button" title="로그아웃">${icon("exit")}</button></div></div>
    </header>
    <main class="stage"><section class="station active" style="transform:none">
      <div class="st-inner">
        <div class="grid" style="grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);align-items:start">
          <section class="panel">
            <div class="holo" id="pl-holo"><div class="holo-fig" style="width:96px;height:96px"><img src="/mascot/holo/elf-usage.webp" alt=""></div><div class="holo-say" style="flex:1"></div></div>
            <div class="tiles" id="pl-summary" style="margin-top:16px"></div>
          </section>
          <section class="panel"><div class="panel-h"><span class="code">ACCESS</span><h2>접속 안내</h2></div>
            <dl class="kv" style="font-size:13px"><dt>base_url</dt><dd><code>${esc(proxyUrl)}</code></dd><dt>model</dt><dd id="pl-model">—</dd></dl>
            <div class="snippet" style="margin-top:10px"><pre id="pl-snippet"></pre><button class="btn xs" type="button" id="pl-copy">${icon("copy")}복사</button></div>
            <div class="row" style="margin-top:8px"><button class="btn sm primary" type="button" id="pl-copy-mine" hidden>${icon("copy")}내 키 넣어 코드 복사</button>
              <p class="help" id="pl-key-help" style="margin:0;flex:1">내 키는 아래 <b>내 키</b> 카드에서 마우스를 올리면 보이고, 복사 버튼으로 복사해요.</p></div>
          </section>
        </div>
        <h3 style="margin:18px 0 10px;font-size:14px" class="sec">내 키</h3>
        <div class="cards" id="pl-keys"></div>
        <div class="row" style="margin:20px 0 10px"><h3 style="margin:0;font-size:14px" class="sec">사용량</h3><span style="flex:1"></span>
          <select id="pl-days" style="width:auto"><option value="14">최근 14일</option><option value="30" selected>최근 30일</option><option value="60">최근 60일</option></select></div>
        <div class="tiles" id="pl-tiles"></div>
        <div class="grid g2" style="margin-top:14px">
          <section class="panel chart-box"><div class="panel-h"><span class="code">DAILY</span><h2>일별 사용</h2></div><div id="pl-daily"></div></section>
          <section class="panel chart-box"><div class="panel-h"><span class="code">BY KEY</span><h2>키별 사용</h2></div><div id="pl-bykey"></div></section>
        </div>
        <section class="panel" style="margin-top:14px"><div class="panel-h"><span class="code">COMMS</span><h2>최근 호출</h2><span class="sub">7일 · 막힌 호출은 이유가 나옵니다</span><span class="end"><button class="btn xs ghost" type="button" id="pl-reload">${icon("refresh")}새로고침</button></span></div>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th>시각</th><th>키</th><th>모델</th><th>결과</th><th class="r">토큰</th><th class="r">금액</th></tr></thead><tbody id="pl-calls"></tbody></table></div></section>
      </div>
    </section></main>
    <footer class="foot" id="pl-foot"><span class="lbl">AIAPI · COCKPIT</span><span class="muted" style="font-size:12px;flex:1">문제가 계속되면 선생님께 이 화면의 실패 이유를 알려 주세요.</span></footer>`;

  $("#pl-logout").onclick = () => auth.signOut().finally(() => location.reload());
  // 내 키 원문은 누를 때만 서버에서 받는다(선생님 작업 기록에 남는다). 이 페이지 메모리에만 둔다.
  const secrets = new Map();
  const revealMine = async (alias, purpose) => {
    if (secrets.has(alias)) return secrets.get(alias);
    const out = await api("/api/my/keys/reveal", { method: "POST", body: { alias, purpose } });
    secrets.set(alias, out.key);
    return out.key;
  };
  const tickClock = () => {
    const p = seoulParts();
    $("#pl-clock").textContent = `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}:${String(p.ss).padStart(2, "0")}`;
    $("#pl-date").textContent = `${p.m}월 ${p.d}일 (${p.weekday})`;
  };
  tickClock();
  setInterval(tickClock, 1000);

  let keys = [];
  const loadKeys = async () => {
    keys = (await api("/api/my/keys")).keys || [];
    const now = Date.now();
    $("#pl-keys").innerHTML = keys.map((k) => {
      const st = keyState(k, now);
      const sched = k.schedule || [];
      const open = scheduleAllows(sched);
      const left = k.max_budget == null ? null : Math.max(0, k.max_budget - (k.spend || 0));
      return `<article class="card">
        <div class="card-h"><div class="ttl">${esc(k.key_alias)}<small>${esc(k.team_alias || "학급 없음")}</small></div><div class="end">${stateTag(st)}</div></div>
        <div><div class="keybox-lbl">${icon("keys")}API 키</div><div class="pl-secret" data-alias="${esc(k.key_alias)}"></div></div>
        ${meterHtml(k.spend, k.max_budget)}
        <dl class="kv" style="font-size:12px">
          <dt>남은 예산</dt><dd class="num">${left == null ? "무제한" : money(left)}</dd>
          <dt>예산 리셋</dt><dd>${esc(DUR_LABEL[k.budget_duration] || "없음")}</dd>
          <dt>만료</dt><dd>${k.expires ? `${fmtDate(k.expires)} (${esc(relTime(k.expires))})` : "무기한"}</dd>
          <dt>쓸 수 있는 모델</dt><dd>${esc((k.models || []).join(", ") || "전체")}</dd>
          <dt>사용 시간</dt><dd>${esc(formatSchedule(sched))}</dd>
          <dt>지금</dt><dd>${open ? '<span class="state"><span class="led good"></span>사용 가능 시간</span>' : '<span class="state"><span class="led off"></span>수업 시간대 밖</span>'}</dd>
        </dl>
      </article>`;
    }).join("") || '<div class="panel" style="grid-column:1/-1"><p class="muted" style="margin:0">아직 연결된 키가 없습니다. 선생님께 키 연결을 요청하세요.</p></div>';
    for (const box of root.querySelectorAll(".pl-secret")) {
      const k = keys.find((x) => x.key_alias === box.dataset.alias);
      if (k && k.secret_available) {
        mountSecret(box, { hint: k.key_hint, fetchSecret: (purpose) => revealMine(k.key_alias, purpose) });
      } else {
        box.innerHTML = '<div class="keybox off">선생님이 이 기능 전에 만든 키라 여기서 볼 수 없어요. 선생님께 <b>새 키로 교체</b>를 부탁하세요.</div>';
      }
    }
    const leftSum = keys.reduce((acc, k) => acc + (k.max_budget == null ? 0 : Math.max(0, k.max_budget - (k.spend || 0))), 0);
    const unlimited = keys.some((k) => k.max_budget == null);
    const usable = keys.filter((k) => ["active", "warn"].includes(keyState(k, now).code) && scheduleAllows(k.schedule || [])).length;
    $("#pl-summary").innerHTML = [
      `<div class="tile"><div class="k">남은 예산</div><div class="v">${unlimited ? "무제한" : money(leftSum)}</div><div class="s">키 ${keys.length}개 합계</div></div>`,
      `<div class="tile"><div class="k"><span class="led ${usable ? "good" : "off"}"></span>지금 쓸 수 있는 키</div><div class="v">${usable} / ${keys.length}</div><div class="s">${usable ? "지금 호출할 수 있어요" : "시간대·상태를 확인하세요"}</div></div>`,
    ].join("");
    const model = (keys.find((k) => (k.models || []).length)?.models || ["gpt-4o-mini"])[0];
    $("#pl-model").innerHTML = `<code>${esc(model)}</code>`;
    const code = snippetPython(proxyUrl, model);
    $("#pl-snippet").textContent = code;
    $("#pl-copy").onclick = async () => toast((await copyText(code)) ? "예제 코드를 복사했습니다" : "복사하지 못했습니다", { tone: "good" });
    // 쓸 수 있는 키 하나를 골라, 그 키가 들어간 예제 코드를 복사한다(화면에는 키를 띄우지 않는다).
    const mine = keys.find((k) => k.secret_available && ["active", "warn"].includes(keyState(k, now).code)) || keys.find((k) => k.secret_available);
    const copyMine = $("#pl-copy-mine");
    copyMine.hidden = !mine;
    if (mine) {
      copyMine.title = `${mine.key_alias} 키가 들어간 코드를 복사합니다`;
      copyMine.onclick = async () => {
        try {
          const secret = await revealMine(mine.key_alias, "copy");
          const ok = await copyText(snippetPython(proxyUrl, (mine.models || [])[0] || model, secret));
          toast(ok ? "내 키가 들어간 코드를 복사했어요. 이 코드를 친구에게 보내지 마세요." : "복사하지 못했습니다", { tone: ok ? "good" : "warn" });
        } catch (e) { toastError(e, "키를 받지 못했습니다"); }
      };
    }
    if (scene) {
      const teamIds = [...new Set(keys.map((k) => k.team_id).filter(Boolean))];
      scene.setData({
        teams: teamIds.map((id) => {
          const k = keys.find((x) => x.team_id === id);
          return { id, name: k.team_alias || "학급", ratio: null, session: "always", locked: false, keys: keys.filter((x) => x.team_id === id).length, note: `내 학급 · 내 키 ${keys.filter((x) => x.team_id === id).length}개` };
        }),
        keys: keys.map((k) => ({ id: k.key_alias, team: k.team_id, state: keyState(k).code, camp: false })),
        engines: [],
      });
    }
    return keys;
  };

  const loadUsage = async () => {
    const days = Number($("#pl-days").value);
    const a = await api(`/api/my/analytics?days=${days}&horizon=14`);
    const projected = a.forecast ? a.forecast.future.at(-1) : null;
    $("#pl-tiles").innerHTML = [
      `<div class="tile"><div class="k">최근 ${days}일 사용</div><div class="v">${money(a.totalSpend || 0)}</div><div class="s">호출 ${num((a.requests || []).reduce((x, y) => x + y, 0))}회</div></div>`,
      `<div class="tile"><div class="k">연결된 키</div><div class="v">${num(a.assignedCount || 0)}</div></div>`,
      `<div class="tile"><div class="k">14일 뒤 예상 누적</div><div class="v">${projected == null ? "—" : money(projected)}</div><div class="s">지금 속도 기준</div></div>`,
    ].join("");
    dailyBarChart($("#pl-daily"), a.dates, a.daily);
    if ((a.keyStats || []).length) rankBarChart($("#pl-bykey"), a.keyStats, { labelKey: "alias" });
    else $("#pl-bykey").innerHTML = '<p class="muted">아직 사용 기록이 없습니다.</p>';
    return a;
  };

  const loadCalls = async () => {
    const out = await api("/api/my/activity");
    const items = out.items || [];
    $("#pl-calls").innerHTML = items.map((it) => `<tr class="${it.ok ? "" : "bad"}">
      <td class="nowrap"><span class="num">${esc(fmtTime(it.at))}</span> <span class="muted" style="font-size:11px">${esc(relTime(it.at))}</span></td>
      <td>${esc(it.alias || "")}</td><td class="sec">${esc(it.model || "")}</td>
      <td>${it.ok ? '<span class="state"><span class="led good"></span>성공</span>' : `<span class="tag crit">${esc(it.reason || "실패")}</span>`}</td>
      <td class="r num">${num(it.tokens)}</td><td class="r num">${it.ok ? money(it.spend) : "—"}</td></tr>`).join("") || '<tr><td colspan="6" class="tbl-empty">최근 7일 호출이 없습니다.</td></tr>';
    return out;
  };

  $("#pl-days").onchange = () => loadUsage().catch((e) => toastError(e));
  $("#pl-reload").onclick = () => loadCalls().catch((e) => toastError(e));

  try {
    const [ks, , calls] = await Promise.all([loadKeys(), loadUsage(), loadCalls()]);
    const blocked = ks.filter((k) => keyState(k).code !== "active" && keyState(k).code !== "warn");
    const fail = (calls.items || []).find((x) => !x.ok);
    const open = ks.some((k) => scheduleAllows(k.schedule || []));
    let line = `${me.name}님, 환영해요! 연결된 키 ${ks.length}개를 확인했어요.`;
    if (blocked.length) line = `${blocked[0].key_alias} 키는 지금 '${keyState(blocked[0]).label}' 상태예요. 필요하면 선생님께 말씀해 주세요.`;
    else if (fail) line = `최근 호출이 '${fail.reason}' 때문에 막혔어요. 아래 최근 호출 표에서 확인해 보세요.`;
    else if (ks.length && !open) line = "지금은 수업 시간대가 아니라 키를 쓸 수 없어요.";
    say($("#pl-holo"), blocked.length || fail ? "warn" : "usage", line);
  } catch (e) {
    toastError(e, "내 정보를 불러오지 못했습니다");
  }
  setInterval(() => { if (document.visibilityState === "visible") loadCalls().catch(() => {}); }, 30000);

  // 선생님이 켜 두었으면 학생도 엘피에게 자기 키 상황을 물어볼 수 있다.
  try {
    const cfg = await api("/api/assistant/config");
    if (cfg && cfg.available) {
      createElfy({
        api,
        role: "user",
        host: $("#pl-foot"),
        getStation: () => "pilot",
        getSettings: () => settings,
        saveSettings,
      });
    }
  } catch { /* 엘피 없이 쓴다 */ }
}
