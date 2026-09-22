#!/usr/bin/env node
// Firebase·LiteLLM 없이 학급 일괄 부여·만료 회수 UI를 로컬에서 확인한다. 배포에 쓰지 않는다.
const fs = require("fs");
const path = require("path");
const express = require("express");
const { assignClassBudgets, keyGenerateParams } = require("./lib/class-assign");
const { revokeKeys } = require("./lib/key-revoke");
const { adjustKey, keyDetail } = require("./lib/key-adjust");
const { resolveIssueModels, simulateChatCompletion } = require("./lib/model-allowlist");
const { issueCampKeys, campIssuePolicy, revokeCampKeys, todayYmd } = require("./lib/camp-keys");

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
    models: ["gpt-4o-mini"],
  });
  teams.push({
    team_id: "team-2",
    team_alias: "캠프1일차",
    max_budget: 20,
    spend: 0.5,
    budget_duration: null,
    models: ["gpt-4o-mini"],
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
    metadata: {
      aiapi_history: [{
        at: new Date(Date.now() - 20 * 86400000).toISOString(),
        by: "teacher@school.kr",
        add_budget: 1,
        max_budget_before: 1,
        max_budget_after: 2,
      }],
    },
  });
  add({
    token: "sk-mock-20261002-김철수",
    key_alias: "20261002-김철수",
    team_id: "team-1",
    max_budget: 2,
    spend: 2.4,
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
    key_alias: "CAMP-OLD1",
    team_id: "team-2",
    max_budget: 1,
    spend: 0.3,
    expires: new Date(Date.now() - 2 * 86400000).toISOString(),
    blocked: true,
    metadata: {
      aiapi_camp: {
        kind: "camp",
        code: "CAMP-OLD1",
        prefix: "CAMP",
        expires_ymd: todayYmd(new Date(Date.now() - 2 * 86400000)),
        models: ["gpt-4o-mini"],
        schedule_revoke: { at: "end_of_day", filter: "camp_due", action: "block" },
      },
    },
  });
  add({
    token: "sk-CAMP-DEMO",
    key_alias: "CAMP-DEMO",
    team_id: "team-2",
    max_budget: 1,
    spend: 0.05,
    expires: new Date(new Date().setHours(23, 59, 59, 999)).toISOString(),
    models: ["gpt-4o-mini"],
    metadata: {
      aiapi_camp: {
        kind: "camp",
        code: "CAMP-DEMO",
        prefix: "CAMP",
        expires_ymd: todayYmd(),
        models: ["gpt-4o-mini"],
        schedule_revoke: { at: "end_of_day", filter: "camp_due", action: "block" },
      },
    },
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
  add({
    token: "sk-mock-unlim-used",
    key_alias: "교사-실습",
    team_id: null,
    max_budget: null,
    spend: 0.55,
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
      models: Array.isArray(body.models) ? body.models : [],
    };
    teams.push(t);
    return t;
  }
  if (p === "/team/update") {
    const t = teams.find((x) => x.team_id === body.team_id);
    if (!t) throw new Error("학급 없음");
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
    if (keys.some((k) => k.key_alias === body.key_alias || (body.key && k.token === body.key))) {
      throw new Error("alias already exists");
    }
    const token = body.key || ("sk-mock-" + body.key_alias);
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
      metadata: body.metadata || {},
    };
    if (body.duration && /^\d+s$/.test(body.duration)) {
      rec.expires = new Date(Date.now() + Number(body.duration.slice(0, -1)) * 1000).toISOString();
    }
    keys.push(rec);
    return rec;
  }
  if (p.startsWith("/key/list")) return { keys, total_pages: 1 };
  if (p.startsWith("/key/info")) {
    const q = new URL("http://x" + p);
    const tok = q.searchParams.get("key");
    const k = keys.find((x) => x.token === tok);
    if (!k) throw new Error("키 없음");
    return { key: k.token, info: k };
  }
  if (p === "/key/update") {
    const k = keys.find((x) => x.token === body.key);
    if (!k) throw new Error("키 없음");
    if (body.max_budget !== undefined) k.max_budget = body.max_budget;
    if (body.budget !== undefined && body.budget !== "") k.max_budget = Number(body.budget);
    if (body.metadata) k.metadata = body.metadata;
    if (body.budget_duration !== undefined) k.budget_duration = body.budget_duration;
    if (body.rpm_limit !== undefined) k.rpm_limit = body.rpm_limit;
    if (body.tpm_limit !== undefined) k.tpm_limit = body.tpm_limit;
    if (Array.isArray(body.models)) k.models = body.models;
    if (body.duration) {
      if (/^\d+s$/.test(body.duration)) {
        k.expires = new Date(Date.now() + Number(body.duration.slice(0, -1)) * 1000).toISOString();
      } else if (/^\d+d$/.test(body.duration)) {
        k.expires = new Date(Date.now() + Number(body.duration.slice(0, -1)) * 86400000).toISOString();
      }
    }
    return k;
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
app.get("/api/me", (_req, res) => {
  res.json({ email: "teacher@school.kr", name: "teacher", role: "admin", key_aliases: [] });
});
const mockUsers = [];
app.get("/api/users", (_req, res) => res.json({ users: mockUsers }));
app.post("/api/users", (req, res) => {
  const user = {
    email: String(req.body.email || "").toLowerCase(),
    name: req.body.name || req.body.email,
    key_aliases: req.body.key_aliases || [],
  };
  mockUsers.push(user);
  res.json(user);
});
app.post("/api/users/delete", (req, res) => {
  const i = mockUsers.findIndex((u) => u.email === String(req.body.email || "").toLowerCase());
  if (i >= 0) mockUsers.splice(i, 1);
  res.json({ ok: true });
});
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
  const body = { team_id: req.body.team_id, ...keyGenerateParams(req.body) };
  if (Array.isArray(req.body.models)) body.models = req.body.models;
  litellm("/team/update", "POST", body).then((d) => res.json(d))
    .catch((e) => res.status(502).json({ error: e.message }));
});
app.post("/api/teams/delete", (req, res) => {
  litellm("/team/delete", "POST", { team_ids: [req.body.team_id] }).then((d) => res.json(d))
    .catch((e) => res.status(502).json({ error: e.message }));
});
app.get("/api/keys", (_req, res) => res.json({ keys }));
app.post("/api/keys", async (req, res) => {
  try {
    const params = keyGenerateParams(req.body);
    const team = teams.find((t) => t.team_id === req.body.team_id);
    const models = resolveIssueModels(req.body.models, team && team.models);
    if (models.length) params.models = models;
    else delete params.models;
    res.json(await litellm("/key/generate", "POST", {
      key_alias: req.body.alias,
      team_id: req.body.team_id || undefined,
      ...params,
    }));
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});
app.post("/api/mock/chat", (req, res) => {
  try {
    const k = keys.find((x) => x.token === req.body.token);
    if (!k) return res.status(404).json({ error: "키 없음" });
    const team = teams.find((t) => t.team_id === k.team_id);
    const out = simulateChatCompletion({
      model: req.body.model,
      keyModels: k.models,
      teamModels: team && team.models,
    });
    res.json(out);
  } catch (e) {
    res.status(e.status || 403).json({ error: e.message });
  }
});
app.post("/api/keys/bulk", async (req, res) => {
  try {
    res.json(await assignClassBudgets(req.body, { litellm }));
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});
app.post("/api/keys/camp", async (req, res) => {
  try {
    res.json(await issueCampKeys(req.body, { litellm }));
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});
app.get("/api/keys/camp/policy", (_req, res) => {
  res.json({ ...campIssuePolicy(), expires: todayYmd() });
});
app.post("/api/keys/camp/revoke", async (req, res) => {
  try {
    res.json(await revokeCampKeys(req.body, { litellm }));
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});
app.get("/api/keys/info", async (req, res) => {
  try {
    res.json(await keyDetail(req.query.token, { litellm }));
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});
app.post("/api/keys/adjust", async (req, res) => {
  try {
    res.json(await adjustKey(req.body, { litellm, actor: "teacher@school.kr" }));
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
app.get("/api/analytics", (req, res) => {
  const teamId = String(req.query.team_id || "");
  const selectedTeam = teamId ? teams.find((t) => t.team_id === teamId) || null : null;
  if (teamId && !selectedTeam) return res.status(400).json({ error: "알 수 없는 학급/조입니다" });
  const dates = [];
  const baseDaily = [];
  const now = Date.now();
  for (let i = 13; i >= 0; i--) {
    dates.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
    baseDaily.push(Number((0.15 + (13 - i) * 0.04).toFixed(3)));
  }
  const allSpend = keys.reduce((sum, k) => sum + (k.spend || 0), 0);
  const scopedKeys = teamId ? keys.filter((k) => k.team_id === teamId) : keys;
  const scopedSpend = scopedKeys.reduce((sum, k) => sum + (k.spend || 0), 0);
  const ratio = teamId && allSpend > 0 ? scopedSpend / allSpend : 1;
  const daily = baseDaily.map((v) => Number((v * ratio).toFixed(3)));
  const cumulative = [];
  daily.reduce((sum, v, i) => { cumulative[i] = Number((sum + v).toFixed(3)); return cumulative[i]; }, 0);
  const teamName = (id) => teams.find((t) => t.team_id === id)?.team_alias || null;
  const keyStats = scopedKeys
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
  const perTeam = new Map();
  for (const k of keyStats) {
    const name = k.team || "학급 없음";
    const cur = perTeam.get(name) || { name, spend: 0, budget: null, max_budget: null, remaining: null };
    cur.spend = Number((cur.spend + k.spend).toFixed(3));
    if (k.team) {
      const team = teams.find((t) => (t.team_alias || t.team_id.slice(0, 8)) === k.team);
      const budget = team?.max_budget ?? null;
      cur.budget = budget;
      cur.max_budget = budget;
      cur.remaining = budget == null ? null : Number((budget - cur.spend).toFixed(3));
    }
    perTeam.set(name, cur);
  }
  const budgetTotal = teamId
    ? (selectedTeam?.max_budget ?? null)
    : teams.reduce((sum, t) => sum + (t.max_budget || 0), 0);
  res.json({
    dates, daily, requests: daily.slice(), cumulative,
    futureDates: [], forecast: null, keyStats, teamStats: [...perTeam.values()],
    modelStats: [{ name: "gpt-4o-mini", spend: cumulative.at(-1) || 0 }],
    totalSpend: cumulative.at(-1) || 0,
    budget: {
      total: budgetTotal,
      remaining: budgetTotal == null ? null : Number((budgetTotal - (cumulative.at(-1) || 0)).toFixed(3)),
      team_id: selectedTeam?.team_id || null,
      team: selectedTeam?.team_alias || null,
    },
  });
});

app.listen(PORT, () => {
  console.log(`admin-ui mock http://127.0.0.1:${PORT}  (학급 일괄·캠프 짧은 키·모델 제한·당일 회수 데모)`);
});
