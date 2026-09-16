#!/usr/bin/env node
// Firebase·LiteLLM 없이 학급 일괄 부여·만료 회수 UI를 로컬에서 확인한다. 배포에 쓰지 않는다.
const fs = require("fs");
const path = require("path");
const express = require("express");
const { assignClassBudgets, keyGenerateParams } = require("./lib/class-assign");
const { revokeKeys } = require("./lib/key-revoke");

const PORT = Number(process.env.PORT || 3456);
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  const html = fs.readFileSync(path.join(__dirname, "public/index.html"), "utf8")
    .replace(
      '<script src="firebase-config.js"></script>',
      `<script>window.ADMIN_UI_MOCK=true;window.FIREBASE_CONFIG={apiKey:"demo",authDomain:"demo",projectId:"demo"};</script>`
    );
  res.type("html").send(html);
});
app.get("/roster.js", (_req, res) => {
  res.type("application/javascript").sendFile(path.join(__dirname, "lib/roster.js"));
});
app.get("/key-revoke.js", (_req, res) => {
  res.type("application/javascript").sendFile(path.join(__dirname, "lib/key-revoke.js"));
});
app.use(express.static(path.join(__dirname, "public")));

const teams = [];
const keys = [];

function seedDemo() {
  teams.push({
    team_id: "team-1",
    team_alias: "3학년A반",
    max_budget: 50,
    spend: 4.2,
    budget_duration: "30d",
  });
  teams.push({
    team_id: "team-2",
    team_alias: "캠프1일차",
    max_budget: 20,
    spend: 0.5,
    budget_duration: null,
  });
  const add = (rec) => {
    keys.push({
      spend: 0.1,
      models: ["gpt-4o-mini"],
      rpm_limit: 10,
      tpm_limit: null,
      budget_duration: "30d",
      blocked: false,
      ...rec,
      key: rec.token,
    });
  };
  add({
    token: "sk-mock-20261001-홍길동",
    key_alias: "20261001-홍길동",
    team_id: "team-1",
    max_budget: 2,
    spend: 1.2,
    expires: new Date(Date.now() - 3 * 86400000).toISOString(),
  });
  add({
    token: "sk-mock-20261002-김철수",
    key_alias: "20261002-김철수",
    team_id: "team-1",
    max_budget: 2,
    spend: 2,
    expires: new Date(Date.now() - 86400000).toISOString(),
  });
  add({
    token: "sk-mock-20261003-이영희",
    key_alias: "20261003-이영희",
    team_id: "team-1",
    max_budget: 2,
    spend: 0.4,
    expires: new Date(Date.now() + 3 * 86400000).toISOString(),
  });
  add({
    token: "sk-mock-20261004-박민수",
    key_alias: "20261004-박민수",
    team_id: "team-1",
    max_budget: 2,
    spend: 0.8,
    expires: new Date(Date.now() + 90 * 86400000).toISOString(),
  });
  add({
    token: "sk-mock-camp-expired",
    key_alias: "camp-만료게스트",
    team_id: "team-2",
    max_budget: 1,
    spend: 0.3,
    expires: new Date(Date.now() - 2 * 86400000).toISOString(),
    blocked: true,
  });
  add({
    token: "sk-mock-unlimited",
    key_alias: "교사-시연",
    team_id: null,
    max_budget: null,
    spend: 0,
    expires: null,
    budget_duration: null,
    models: [],
    rpm_limit: null,
  });
}
seedDemo();

async function litellm(p, method = "GET", body) {
  if (p === "/team/list") return { teams };
  if (p === "/team/new") {
    const t = {
      team_id: "team-" + (teams.length + 1),
      team_alias: body.team_alias,
      max_budget: body.max_budget ?? null,
      spend: 0,
      budget_duration: body.budget_duration || null,
    };
    teams.push(t);
    return t;
  }
  if (p === "/team/update") {
    const t = teams.find((x) => x.team_id === body.team_id);
    if (!t) throw new Error("그룹 없음");
    Object.assign(t, body);
    return t;
  }
  if (p === "/team/delete") {
    const id = (body.team_ids || [])[0];
    const i = teams.findIndex((x) => x.team_id === id);
    if (i >= 0) teams.splice(i, 1);
    return { deleted: 1 };
  }
  if (p === "/key/generate") {
    if (keys.some((k) => k.key_alias === body.key_alias)) {
      throw new Error("alias already exists");
    }
    const token = "sk-mock-" + body.key_alias;
    const rec = {
      token,
      key: token,
      key_alias: body.key_alias,
      team_id: body.team_id || null,
      max_budget: body.max_budget ?? null,
      budget_duration: body.budget_duration || null,
      duration: body.duration || null,
      expires: body.duration ? new Date(Date.now() + 86400000).toISOString() : null,
      spend: 0,
      models: body.models || [],
      rpm_limit: body.rpm_limit,
      tpm_limit: body.tpm_limit,
      blocked: false,
    };
    if (body.duration && /^\d+s$/.test(body.duration)) {
      rec.expires = new Date(Date.now() + Number(body.duration.slice(0, -1)) * 1000).toISOString();
    }
    keys.push(rec);
    return rec;
  }
  if (p.startsWith("/key/list")) return { keys, total_pages: 1 };
  if (p === "/key/update") {
    const k = keys.find((x) => x.token === body.key);
    if (k) Object.assign(k, body);
    return k || body;
  }
  if (p === "/key/block" || p === "/key/unblock") {
    const k = keys.find((x) => x.token === body.key);
    if (!k) throw new Error("키 없음");
    k.blocked = p === "/key/block";
    return { blocked: k.blocked };
  }
  if (p === "/key/delete") {
    let deleted = 0;
    for (const tok of body.keys || []) {
      const i = keys.findIndex((x) => x.token === tok);
      if (i >= 0) {
        keys.splice(i, 1);
        deleted += 1;
      }
    }
    if (!deleted) throw new Error("키 없음");
    return { deleted };
  }
  if (p === "/v1/models") return { data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }] };
  if (p.startsWith("/user/daily/activity")) return { results: [], metadata: { total_pages: 1 } };
  throw new Error("mock 미구현: " + p);
}

app.get("/health", (_req, res) => res.json({ status: "ok", mock: true }));
app.get("/api/models", async (_req, res) => {
  res.json({ models: (await litellm("/v1/models")).data.map((m) => m.id) });
});
app.get("/api/teams", (_req, res) => res.json({ teams }));
app.post("/api/teams", (req, res) => {
  litellm("/team/new", "POST", { team_alias: req.body.alias, ...keyGenerateParams(req.body) })
    .then((d) => res.json(d))
    .catch((e) => res.status(502).json({ error: e.message }));
});
app.post("/api/teams/update", (req, res) => {
  litellm("/team/update", "POST", req.body).then((d) => res.json(d))
    .catch((e) => res.status(502).json({ error: e.message }));
});
app.post("/api/teams/delete", (req, res) => {
  litellm("/team/delete", "POST", { team_ids: [req.body.team_id] }).then((d) => res.json(d))
    .catch((e) => res.status(502).json({ error: e.message }));
});
app.get("/api/keys", (_req, res) => res.json({ keys }));
app.post("/api/keys", async (req, res) => {
  try {
    res.json(await litellm("/key/generate", "POST", {
      key_alias: req.body.alias,
      team_id: req.body.team_id || undefined,
      ...keyGenerateParams(req.body),
    }));
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});
app.post("/api/keys/bulk", async (req, res) => {
  try {
    res.json(await assignClassBudgets(req.body, { litellm }));
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});
app.post("/api/keys/update", (req, res) => {
  litellm("/key/update", "POST", { key: req.body.token, ...req.body })
    .then((d) => res.json(d))
    .catch((e) => res.status(502).json({ error: e.message }));
});
app.post("/api/keys/block", (req, res) => {
  const path = req.body.blocked ? "/key/block" : "/key/unblock";
  litellm(path, "POST", { key: req.body.token })
    .then((d) => res.json(d))
    .catch((e) => res.status(502).json({ error: e.message }));
});
app.post("/api/keys/delete", (req, res) => {
  litellm("/key/delete", "POST", { keys: req.body.keys })
    .then((d) => res.json(d))
    .catch((e) => res.status(502).json({ error: e.message }));
});
app.post("/api/keys/revoke", async (req, res) => {
  try {
    res.json(await revokeKeys(req.body, { litellm }));
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});
app.get("/api/analytics", (_req, res) => {
  const dates = [];
  const daily = [];
  const now = Date.now();
  for (let i = 13; i >= 0; i--) {
    dates.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
    daily.push(Number((0.15 + (13 - i) * 0.04).toFixed(3)));
  }
  const cumulative = [];
  daily.reduce((sum, v, i) => { cumulative[i] = Number((sum + v).toFixed(3)); return cumulative[i]; }, 0);
  const teamName = (id) => teams.find((t) => t.team_id === id)?.team_alias || null;
  const keyStats = keys
    .filter((k) => k.spend > 0)
    .map((k) => ({
      alias: k.key_alias,
      team: teamName(k.team_id),
      spend: k.spend,
      budget: k.max_budget ?? null,
      max_budget: k.max_budget ?? null,
      remaining: k.max_budget == null ? null : Number((k.max_budget - k.spend).toFixed(3)),
      requests: Math.max(1, Math.round(k.spend * 40)),
    }))
    .sort((a, b) => b.spend - a.spend);
  // 차트 폴백·초과 문구 확인용: 무제한 키와 예산 초과 키
  if (!keyStats.some((k) => k.remaining == null)) {
    keyStats.push({
      alias: "교사-실습", team: null, spend: 0.55, budget: null,
      max_budget: null, remaining: null, requests: 12,
    });
  }
  const over = keyStats.find((k) => k.alias === "20261002-김철수");
  if (over && over.remaining >= 0) {
    over.spend = 2.4;
    over.remaining = -0.4;
    over.requests = 96;
  }
  const perTeam = new Map();
  for (const k of keyStats) {
    const name = k.team || "(그룹 없음)";
    perTeam.set(name, Number(((perTeam.get(name) || 0) + k.spend).toFixed(3)));
  }
  const teamStats = [...perTeam.entries()].map(([name, spend]) => ({ name, spend }));
  res.json({
    dates, daily, requests: daily.slice(), cumulative,
    futureDates: [], forecast: null, keyStats, teamStats,
    modelStats: [{ model: "gpt-4o-mini", spend: cumulative.at(-1) || 0 }],
    totalSpend: cumulative.at(-1) || 0,
  });
});

app.listen(PORT, () => {
  console.log(`admin-ui mock http://127.0.0.1:${PORT}  (학급 일괄 예산·만료 회수 데모)`);
});
