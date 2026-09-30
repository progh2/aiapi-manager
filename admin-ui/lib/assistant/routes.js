// AI 엘피 API.
//   GET  /api/assistant/config   설정·이번 달 사용량 (학생은 쓸 수 있는지만)
//   POST /api/assistant/config   설정 저장 (관리자)
//   POST /api/assistant/models   모델 불러오기 (관리자, 저장 전 값으로도)
//   POST /api/assistant/test     연결 시험 (관리자)
//   POST /api/assistant/chat     대화. text/event-stream 으로 진행 상황과 답을 보낸다.
const crypto = require("crypto");
const llm = require("./llm");
const F = require("./facts");
const { NameMask } = require("./privacy");
const { toolsFor } = require("./tools");
const { runAssistant, probe } = require("./engine");
const { createDataView } = require("./data");
const { gradeModels } = require("./guide");

const MAX_RUNNING = 3;
const HOUR_MS = 3600000;

function createLimiter() {
  const hits = new Map();
  return {
    take(id, max) {
      const now = Date.now();
      const recent = (hits.get(id) || []).filter((t) => now - t < HOUR_MS);
      if (recent.length >= max) {
        hits.set(id, recent);
        return false;
      }
      recent.push(now);
      hits.set(id, recent);
      return true;
    },
  };
}

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

function mountAssistant(app, deps) {
  const {
    store, requireAdmin, requireRegistered, record, litellm, fetchAllKeys, listTeams,
    providersPublic, activityItems, analytics, auditLog, usersStore, proxyBase, publicProxyUrl,
  } = deps;
  const limiter = createLimiter();
  let running = 0;

  // 저장 전 화면 값으로 모델을 불러오거나 시험할 때 쓴다. 키를 새로 적지 않았으면 저장된 키를 쓴다.
  function draft(body = {}) {
    const cur = store.get();
    const d = { ...cur };
    if (body.mode === "direct" || body.mode === "proxy") d.mode = body.mode;
    if (body.provider && ["openai", "ollama", "compatible"].includes(body.provider)) {
      if (body.provider !== cur.provider) d.api_key = "";
      d.provider = body.provider;
    }
    if (body.base_url !== undefined) d.base_url = String(body.base_url || "").trim().replace(/\/+$/, "");
    if (typeof body.api_key === "string" && body.api_key.trim()) d.api_key = body.api_key.trim();
    if (body.model !== undefined) d.model = String(body.model || "").trim();
    if (body.proxy_model !== undefined) d.proxy_model = String(body.proxy_model || "").trim();
    if (d.base_url && !/^https?:\/\//i.test(d.base_url)) {
      const err = new Error("주소는 http:// 또는 https:// 로 시작해야 합니다");
      err.status = 400;
      throw err;
    }
    return d;
  }

  function connFor(cfg, { forTest = false } = {}) {
    const conn = llm.connectionFrom(cfg, { proxyBase });
    // 비서 전용 키를 만들기 전(저장 전) 시험은 마스터 키로 한다.
    if (cfg.mode === "proxy" && !conn.apiKey && forTest) conn.apiKey = deps.masterKey;
    return conn;
  }

  // 프록시 방식: LiteLLM 에 비서 전용 가상 키를 두고 예산·모델을 맞춘다. 사용량이 관리 화면 통계에 잡힌다.
  async function ensureProxyKey() {
    const cfg = store.get();
    const alias = cfg.proxy_key_alias || "aiapi-assistant";
    const keys = await fetchAllKeys();
    const existing = keys.find((k) => k.key_alias === alias);
    const params = {
      models: [cfg.proxy_model],
      max_budget: Number(cfg.proxy_budget) || 5,
      budget_duration: "30d",
      metadata: { ...((existing && existing.metadata) || {}), aiapi_system: "assistant" },
    };
    if (existing && cfg.proxy_key && existing.token === sha256(cfg.proxy_key)) {
      await litellm("/key/update", "POST", { key: existing.token, ...params });
      if (existing.blocked) await litellm("/key/unblock", "POST", { key: existing.token });
      return { created: false };
    }
    if (existing) await litellm("/key/delete", "POST", { keys: [existing.token] });
    const data = await litellm("/key/generate", "POST", { key_alias: alias, ...params });
    if (!data || !data.key) throw new Error("비서 전용 키를 만들지 못했습니다");
    store.setProxyKey(data.key);
    return { created: true };
  }

  app.get("/api/assistant/config", requireRegistered, (req, res) => {
    const view = store.publicView();
    if (req.user.role === "admin") return res.json(view);
    res.json({ available: Boolean(view.ready && view.allow_users), name: "AI 엘피" });
  });

  app.post("/api/assistant/config", requireAdmin, async (req, res) => {
    try {
      const before = store.get();
      store.update(req.body || {});
      const cfg = store.get();
      let proxyKey = null;
      if (cfg.mode === "proxy" && cfg.enabled && cfg.proxy_model) proxyKey = await ensureProxyKey();
      record(req, "assistant.config", "AI 엘피", {
        enabled: cfg.enabled,
        mode: cfg.mode,
        provider: cfg.mode === "proxy" ? "proxy" : cfg.provider,
        model: cfg.mode === "proxy" ? cfg.proxy_model : cfg.model,
        server: cfg.mode === "proxy" ? null : hostOf(cfg.base_url),
        mask_names: cfg.mask_names,
        allow_users: cfg.allow_users,
        secret_changed: Boolean(typeof req.body.api_key === "string" && req.body.api_key.trim()) || Boolean(req.body.clear_api_key),
        proxy_key_created: proxyKey ? proxyKey.created : undefined,
      }, `AI 엘피 설정: ${before.enabled ? "켜짐" : "꺼짐"} → ${cfg.enabled ? "켜짐" : "꺼짐"} · ${cfg.mode === "proxy" ? cfg.proxy_model : cfg.model || "모델 없음"}`);
      res.json(store.publicView());
    } catch (e) {
      res.status(e.status || 502).json({ error: e.message });
    }
  });

  app.post("/api/assistant/models", requireAdmin, async (req, res) => {
    try {
      const cfg = draft(req.body);
      let models;
      let provider;
      if (cfg.mode === "proxy") {
        const data = await litellm("/v1/models");
        models = (data.data || []).map((m) => ({ id: m.id, tools: null }));
        provider = "proxy";
      } else {
        if (cfg.provider === "openai" && !cfg.api_key) return res.status(400).json({ error: "OpenAI API 키를 먼저 넣으세요" });
        if (cfg.provider !== "openai" && !cfg.base_url) return res.status(400).json({ error: "서버 주소를 먼저 넣으세요" });
        models = await llm.listModels(connFor(cfg));
        provider = cfg.provider;
      }
      res.json({ models: gradeModels(models, provider), provider });
    } catch (e) {
      res.status(e.status && e.status < 600 ? e.status : 502).json({ error: e.message });
    }
  });

  app.post("/api/assistant/test", requireAdmin, async (req, res) => {
    try {
      const cfg = draft(req.body);
      const conn = connFor(cfg, { forTest: true });
      if (!conn.model) return res.status(400).json({ error: "모델을 먼저 고르세요" });
      if (cfg.mode !== "proxy" && cfg.provider === "openai" && !conn.apiKey) return res.status(400).json({ error: "OpenAI API 키를 먼저 넣으세요" });
      const out = await probe(conn, { fast: cfg.fast_mode !== false, numCtx: cfg.num_ctx });
      store.setLastTest({ ok: true, tools_ok: out.tools_ok, latency_ms: out.latency_ms, model: out.model, note: out.note });
      store.addUsage(out.usage);
      res.json(out);
    } catch (e) {
      try { store.setLastTest({ ok: false, error: e.message, model: req.body && (req.body.model || req.body.proxy_model) }); } catch { /* 손상된 설정 파일 */ }
      res.status(e.status && e.status < 600 ? e.status : 502).json({ error: e.message, code: e.code || null });
    }
  });

  app.post("/api/assistant/chat", requireRegistered, async (req, res) => {
    const cfg = store.get();
    const role = req.user.role === "admin" ? "admin" : "user";
    if (!store.ready(cfg)) {
      return res.status(409).json({ error: role === "admin" ? "AI 엘피가 아직 설정되지 않았습니다. 09 AI 엘피 화면에서 모델을 연결하세요." : "AI 엘피를 쓸 수 없습니다" });
    }
    if (role !== "admin" && !cfg.allow_users) return res.status(403).json({ error: "선생님이 학생용 엘피 상담을 켜지 않았습니다" });
    if (store.capReached()) return res.status(429).json({ error: "이번 달 엘피 사용 한도(토큰)를 다 썼습니다. AI 엘피 설정에서 한도를 늘릴 수 있습니다." });
    if (!limiter.take(req.user.email, role === "admin" ? 120 : 20)) {
      return res.status(429).json({ error: "질문이 너무 잦습니다. 잠시 뒤에 다시 물어봐 주세요." });
    }
    if (running >= MAX_RUNNING) return res.status(429).json({ error: "엘피가 다른 질문에 답하는 중입니다. 조금 뒤에 다시 물어봐 주세요." });
    const question = String((req.body && req.body.question) || "").trim();
    if (!question) return res.status(400).json({ error: "질문을 적어 주세요" });

    running += 1;
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableFinished) ac.abort(); });
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const send = (event, data) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const beat = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 15000);

    const now = new Date();
    try {
      const myAliases = new Set(req.user.key_aliases || []);
      const view = createDataView({
        keys: fetchAllKeys,
        teams: listTeams,
        providers: providersPublic,
        activity: activityItems,
        analytics,
        audit: (opts) => auditLog.list(opts),
        myKeys: async () => (await fetchAllKeys()).filter((k) => myAliases.has(k.key_alias)),
        myActivity: async () => {
          const mine = (await fetchAllKeys()).filter((k) => myAliases.has(k.key_alias));
          const items = [];
          for (const key of mine.slice(0, 10)) items.push(...await activityItems({ hours: 24 * 7, limit: 20, token: key.token }));
          return items.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30);
        },
      });
      send("status", { phase: "thinking", label: "상황을 살피는 중" });

      let snapshot;
      let maskSource;
      if (role === "admin") {
        const [keys, teams, providers, activity] = await Promise.all([
          view.keys(), view.teams(), view.providers().catch(() => []), view.activity({ hours: 24, limit: 100 }).catch(() => []),
        ]);
        snapshot = F.snapshotText({ keys, teams, providers, activity }, now);
        maskSource = { keys, users: usersStore.isCorrupt() ? [] : usersStore.list() };
      } else {
        const [keys, teams] = await Promise.all([view.myKeys(), view.teams().catch(() => [])]);
        const teamsById = new Map(teams.map((t) => [t.team_id, t]));
        snapshot = keys.length
          ? keys.map((k) => {
            const f = F.keyFact(k, teamsById, now);
            return `- ${f.alias}: ${f.state}, ${f.spend} / ${f.budget}${f.expires ? `, 만료 ${f.expires}` : ""}${f.class ? `, ${f.class}` : ""}`;
          }).join("\n")
          : "- 연결된 키가 없습니다. 선생님께 키 연결을 부탁해야 합니다.";
        maskSource = { keys, users: [{ name: req.user.name }] };
      }
      const mask = cfg.mask_names && store.isExternal(cfg) ? NameMask.fromData(maskSource) : NameMask.none();
      const conn = connFor(cfg);
      const out = await runAssistant({
        conn,
        question,
        history: req.body.history,
        role,
        station: String(req.body.station || "bridge"),
        tools: toolsFor(role),
        ctx: { data: view, now, proxyUrl: publicProxyUrl(req), user: req.user },
        snapshot,
        mask,
        options: { maxTokens: cfg.max_output_tokens, numCtx: cfg.num_ctx, fast: cfg.fast_mode !== false },
        emit: send,
        signal: ac.signal,
      });
      store.addUsage(out.usage);
      console.log(`[assistant] ${req.user.email} · ${role} · ${out.usage.steps}단계 · ${out.elapsed_ms}ms · 토큰 ${out.usage.prompt_tokens}+${out.usage.completion_tokens}${mask.size ? ` · 이름 ${mask.size}개 가림` : ""}`);
      send("done", { ok: true });
    } catch (e) {
      if (e.code !== "aborted") console.error(`[assistant] ${req.user.email} 실패:`, e.message);
      // 학생에게는 서버 주소·방화벽 같은 설정 안내 대신 쉬운 말로 알린다.
      const message = role === "admin" ? e.message : "엘피가 지금 대답할 수 없어요. 잠시 뒤에 다시 물어보거나 선생님께 알려 주세요.";
      send("error", { message, code: e.code || null });
    } finally {
      running -= 1;
      clearInterval(beat);
      if (!res.writableEnded) res.end();
    }
  });
}

module.exports = { mountAssistant, createLimiter };
