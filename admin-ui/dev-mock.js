#!/usr/bin/env node
// Firebase·LiteLLM 없이 학급 일괄 부여 UI를 로컬에서 확인한다. 배포에 쓰지 않는다.
const fs = require("fs");
const path = require("path");
const express = require("express");
const { assignClassBudgets, keyGenerateParams } = require("./lib/class-assign");

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
app.use(express.static(path.join(__dirname, "public")));

const teams = [];
const keys = [];

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
  if (p === "/key/update") return body;
  if (p === "/key/block" || p === "/key/unblock") return { blocked: p === "/key/block" };
  if (p === "/key/delete") return { deleted: 1 };
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
app.post("/api/keys/update", (req, res) => res.json({ ok: true }));
app.post("/api/keys/block", (req, res) => res.json({ ok: true }));
app.post("/api/keys/delete", (req, res) => res.json({ ok: true }));
app.get("/api/analytics", (_req, res) => {
  const dates = [];
  const daily = [];
  const now = Date.now();
  for (let i = 13; i >= 0; i--) {
    dates.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
    daily.push(0);
  }
  res.json({
    dates, daily, requests: daily.slice(), cumulative: daily.slice(),
    futureDates: [], forecast: null, keyStats: [], teamStats: [], modelStats: [],
    totalSpend: 0,
  });
});

app.listen(PORT, () => {
  console.log(`admin-ui mock http://127.0.0.1:${PORT}  (학급 일괄 예산 데모)`);
});
