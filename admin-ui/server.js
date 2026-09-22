// 관리자 UI 백엔드.
// Firebase ID 토큰을 검증하고, 허용된 관리자 이메일만 LiteLLM 관리 API를 호출할 수 있다.
// LITELLM_MASTER_KEY는 이 서버에만 존재하며 브라우저로 나가지 않는다.
const express = require("express");
const admin = require("firebase-admin");
const { assignClassBudgets, keyGenerateParams } = require("./lib/class-assign");
const { revokeKeys } = require("./lib/key-revoke");
const { adjustKey, keyDetail } = require("./lib/key-adjust");
const { resolveIssueModels, teamModelsFor } = require("./lib/model-allowlist");
const { issueCampKeys, campIssuePolicy, revokeCampKeys, todayYmd } = require("./lib/camp-keys");
const { DAY_MS, ymd, buildAnalytics } = require("./lib/analytics");

const {
  FIREBASE_PROJECT_ID,
  ADMIN_EMAILS = "",
  LITELLM_BASE_URL = "http://litellm:4000",
  LITELLM_MASTER_KEY,
  PORT = 3000,
} = process.env;

if (!FIREBASE_PROJECT_ID || !LITELLM_MASTER_KEY) {
  console.error("FIREBASE_PROJECT_ID와 LITELLM_MASTER_KEY 환경변수가 필요합니다");
  process.exit(1);
}

// ID 토큰 검증만 하므로 서비스 계정 키 없이 projectId만으로 초기화
admin.initializeApp({ projectId: FIREBASE_PROJECT_ID });

const adminEmails = new Set(
  ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)
);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname + "/public"));
// 브라우저 명단 파서가 서버와 같은 규칙을 쓰도록 lib 파일을 그대로 제공한다.
app.get("/roster.js", (_req, res) => {
  res.type("application/javascript").sendFile(__dirname + "/lib/roster.js");
});
app.get("/key-revoke.js", (_req, res) => {
  res.type("application/javascript").sendFile(__dirname + "/lib/key-revoke.js");
});

// Compose healthcheck용. 인증 없이 프로세스 생존만 확인.
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

async function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (!token) return res.status(401).json({ error: "로그인이 필요합니다" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const email = (decoded.email || "").toLowerCase();
    if (!decoded.email_verified || !adminEmails.has(email)) {
      return res.status(403).json({ error: `관리자 권한이 없는 계정입니다: ${email}` });
    }
    req.adminEmail = email;
    next();
  } catch (e) {
    res.status(401).json({ error: "토큰 검증 실패" });
  }
}

async function litellm(path, method = "GET", body) {
  const resp = await fetch(LITELLM_BASE_URL + path, {
    method,
    headers: {
      Authorization: `Bearer ${LITELLM_MASTER_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error?.message || `LiteLLM ${resp.status}`);
  return data;
}

// 발급/수정 공통: 클라이언트 입력에서 LiteLLM 키 파라미터만 추려 만든다.
// expires(YYYY-MM-DD)가 있으면 LiteLLM이 받는 duration(초)으로 바꾼다.
function keyParams(body) {
  return keyGenerateParams(body);
}

// ---- 그룹(LiteLLM Team) 관리 ----
// 그룹 예산·제한은 소속 키 전체의 합산 사용량에 적용된다.

app.get("/api/teams", requireAdmin, async (req, res) => {
  try {
    const data = await litellm("/team/list");
    res.json({ teams: Array.isArray(data) ? data : data.teams || [] });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/teams", requireAdmin, async (req, res) => {
  if (!req.body.alias) return res.status(400).json({ error: "그룹 이름이 필요합니다" });
  try {
    const data = await litellm("/team/new", "POST", {
      team_alias: req.body.alias,
      ...keyParams(req.body),
    });
    console.log(`${req.adminEmail} 이(가) 그룹 생성: ${req.body.alias}`);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/teams/update", requireAdmin, async (req, res) => {
  if (!req.body.team_id) return res.status(400).json({ error: "team_id가 필요합니다" });
  try {
    res.json(await litellm("/team/update", "POST", {
      team_id: req.body.team_id,
      ...keyParams(req.body),
    }));
    console.log(`${req.adminEmail} 이(가) 그룹 수정: ${req.body.team_id}`);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/teams/delete", requireAdmin, async (req, res) => {
  if (!req.body.team_id) return res.status(400).json({ error: "team_id가 필요합니다" });
  try {
    res.json(await litellm("/team/delete", "POST", { team_ids: [req.body.team_id] }));
    console.log(`${req.adminEmail} 이(가) 그룹 삭제: ${req.body.team_id}`);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 학급 일괄 예산 부여: students[] 또는 csv 텍스트.
// 조/학급은 team_id 또는 team(이름, 없으면 생성). 행별 성공/실패를 돌려준다.
app.post("/api/keys/bulk", requireAdmin, async (req, res) => {
  try {
    const out = await assignClassBudgets(req.body, { litellm });
    const n = out.results.length;
    const fail = out.results.filter((r) => r.error).length;
    console.log(`${req.adminEmail} 이(가) 일괄 발급: ${n}명 (실패 ${fail})`);
    res.json(out);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// 캠프 짧은 키 N개. 명단 없이 인원만. 저가 모델 필수·당일 종료 강제.
app.post("/api/keys/camp", requireAdmin, async (req, res) => {
  try {
    const out = await issueCampKeys(req.body, { litellm });
    const fail = out.results.filter((r) => r.error).length;
    console.log(`${req.adminEmail} 이(가) 캠프 키 발급: ${out.count}개 (실패 ${fail}) 만료 ${out.expires} 모델 ${(out.models || []).join(",")}`);
    res.json(out);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// 캠프 발급 정책(저가 모델·당일 종료·회수 훅). UI가 폼을 잠글 때 쓴다.
app.get("/api/keys/camp/policy", requireAdmin, async (_req, res) => {
  const policy = campIssuePolicy();
  res.json({
    ...policy,
    expires: todayYmd(),
  });
});

// 캠프 키 당일/만료 회수. 스케줄(cron)과 화면의 수동 훅.
app.post("/api/keys/camp/revoke", requireAdmin, async (req, res) => {
  try {
    const out = await revokeCampKeys(req.body, { litellm });
    const n = out.results.length;
    const fail = out.results.filter((r) => r.error).length;
    const verb = out.action === "delete" ? "회수" : "차단";
    console.log(`${req.adminEmail} 이(가) 캠프 키 ${verb}: ${n}개 (실패 ${fail}) filter ${out.filter}`);
    res.json(out);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// ---- 사용량 분석 ----
// 일별 지출 시계열 + 키/모델별 집계. LiteLLM의 /user/daily/activity는
// 오픈소스에서 쓸 수 있는 집계 엔드포인트다(/global/spend/report는 엔터프라이즈 전용).

app.get("/api/analytics", requireAdmin, async (req, res) => {
  const days = Math.min(180, Math.max(7, Number(req.query.days) || 30));
  const horizon = Math.min(90, Math.max(1, Number(req.query.horizon) || 14));
  const teamId = String(req.query.team_id || "");
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * DAY_MS);
  try {
    // 페이지를 모두 돌아 기간 내 일별 레코드를 수집
    const results = [];
    for (let page = 1; ; page++) {
      const d = await litellm(
        `/user/daily/activity?start_date=${ymd(start)}&end_date=${ymd(end)}&page=${page}&page_size=100`
      );
      results.push(...(d.results || []));
      const total = d.metadata?.total_pages || d.total_pages || 1;
      if (page >= total) break;
    }

    // 키 해시 → 별칭/그룹 이름으로 치환
    const keyList = [];
    for (let page = 1; ; page++) {
      const d = await litellm(`/key/list?return_full_object=true&size=100&page=${page}`);
      keyList.push(...(d.keys || []));
      if (page >= (d.total_pages || 1)) break;
    }
    const teamsRaw = await litellm("/team/list");
    const teams = Array.isArray(teamsRaw) ? teamsRaw : teamsRaw.teams || [];
    res.json(buildAnalytics({ results, keyList, teams, start, end, horizon, teamId }));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 프록시에 설정된 모델 목록 (발급 폼의 선택지)
app.get("/api/models", requireAdmin, async (req, res) => {
  try {
    const data = await litellm("/v1/models");
    res.json({ models: (data.data || []).map((m) => m.id) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 키 목록 (사용량 포함). size는 LiteLLM이 100까지만 허용하므로 페이지를 돌며 모두 모은다.
app.get("/api/keys", requireAdmin, async (req, res) => {
  try {
    const keys = [];
    for (let page = 1; ; page++) {
      const data = await litellm(`/key/list?return_full_object=true&size=100&page=${page}`);
      keys.push(...(data.keys || []));
      if (page >= (data.total_pages || 1)) break;
    }
    res.json({ keys });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 키 발급
app.post("/api/keys", requireAdmin, async (req, res) => {
  if (!req.body.alias) return res.status(400).json({ error: "alias가 필요합니다" });
  try {
    const params = keyParams(req.body);
    const models = resolveIssueModels(
      req.body.models,
      await teamModelsFor(litellm, req.body.team_id)
    );
    if (models.length) params.models = models;
    else delete params.models;
    const data = await litellm("/key/generate", "POST", {
      key_alias: req.body.alias,
      team_id: req.body.team_id || undefined,
      ...params,
    });
    console.log(`${req.adminEmail} 이(가) 키 발급: ${req.body.alias}`);
    res.json(data);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// 키 상세 (현재 값 + 충전·연장 이력). LiteLLM /key/info, 없으면 /key/list.
app.get("/api/keys/info", requireAdmin, async (req, res) => {
  try {
    res.json(await keyDetail(req.query.token, { litellm }));
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// 개별 충전·기간 연장. 예산은 가산, 만료는 기존일 +N 또는 달력일.
// 이력(누가·언제·얼마/만료)은 LiteLLM metadata.aiapi_history.
app.post("/api/keys/adjust", requireAdmin, async (req, res) => {
  try {
    const out = await adjustKey(req.body, { litellm, actor: req.adminEmail });
    const bits = [];
    if (out.add_budget != null) bits.push(`+$${out.add_budget}`);
    if (out.add_days != null) bits.push(`+${out.add_days}일`);
    if (out.entry?.expires && out.add_days == null) bits.push(`만료 ${out.entry.expires}`);
    console.log(`${req.adminEmail} 이(가) 키 충전·연장: ${out.alias || out.token.slice(0, 12)} ${bits.join(" ")}`);
    res.json(out);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// 키 수정 (예산·기한·모델·속도 제한 변경)
app.post("/api/keys/update", requireAdmin, async (req, res) => {
  if (!req.body.token) return res.status(400).json({ error: "token이 필요합니다" });
  try {
    const data = await litellm("/key/update", "POST", {
      key: req.body.token,
      ...keyParams(req.body),
    });
    console.log(`${req.adminEmail} 이(가) 키 수정: ${req.body.token.slice(0, 12)}...`);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 키 차단/해제 (삭제하지 않고 일시 정지)
app.post("/api/keys/block", requireAdmin, async (req, res) => {
  if (!req.body.token) return res.status(400).json({ error: "token이 필요합니다" });
  try {
    const path = req.body.blocked ? "/key/block" : "/key/unblock";
    const data = await litellm(path, "POST", { key: req.body.token });
    console.log(`${req.adminEmail} 이(가) 키 ${req.body.blocked ? "차단" : "차단 해제"}`);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 키 삭제
app.post("/api/keys/delete", requireAdmin, async (req, res) => {
  const { keys } = req.body;
  if (!keys?.length) return res.status(400).json({ error: "keys가 필요합니다" });
  try {
    res.json(await litellm("/key/delete", "POST", { keys }));
    console.log(`${req.adminEmail} 이(가) 키 삭제: ${keys.length}개`);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 학기·캠프 종료 후 일괄 차단/회수. 개별 block·delete 와 같은 LiteLLM 경로.
app.post("/api/keys/revoke", requireAdmin, async (req, res) => {
  try {
    const out = await revokeKeys(req.body, { litellm });
    const n = out.results.length;
    const fail = out.results.filter((r) => r.error).length;
    const verb = out.action === "delete" ? "회수" : "차단";
    console.log(`${req.adminEmail} 이(가) 일괄 ${verb}: ${n}개 (실패 ${fail})`);
    res.json(out);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`admin-ui listening on :${PORT}`));
