// 관리자 UI 백엔드.
// Firebase ID 토큰을 검증하고, 허용된 관리자 이메일만 LiteLLM 관리 API를 호출할 수 있다.
// LITELLM_MASTER_KEY는 이 서버에만 존재하며 브라우저로 나가지 않는다.
const express = require("express");
const admin = require("firebase-admin");
const { assignClassBudgets, keyGenerateParams } = require("./lib/class-assign");
const { revokeKeys } = require("./lib/key-revoke");

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

// ---- 사용량 분석 ----
// 일별 지출 시계열 + 키/모델별 집계. LiteLLM의 /user/daily/activity는
// 오픈소스에서 쓸 수 있는 집계 엔드포인트다(/global/spend/report는 엔터프라이즈 전용).

const DAY_MS = 86400000;
const ymd = (d) => d.toISOString().slice(0, 10);

// 잔여 예산. max_budget이 없으면 숫자를 만들지 않고 null.
function remainingBudget(maxBudget, spend) {
  if (maxBudget == null) return null;
  const budget = Number(maxBudget);
  if (!Number.isFinite(budget)) return null;
  return budget - (Number(spend) || 0);
}

// 최소제곱 직선회귀로 향후 지출을 예측한다.
// 반환: 하루 평균 증가액(slope)과 n일 뒤 누적 예측값.
function forecast(dailySeries, horizonDays) {
  const pts = dailySeries.map((v, i) => [i, v]).filter(([, v]) => v !== null);
  if (pts.length < 3) return null;
  const n = pts.length;
  const sx = pts.reduce((a, [x]) => a + x, 0);
  const sy = pts.reduce((a, [, y]) => a + y, 0);
  const sxx = pts.reduce((a, [x]) => a + x * x, 0);
  const sxy = pts.reduce((a, [x, y]) => a + x * y, 0);
  const denom = n * sxx - sx * sx;
  if (!denom) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const at = (x) => Math.max(0, intercept + slope * x);
  const future = Array.from({ length: horizonDays }, (_, k) => at(n - 1 + k + 1));
  // 관측 구간의 추세선(첫점~끝점)도 함께 넘겨 그래프에서 이어 그린다
  return { slope, fitStart: at(0), fitEnd: at(n - 1), future };
}

app.get("/api/analytics", requireAdmin, async (req, res) => {
  const days = Math.min(180, Math.max(7, Number(req.query.days) || 30));
  const horizon = Math.min(90, Math.max(1, Number(req.query.horizon) || 14));
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

    // 날짜 축을 빈 날 포함해 채운다
    const byDate = new Map();
    for (const r of results) {
      const cur = byDate.get(r.date) || { spend: 0, requests: 0, tokens: 0 };
      cur.spend += r.metrics?.spend || 0;
      cur.requests += r.metrics?.api_requests || 0;
      cur.tokens += r.metrics?.total_tokens || 0;
      byDate.set(r.date, cur);
    }
    const dates = [];
    const daily = [];
    for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
      const key = ymd(new Date(t));
      const v = byDate.get(key) || { spend: 0, requests: 0, tokens: 0 };
      dates.push(key);
      daily.push(v);
    }

    // 누적 시계열과 예측
    let running = 0;
    const cumulative = daily.map((d) => (running += d.spend));
    const fc = forecast(cumulative, horizon);
    const futureDates = Array.from({ length: horizon }, (_, k) => ymd(new Date(end.getTime() + (k + 1) * DAY_MS)));

    // 키별·모델별 집계 (breakdown에서 합산)
    const perKey = new Map();
    const perModel = new Map();
    for (const r of results) {
      for (const [hash, v] of Object.entries(r.breakdown?.api_keys || {})) {
        const cur = perKey.get(hash) || { spend: 0, requests: 0 };
        cur.spend += v.metrics?.spend || 0;
        cur.requests += v.metrics?.api_requests || 0;
        perKey.set(hash, cur);
      }
      for (const [m, v] of Object.entries(r.breakdown?.models || {})) {
        perModel.set(m, (perModel.get(m) || 0) + (v.metrics?.spend || 0));
      }
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
    const teamName = new Map(teams.map((t) => [t.team_id, t.team_alias || t.team_id.slice(0, 8)]));
    const meta = new Map(keyList.map((k) => [k.token, {
      alias: k.key_alias || k.token.slice(0, 8),
      team: k.team_id ? teamName.get(k.team_id) || "(삭제된 그룹)" : null,
      budget: k.max_budget ?? null,
    }]));

    // 지출이 0인 항목은 그래프를 어지럽히기만 하므로 제외한다
    // (삭제된 키의 잔여 기록, 호출만 실패한 키 등)
    const keyStats = [...perKey.entries()].map(([hash, v]) => {
      const m = meta.get(hash);
      const budget = m?.budget ?? null;
      return {
        alias: m?.alias || hash.slice(0, 8),
        team: m?.team || null,
        budget,
        max_budget: budget,
        remaining: remainingBudget(budget, v.spend),
        deleted: !m,
        ...v,
      };
    }).filter((k) => k.spend > 0).sort((a, b) => b.spend - a.spend);

    // 그룹별 합계
    const perTeam = new Map();
    for (const k of keyStats) {
      const name = k.team || "(그룹 없음)";
      perTeam.set(name, (perTeam.get(name) || 0) + k.spend);
    }

    res.json({
      dates,
      daily: daily.map((d) => d.spend),
      requests: daily.map((d) => d.requests),
      cumulative,
      futureDates,
      forecast: fc,
      keyStats,
      teamStats: [...perTeam.entries()].map(([name, spend]) => ({ name, spend }))
        .filter((t) => t.spend > 0).sort((a, b) => b.spend - a.spend),
      modelStats: [...perModel.entries()].map(([name, spend]) => ({ name, spend }))
        .filter((m) => m.spend > 0).sort((a, b) => b.spend - a.spend),
      totalSpend: cumulative.at(-1) || 0,
    });
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
    const data = await litellm("/key/generate", "POST", {
      key_alias: req.body.alias,
      team_id: req.body.team_id || undefined,
      ...keyParams(req.body),
    });
    console.log(`${req.adminEmail} 이(가) 키 발급: ${req.body.alias}`);
    res.json(data);
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
