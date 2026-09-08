// 관리자 UI 백엔드.
// Firebase ID 토큰을 검증하고, 허용된 관리자 이메일만 LiteLLM 관리 API를 호출할 수 있다.
// LITELLM_MASTER_KEY는 이 서버에만 존재하며 브라우저로 나가지 않는다.
const express = require("express");
const admin = require("firebase-admin");

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
app.use(express.json());
app.use(express.static(__dirname + "/public"));

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

// 발급/수정 공통: 클라이언트 입력에서 LiteLLM 키 파라미터만 추려 만든다
function keyParams(body) {
  const p = {};
  if (body.budget !== undefined && body.budget !== "") p.max_budget = Number(body.budget);
  if (body.budget_duration) p.budget_duration = body.budget_duration;   // 예산 리셋 주기: "1d"|"7d"|"30d"
  if (body.duration) p.duration = body.duration;                        // 키 만료: "30d" 등
  if (Array.isArray(body.models)) p.models = body.models;               // []이면 전체 허용
  if (body.rpm_limit) p.rpm_limit = Number(body.rpm_limit);
  if (body.tpm_limit) p.tpm_limit = Number(body.tpm_limit);
  if (body.max_parallel_requests) p.max_parallel_requests = Number(body.max_parallel_requests);
  return p;
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

// 학생 일괄 추가: 명단 배열을 받아 키를 순차 발급하고 결과(키 포함)를 돌려준다
app.post("/api/keys/bulk", requireAdmin, async (req, res) => {
  const { students, ...defaults } = req.body;
  if (!Array.isArray(students) || !students.length) {
    return res.status(400).json({ error: "students 배열이 필요합니다" });
  }
  const results = [];
  for (const s of students) {
    try {
      const data = await litellm("/key/generate", "POST", {
        key_alias: s.alias,
        team_id: defaults.team_id || undefined,
        ...keyParams(defaults),
      });
      results.push({ alias: s.alias, key: data.key });
    } catch (e) {
      results.push({ alias: s.alias, error: e.message });
    }
  }
  console.log(`${req.adminEmail} 이(가) 일괄 발급: ${students.length}명`);
  res.json({ results });
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
    const data = await litellm("/key/generate", "POST", {
      key_alias: req.body.alias,
      team_id: req.body.team_id || undefined,
      ...keyParams(req.body),
    });
    console.log(`${req.adminEmail} 이(가) 키 발급: ${req.body.alias}`);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
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

app.listen(PORT, () => console.log(`admin-ui listening on :${PORT}`));
