// Codex 데스크탑(또는 Codex CLI)이 학교 프록시로 요청하게 하는 설정.
// Codex 는 ~/.codex/config.toml 과 ~/.codex/.env 를 읽는다. 데스크탑 앱은 터미널 환경 변수를 못 읽으므로 키는 .env 에 둔다.
// 설정 파일에는 한글을 넣지 않는다(Windows PowerShell 5 가 UTF-8 에 BOM 을 붙이면 TOML 해석이 깨질 수 있다).
import { esc, icon, copyText } from "./util.js";
import { modal, toast, toastError } from "./ui.js";

export function codexConfig({ proxyUrl, model }) {
  return [
    "# AIAPI (school AI API) - Codex sends requests to the school proxy",
    `model = "${model}"`,
    'model_provider = "school"',
    "",
    "[model_providers.school]",
    'name = "AIAPI school"',
    `base_url = "${String(proxyUrl).replace(/\/+$/, "")}/v1"`,
    'env_key = "AIAPI_KEY"',
    'wire_api = "responses"',
    "",
  ].join("\n");
}

const envLine = (key) => `AIAPI_KEY=${key}`;

// 붙여 넣으면 폴더를 만들고, 원래 설정을 .bak 으로 남긴 뒤 두 파일을 쓴다.
export function setupCommand(os, config, key) {
  if (os === "windows") {
    return [
      '$d = "$env:USERPROFILE\\.codex"; New-Item -ItemType Directory -Force $d | Out-Null',
      'if (Test-Path "$d\\config.toml") { Copy-Item "$d\\config.toml" "$d\\config.toml.bak" -Force }',
      "@'",
      config.trimEnd(),
      `'@ | Set-Content -Encoding ascii "$d\\config.toml"`,
      `'${envLine(key)}' | Set-Content -Encoding ascii "$d\\.env"`,
      'Write-Host "Codex settings saved. Restart the Codex app." -ForegroundColor Green',
    ].join("\n");
  }
  return [
    "mkdir -p ~/.codex && [ -f ~/.codex/config.toml ] && cp ~/.codex/config.toml ~/.codex/config.toml.bak",
    "cat > ~/.codex/config.toml <<'EOF'",
    config.trimEnd(),
    "EOF",
    `printf '%s\\n' '${envLine(key)}' > ~/.codex/.env && chmod 600 ~/.codex/.env`,
    'echo "Codex settings saved. Restart the Codex app."',
  ].join("\n");
}

/**
 * @param {object} o
 * @param {string} o.proxyUrl
 * @param {Array} o.keys            조종석의 내 키 목록(secret_available, models, key_alias, key_hint)
 * @param {(alias: string) => Promise<string>} o.reveal  키 원문(작업 기록에 "복사"로 남는다)
 */
export function openCodexSetup({ proxyUrl, keys, reveal }) {
  const usable = keys.filter((k) => k.secret_available);
  if (!usable.length) {
    toast("이 화면에서 볼 수 있는 키가 없어요. 선생님께 '새 키로 교체'를 부탁하세요.", { tone: "warn" });
    return;
  }
  const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
  const keyOptions = usable.map((k, i) => `<option value="${i}">${esc(k.key_alias)}</option>`).join("");
  const body = `
    <p class="help" style="margin-top:0">Codex 앱이 OpenAI 대신 <b>학교 AI 서버</b>로 요청하게 합니다. 아래 순서대로 하면 5분이면 끝나요.
      <b>학교 안(학교 와이파이·컴퓨터실)에서만</b> 연결됩니다.</p>
    <div class="form-grid">
      <label class="field"><span>쓸 키</span><select id="cx-key">${keyOptions}</select></label>
      <label class="field"><span>모델</span><select id="cx-model"></select></label>
    </div>
    <ol class="cx-steps">
      <li><b>내 컴퓨터 고르기</b>
        <div class="seg" role="tablist" style="margin-top:6px"><button type="button" data-os="windows" aria-pressed="${!isMac}">Windows</button><button type="button" data-os="mac" aria-pressed="${isMac}">Mac</button></div></li>
      <li><b id="cx-open-title"></b><div class="help" id="cx-open" style="margin:6px 0 0"></div></li>
      <li><b>아래 명령을 복사해 붙여 넣고 Enter</b> — 설정 파일 두 개(<code>config.toml</code>, <code>.env</code>)를 만들어요. 원래 설정은 <code>config.toml.bak</code> 으로 남겨요.
        <div class="snippet" style="margin-top:8px"><pre id="cx-cmd"></pre><button class="btn xs primary" type="button" id="cx-copy-cmd">${icon("copy")}명령 복사</button></div></li>
      <li><b>Codex 앱을 완전히 껐다가 다시 켜기</b> — 새 작업에서 “안녕”을 보내 답이 오면 성공이에요. 조종석 <b>최근 호출</b>에 <code id="cx-model-name"></code> 호출이 생겨요.</li>
    </ol>
    <details class="more" style="margin-top:12px"><summary>명령 대신 파일을 직접 만들기</summary><div>
      <p class="help">설정 폴더(<code id="cx-folder"></code>)에 두 파일을 만들어요. 메모장으로 저장할 때는 <b>파일 형식: 모든 파일</b>을 골라야 <code>.txt</code> 가 붙지 않아요.</p>
      <div class="cx-file"><b>config.toml</b><div class="snippet"><pre id="cx-config"></pre><button class="btn xs" type="button" id="cx-copy-config">${icon("copy")}복사</button></div></div>
      <div class="cx-file"><b>.env</b><div class="snippet"><pre id="cx-env"></pre><button class="btn xs" type="button" id="cx-copy-env">${icon("copy")}키 넣어 복사</button></div></div>
    </div></details>
    <details class="more" style="margin-top:8px"><summary>안 될 때</summary><div><ul class="help" style="padding-left:18px;margin:0">
      <li><b>허용 안 된 모델</b> — config.toml 의 model 이 위에서 고른 이름과 똑같은지 보세요.</li>
      <li><b>연결할 수 없음</b> — 학교 망 안인지, 주소 <code>${esc(String(proxyUrl))}</code> 가 열리는지 보세요.</li>
      <li><b>수업 시간대 밖 · 예산 소진</b> — 조종석의 최근 호출 표에 이유가 나와요. 선생님께 말씀드리세요.</li>
      <li>Codex 는 한 번 작업에 토큰을 많이 써요. 남은 예산을 자주 보세요.</li>
    </ul></div></details>
    <p class="help" style="margin:12px 0 0">그림으로 된 자세한 안내: <a href="/guide/student.html#codex" target="_blank" rel="noopener">학생 안내서 → Codex</a></p>`;

  modal({
    title: "Codex 에서 학교 키 쓰기",
    code: "CODEX SETUP",
    size: "wide",
    body,
    actions: [{ label: "닫기", tone: "ghost", value: null }],
    onOpen: (h) => {
      const $$ = (sel) => h.el.querySelector(sel);
      let os = isMac ? "mac" : "windows";
      const keyOf = () => usable[Number($$("#cx-key").value) || 0];
      const fillModels = () => {
        const k = keyOf();
        const models = (k.models || []).length ? k.models : ["gpt-4o-mini"];
        $$("#cx-model").innerHTML = models.map((m) => `<option>${esc(m)}</option>`).join("");
      };
      const masked = () => `sk-••••${keyOf().key_hint || ""}`;
      const paint = () => {
        const config = codexConfig({ proxyUrl, model: $$("#cx-model").value });
        $$("#cx-config").textContent = config;
        $$("#cx-env").textContent = envLine(masked());
        $$("#cx-cmd").textContent = setupCommand(os, config, masked());
        $$("#cx-model-name").textContent = $$("#cx-model").value;
        for (const b of h.el.querySelectorAll("[data-os]")) b.setAttribute("aria-pressed", String(b.dataset.os === os));
        const win = os === "windows";
        $$("#cx-folder").textContent = win ? "%USERPROFILE%\\.codex" : "~/.codex";
        $$("#cx-open-title").textContent = win ? "PowerShell 열기" : "터미널 열기";
        $$("#cx-open").innerHTML = win
          ? "키보드 <span class=\"kbd\">Win</span> 키를 누르고 <b>PowerShell</b> 을 입력해 엽니다(관리자 권한 필요 없음)."
          : "<span class=\"kbd\">⌘</span>+<span class=\"kbd\">Space</span> 를 누르고 <b>터미널</b> 을 입력해 엽니다.";
      };
      const withKey = async (fn) => {
        try {
          const key = await reveal(keyOf().key_alias);
          return fn(key);
        } catch (e) {
          toastError(e, "키를 받지 못했습니다");
          return null;
        }
      };
      fillModels();
      paint();
      $$("#cx-key").onchange = () => { fillModels(); paint(); };
      $$("#cx-model").onchange = paint;
      for (const b of h.el.querySelectorAll("[data-os]")) b.onclick = () => { os = b.dataset.os; paint(); };
      // 화면에는 키를 가린 채 보여 주고, 복사할 때만 진짜 키를 넣는다.
      $$("#cx-copy-cmd").onclick = () => withKey(async (key) => {
        const ok = await copyText(setupCommand(os, codexConfig({ proxyUrl, model: $$("#cx-model").value }), key));
        toast(ok ? "명령을 복사했어요. PowerShell/터미널에 붙여 넣고 Enter 를 누르세요." : "복사하지 못했습니다", { tone: ok ? "good" : "warn" });
      });
      $$("#cx-copy-config").onclick = async () => {
        const ok = await copyText(codexConfig({ proxyUrl, model: $$("#cx-model").value }));
        toast(ok ? "config.toml 내용을 복사했어요" : "복사하지 못했습니다", { tone: ok ? "good" : "warn" });
      };
      $$("#cx-copy-env").onclick = () => withKey(async (key) => {
        const ok = await copyText(envLine(key));
        toast(ok ? ".env 내용(내 키 포함)을 복사했어요" : "복사하지 못했습니다", { tone: ok ? "good" : "warn" });
      });
    },
  });
}
