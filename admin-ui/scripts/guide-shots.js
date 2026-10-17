// 그림 안내서(public/guide/img/*.webp)에 들어가는 화면을 흉내 서버에서 찍고, 노란 상자와 번호를 그려 넣는다.
// 이름·키·사용량은 모두 흉내 서버(dev-mock.js)의 연습용 값이다.
//
// 찍는 법 (이 저장소의 admin-ui 폴더에서):
//   1) npm run mock                      # 다른 창에서 띄워 둔다(http://127.0.0.1:3456)
//   2) docker run --rm --network host -e CHROMIUM_FLAGS= \
//        -v "$PWD/scripts/guide-shots.js:/usr/src/app/guide-shots.js:ro" \
//        -v "$PWD/public/guide/img:/shots" \
//        zenika/alpine-chrome:with-puppeteer node guide-shots.js
//   일부만: -e ONLY=s3-key,t2-launch   · 다른 주소: -e BASE=http://127.0.0.1:3456
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const BASE = process.env.BASE || "http://127.0.0.1:3456";
const OUT = process.env.OUT || "/shots";
const ONLY = new Set(String(process.env.ONLY || "").split(",").map((s) => s.trim()).filter(Boolean));
const SCALE = Number(process.env.SCALE || 1.25);
const STUDENT = "student@school.kr";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 3D 가 CPU 를 잡으면 waitForFunction 이 멈출 수 있어 evaluate 로 직접 기다린다.
async function until(page, fn, arg, { timeout = 20000, label = "" } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    let ok = false;
    try { ok = await page.evaluate(fn, arg); } catch { ok = false; }
    if (ok) return;
    if (Date.now() > end) throw new Error(`기다리다 지침: ${label || fn.toString().slice(0, 80)}`);
    await sleep(200);
  }
}
const visible = (page, sel, opt) => until(page, (s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
}, sel, { label: sel, ...opt });

/**
 * 노란 상자와 번호를 그린다. 항목: { sel | [sel…], text, up, n, label, side: "left"|"right", pad, at: "tl"|"tr"|"bl"|"br"|"l"|"r" }
 * - text: sel 에 맞는 것 중 글자가 들어간 것 · up: 찾은 뒤 closest(up) · 배열이면 여러 요소를 감싸는 상자
 */
async function mark(page, items) {
  const missing = await page.evaluate((items) => {
    document.getElementById("gs-layer")?.remove();
    const layer = document.createElement("div");
    layer.id = "gs-layer";
    layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
    document.body.appendChild(layer); // 먼저 붙여야 이름표 폭을 잴 수 있다
    const find = (it, sel) => {
      let el = null;
      if (it.text) el = [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(it.text)) || null;
      else el = document.querySelector(sel);
      if (el && it.up) el = el.closest(it.up);
      return el;
    };
    const lost = [];
    for (const it of items) {
      const sels = Array.isArray(it.sel) ? it.sel : [it.sel];
      const rects = sels.map((s) => { const el = find(it, s); if (!el) lost.push(s); return el && el.getBoundingClientRect(); }).filter(Boolean);
      if (!rects.length) continue;
      const pad = it.pad ?? 6;
      const l = Math.min(...rects.map((r) => r.left)) - pad;
      const t = Math.min(...rects.map((r) => r.top)) - pad;
      const r = Math.max(...rects.map((x) => x.right)) + pad;
      const b = Math.max(...rects.map((x) => x.bottom)) + pad;
      const box = document.createElement("div");
      box.style.cssText = `position:absolute;left:${l}px;top:${t}px;width:${r - l}px;height:${b - t}px;border:3px solid #ffc531;border-radius:10px;box-shadow:0 0 0 2px rgba(0,0,0,.55),0 0 18px rgba(255,197,49,.45)`;
      layer.appendChild(box);
      const S = 30;
      const at = it.at || "tl";
      let x = at.includes("r") ? r - S / 2 : l - S / 2;
      let y = at.includes("b") ? b - S / 2 : t - S / 2;
      if (at === "l") { x = l - S - 6; y = (t + b) / 2 - S / 2; }
      if (at === "r") { x = r + 6; y = (t + b) / 2 - S / 2; }
      x = Math.max(4, Math.min(innerWidth - S - 4, x));
      y = Math.max(4, Math.min(innerHeight - S - 4, y));
      const badge = document.createElement("div");
      badge.textContent = it.n;
      badge.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${S}px;height:${S}px;border-radius:50%;background:#ffc531;color:#1a1200;font:800 17px/${S}px Pretendard,"Malgun Gothic",sans-serif;text-align:center;box-shadow:0 0 0 2px rgba(0,0,0,.6),0 3px 10px rgba(0,0,0,.6)`;
      layer.appendChild(badge);
      if (it.label) {
        const tag = document.createElement("div");
        tag.textContent = it.label;
        tag.style.cssText = `position:absolute;top:${y + 2}px;left:${x + S + 6}px;padding:3px 10px;border-radius:6px;background:#ffc531;color:#1a1200;font:700 14px/20px Pretendard,"Noto Sans CJK KR","Malgun Gothic",sans-serif;white-space:nowrap;box-shadow:0 3px 10px rgba(0,0,0,.6)`;
        layer.appendChild(tag);
        const w = tag.getBoundingClientRect().width;
        const left = (it.side || (at === "l" ? "left" : "right")) === "left";
        if (left || x + S + 6 + w > innerWidth - 4) tag.style.left = `${x - w - 6}px`;
      }
    }
    return lost;
  }, items);
  if (missing.length) console.warn("  표시할 요소를 못 찾음:", missing.join(", "));
}

// 요소(여러 개면 감싸는 영역) 둘레만 잘라 찍는다.
async function clipOf(page, sels, margin = 24) {
  return page.evaluate((sels, m) => {
    const rs = sels.map((s) => document.querySelector(s)).filter(Boolean).map((e) => e.getBoundingClientRect());
    const l = Math.max(0, Math.min(...rs.map((r) => r.left)) - m);
    const t = Math.max(0, Math.min(...rs.map((r) => r.top)) - m);
    const r = Math.min(innerWidth, Math.max(...rs.map((x) => x.right)) + m);
    const b = Math.min(innerHeight, Math.max(...rs.map((x) => x.bottom)) + m);
    return { x: l, y: t, width: r - l, height: b - t };
  }, Array.isArray(sels) ? sels : [sels], margin);
}

// 흉내 서버 주소(127.0.0.1:…)를 학교에서 보게 될 주소 모양으로 바꿔 보여 준다(글자와 입력 칸 값만).
const SHOW = [
  [new URL(BASE).origin, process.env.SHOW_ORIGIN || "http://192.168.0.10:3000"],
  ["http://127.0.0.1:4456", "http://192.168.0.20:11434"],
  ["127.0.0.1:4456", "192.168.0.20:11434"],
];
async function polish(page) {
  await page.evaluate((pairs) => {
    const swap = (v) => pairs.reduce((acc, [a, b]) => acc.split(a).join(b), v);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.includes("127.0.0.1")) n.nodeValue = swap(n.nodeValue);
    for (const el of document.querySelectorAll("input")) if (el.value.includes("127.0.0.1")) el.value = swap(el.value);
  }, SHOW);
}

async function shoot(page, name, clip) {
  await polish(page);
  await sleep(250);
  const file = path.join(OUT, `${name}.webp`);
  // 잘라 찍을 때 화면을 키우면 100vh 배치가 다시 잡혀 상자가 어긋난다. 보이는 그대로 찍는다.
  await page.screenshot({ path: file, type: "webp", quality: 82, captureBeyondViewport: false, ...(clip ? { clip } : {}) });
  console.log(`  ✓ ${name}.webp ${(fs.statSync(file).size / 1024).toFixed(0)}KB`);
}

// ---------------------------------------------------------------- 가짜 기록(학생 최근 호출)
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const MY_CALLS = {
  items: [
    { at: ago(2), alias: "20261001-홍길동", model: "gpt-4o-mini", ok: true, tokens: 412, spend: 0.00021 },
    { at: ago(5), alias: "20261001-홍길동", model: "gpt-4o", ok: false, reason: "허용 안 된 모델", tokens: 0 },
    { at: ago(31), alias: "20261001-홍길동", model: "gpt-4o-mini", ok: true, tokens: 1290, spend: 0.00063 },
    { at: ago(60 * 20), alias: "20261001-홍길동", model: "gpt-4o-mini", ok: false, reason: "수업 시간대 밖", tokens: 0 },
    { at: ago(60 * 26), alias: "20261001-홍길동", model: "gpt-4o-mini", ok: true, tokens: 655, spend: 0.00032 },
    { at: ago(60 * 49), alias: "20261001-홍길동", model: "gpt-4o-mini", ok: false, reason: "잘못된 키", tokens: 0 },
  ],
};

async function open(browser, { url, settings = { scene: "off" }, size = [1280, 800], intercept = null }) {
  const page = await browser.newPage();
  await page.setViewport({ width: size[0], height: size[1], deviceScaleFactor: SCALE });
  page.on("pageerror", (e) => console.warn("  [pageerror]", e.message));
  if (intercept) {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const hit = intercept(req.url());
      if (hit) req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(hit) });
      else req.continue();
    });
  }
  // 첫 화면 전에 설정을 넣는다(효과음·엘피 먼저 말하기 끄기).
  await page.evaluateOnNewDocument((s) => {
    try { localStorage.setItem("aiapi.bridge.settings", JSON.stringify({ sound: false, proactive: false, ...s })); } catch { /* */ }
  }, settings);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return page;
}
const booted = (page) => until(page, () => (!document.getElementById("boot") || document.getElementById("boot").hidden), null, { timeout: 30000, label: "boot" });
// 창이 펼쳐지는 효과(holoIn 등)가 끝날 때까지 기다린다. 중간에 재면 상자가 어긋난다.
const settle = async (page, sel) => {
  await visible(page, sel);
  await until(page, (s) => document.querySelector(s).getAnimations({ subtree: true }).every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity), sel, { label: `${sel} 효과` });
  await sleep(200);
};
const goStation = async (page, hash, ready) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await visible(page, ready);
  await sleep(300);
  await settle(page, ".station.active"); // 스테이션 전환과 카드가 들어오는 효과가 끝나야 자리가 맞는다
};

// ---------------------------------------------------------------- 학생
const studentShots = {
  async "s1-login"(browser) {
    const page = await open(browser, { url: `${BASE}/?login=1`, settings: { scene: "on" }, size: [1280, 760] });
    await visible(page, "#login-btn");
    await sleep(2500);
    await mark(page, [{ sel: "#login-btn", n: 1, label: "학교 구글 계정으로 로그인", at: "l" }, { sel: ".login-guide", n: 2, at: "l" }]);
    await shoot(page, "s1-login");
    await page.close();
  },

  async student(browser) {
    const page = await open(browser, {
      url: `${BASE}/?as=${STUDENT}`, size: [1280, 1000],
      intercept: (u) => (u.includes("/api/my/activity") ? MY_CALLS : null),
    });
    await visible(page, "#pl-keys .card .k-val");
    await visible(page, "#pl-codex");
    await booted(page);
    await sleep(1200);

    await mark(page, [
      { sel: "#pl-summary", n: 1 },
      { sel: "#pl-snippet", up: ".panel", n: 2 },
      { sel: "#pl-keys .card", n: 3 },
      { sel: "#pl-guide", n: 4, at: "bl" },
    ]);
    await shoot(page, "s2-cockpit");

    // 접속 안내 칸
    await mark(page, [
      { sel: ".panel:has(#pl-snippet) dl.kv dd code", n: 1, pad: 4, at: "l" },
      { sel: "#pl-model code", n: 2, pad: 4, at: "l" },
      { sel: "#pl-copy-mine", n: 3, at: "bl" },
      { sel: "#pl-codex", n: 4, at: "br" },
    ]);
    const access = await page.evaluate(() => {
      const r = document.querySelector("#pl-snippet").closest(".panel").getBoundingClientRect();
      return { x: Math.max(0, r.left - 26), y: Math.max(0, r.top - 26), width: r.width + 52, height: r.height + 52 };
    });
    await shoot(page, "s4-code", access);

    // 내 키: 마우스를 올린 동안 보인다
    await page.evaluate(() => document.getElementById("gs-layer")?.remove());
    await page.evaluate(() => document.querySelector("#pl-keys .card").scrollIntoView({ block: "center" }));
    await sleep(300);
    await page.hover("#pl-keys .card .k-val");
    await until(page, () => document.querySelector("#pl-keys .card .k-val.shown"), null, { label: "키 보임" });
    await mark(page, [
      { sel: "#pl-keys .card .k-val", n: 1, label: "마우스를 올리면 보여요", at: "tl" },
      { sel: "#pl-keys .card .k-peek", n: 2, at: "tr" },
      { sel: "#pl-keys .card .k-copy", n: 3, at: "tr" },
    ]);
    await shoot(page, "s3-key", await clipOf(page, "#pl-keys .card", 28));

    // 최근 호출
    await page.mouse.move(5, 5);
    await page.evaluate(() => { document.getElementById("gs-layer")?.remove(); document.querySelector("#pl-calls").closest(".panel").scrollIntoView({ block: "center" }); });
    await sleep(400);
    await mark(page, [
      { sel: "#pl-calls tr:not(.bad) td:nth-child(4) .state", n: 1, pad: 5, at: "l" },
      { sel: "#pl-calls tr.bad td:nth-child(4) .tag", n: 2, pad: 5, at: "r" },
    ]);
    await shoot(page, "s6-calls", await clipOf(page, ".panel:has(#pl-calls)", 14));

    // Codex 설정 창
    await page.evaluate(() => { document.getElementById("gs-layer")?.remove(); window.scrollTo(0, 0); });
    await page.setViewport({ width: 1280, height: 1180, deviceScaleFactor: SCALE });
    await page.click("#pl-codex");
    await settle(page, ".modal");
    await mark(page, [
      { sel: "#cx-key", n: 1, at: "l" },
      { sel: "#cx-model", n: 2, at: "r" },
      { sel: ".modal [data-os]", up: ".seg", n: 3, at: "r" },
      { sel: "#cx-copy-cmd", n: 4, at: "l" },
    ]);
    await shoot(page, "s5-codex", await clipOf(page, ".modal", 16));
    await page.close();
  },
};

// ---------------------------------------------------------------- 선생님
const teacherShots = {
  async "t1-bridge"(browser) {
    const page = await open(browser, { url: `${BASE}/`, settings: { scene: "on" }, size: [1440, 900] });
    await booted(page);
    await visible(page, "#rail .rail-btn");
    await sleep(6000); // 3D 가 자리 잡고 호출 빛이 몇 번 흐르게
    await mark(page, [
      { sel: "#rail", n: 1, pad: 2, at: "tr" },
      { sel: "#hud-condition", n: 2, at: "bl" },
      { sel: ".bridge-grid .void", n: 3, pad: -4, at: "tl" },
      { sel: ["#btn-cmd", "#btn-help"], n: 4, at: "bl" },
      { sel: "#elfy-launch", n: 5, at: "tl" },
    ]);
    await shoot(page, "t1-bridge");
    await page.close();
  },

  async admin(browser) {
    const page = await open(browser, { url: `${BASE}/#launch`, size: [1440, 900] });
    await booted(page);
    await visible(page, "#lb-roster");
    await sleep(900);

    // 05 키 발급 → 학급 일괄
    await page.select("#lb-team", "__new__");
    await visible(page, "#lb-newname");
    await page.type("#lb-newname", "3학년C반");
    await page.$eval("#lb-roster", (ta) => {
      ta.value = "학번,이름,이메일\n20263001,김하늘,sky@school.kr\n20263002,이바다,sea@school.kr\n20263003,박새봄,spring@school.kr";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleep(600);
    await mark(page, [
      { sel: "#lb-team", up: ".field", n: 1 },
      { sel: ["#lb-budget", "#lb-reset"], n: 2, pad: 26 },
      { sel: "#lb-models", up: ".field", n: 3 },
      { sel: "#lb-roster", n: 4 },
      { sel: "#lb-go", n: 5, at: "l" },
    ]);
    await shoot(page, "t2-launch");

    // 발급 결과
    await page.evaluate(() => document.getElementById("gs-layer")?.remove());
    await page.click("#lb-go");
    await settle(page, ".modal");
    await page.evaluate(() => [...document.querySelectorAll(".modal .modal-f .btn")].find((b) => b.textContent.includes("발급")).click());
    await visible(page, "#lr-csv", { timeout: 30000 });
    await sleep(1200);
    await page.evaluate(() => document.querySelector("#lb-result").scrollIntoView({ block: "start" }));
    await sleep(500);
    await mark(page, [
      { sel: "#lb-result .callout", n: 1 },
      { sel: "#lb-result th", text: "로그인 계정", n: 2, at: "tl" },
      { sel: ["#lr-csv", "#lr-print"], n: 3, at: "tl" },
    ]);
    await shoot(page, "t3-result", await clipOf(page, "#lb-result .panel", 18));

    // 03 키 관리: 여러 개 골라 일괄 작업
    await page.evaluate(() => document.getElementById("gs-layer")?.remove());
    await goStation(page, "#keys?filter=warn", "#k-rows .k-cb");
    await page.evaluate(() => { for (const cb of [...document.querySelectorAll("#k-rows .k-cb")].slice(0, 3)) cb.click(); });
    await settle(page, "#k-bulk .bulkbar");
    await mark(page, [
      { sel: "#k-status", n: 1, at: "tl" },
      { sel: "#k-rows tr.sel .k-cb", n: 2, pad: 8, at: "l" },
      { sel: "[data-act='bulk-topup']", n: 3, at: "tl" },
      { sel: "[data-act='bulk-rekey']", n: 4, at: "tl" },
      { sel: "[data-act='bulk-block']", n: 5, at: "tl" },
    ]);
    await shoot(page, "t4-keys");

    // 키 상세
    await page.evaluate(() => { document.getElementById("gs-layer")?.remove(); document.querySelector("[data-act='bulk-clear']")?.click(); });
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: SCALE });
    await page.select("#k-status", ""); // 필터를 풀어 학생 계정이 연결된 홍길동 키를 연다
    await until(page, () => [...document.querySelectorAll("#k-rows .alias")].some((a) => a.textContent.includes("20261001-홍길동")), null, { label: "홍길동 줄" });
    await page.evaluate(() => [...document.querySelectorAll("#k-rows .alias")].find((a) => a.textContent.includes("20261001-홍길동")).click());
    await visible(page, "#d-apply");
    await visible(page, "#d-secret .k-val");
    await settle(page, ".drawer");
    await mark(page, [
      { sel: "#d-secret", n: 1, at: "tl" },
      { sel: ["#d-add", "#d-days", "#d-exp", "#d-apply"], n: 2, pad: 10, at: "tl" },
      { sel: ["#d-block", "#d-reissue"], n: 3, at: "tl" },
    ]);
    await shoot(page, "t5-drawer");
    await page.keyboard.press("Escape");
    await sleep(400);

    // 04 학급/조
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: SCALE });
    await page.evaluate(() => document.getElementById("gs-layer")?.remove());
    await goStation(page, "#classes", ".card[data-card] [data-act='lock']");
    await mark(page, [
      { sel: ".card[data-card] .card-h .end .tag", n: 1, at: "tr" },
      { sel: ".card[data-card] .week", n: 2, at: "tl" },
      { sel: ".card[data-card] [data-act='topup']", n: 3, at: "bl" },
      { sel: ".card[data-card] [data-act='lock']", n: 4, at: "br" },
    ]);
    await shoot(page, "t6-classes");

    // 08 기록 → 실시간 호출(실패만)
    await page.evaluate(() => document.getElementById("gs-layer")?.remove());
    await goStation(page, "#log?tab=activity", "[data-res='fail']");
    await page.click("[data-res='fail']");
    await sleep(1500);
    await mark(page, [
      { sel: "[data-res='fail']", n: 1, at: "tl" },
      { sel: "#st-log tbody tr .tag.crit", n: 2, pad: 5, at: "r" },
    ]);
    await shoot(page, "t7-log");

    // 08 기록 → 학생 접속 안내
    await page.evaluate(() => document.getElementById("gs-layer")?.remove());
    await goStation(page, "#log?tab=guide", "#gd-body [data-copy]");
    await mark(page, [
      { sel: "#gd-body .grid > div:nth-child(1) .row", n: 1, at: "tl" },
      { sel: "#gd-body .grid > div:nth-child(2) .row", n: 2, at: "tl" },
      { sel: "#gd-print", n: 3, at: "tl" },
    ]);
    await shoot(page, "t8-guide");

    // 09 AI 엘피
    await page.evaluate(() => document.getElementById("gs-layer")?.remove());
    await goStation(page, "#ai", "#ai-test");
    await mark(page, [
      { sel: ".panel h2", text: "엘피 상태", up: ".panel", n: 1 },
      { sel: ".panel h2", text: "모델 연결", up: ".panel", n: 2 },
      { sel: ".panel h2", text: "행동 규칙", up: ".panel", n: 3 },
    ]);
    await shoot(page, "t9-ai");
    await page.close();
  },
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--lang=ko-KR", "--font-render-hinting=none"],
  });
  const groups = { ...studentShots, ...teacherShots };
  // 묶음(student, admin)은 안에서 여러 장을 찍는다. ONLY 에 그 안의 이름을 써도 묶음 전체를 돈다.
  const members = { student: ["s2-cockpit", "s3-key", "s4-code", "s5-codex", "s6-calls"], admin: ["t2-launch", "t3-result", "t4-keys", "t5-drawer", "t6-classes", "t7-log", "t8-guide", "t9-ai"] };
  let failed = 0;
  for (const [name, run] of Object.entries(groups)) {
    const names = members[name] || [name];
    if (ONLY.size && !names.some((n) => ONLY.has(n)) && !ONLY.has(name)) continue;
    console.log(`▶ ${name}`);
    try { await run(browser); } catch (e) { failed += 1; console.error(`  ✖ ${name}: ${e.message}`); }
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
