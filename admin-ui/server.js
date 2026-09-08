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

// 키 목록 (사용량 포함)
app.get("/api/keys", requireAdmin, async (req, res) => {
  try {
    res.json(await litellm("/key/list?return_full_object=true&size=200"));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 키 발급
app.post("/api/keys", requireAdmin, async (req, res) => {
  const { alias, budget, models, budget_duration } = req.body;
  if (!alias) return res.status(400).json({ error: "alias가 필요합니다" });
  try {
    const data = await litellm("/key/generate", "POST", {
      key_alias: alias,
      max_budget: Number(budget) || 2.0,
      models: models?.length ? models : undefined,
      budget_duration: budget_duration || undefined,
    });
    console.log(`${req.adminEmail} 이(가) 키 발급: ${alias}`);
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

// 전체 지출 요약
app.get("/api/spend", requireAdmin, async (req, res) => {
  try {
    res.json(await litellm("/global/spend/keys?limit=200"));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`admin-ui listening on :${PORT}`));
