// 최근 호출 기록. LiteLLM /spend/logs/v2 행에서 화면에 필요한 값만 뽑는다.
// 프롬프트·응답·요청 본문은 옮기지 않는다. 오류 문구 속 키 조각은 가린다.

const PAGE_MAX = 100;

// 위에서부터 먼저 맞는 규칙을 쓴다. 문구는 교사가 학생에게 그대로 전할 수 있게 쓴다.
const REASONS = [
  { code: "schedule", label: "수업 시간대 밖", re: /쓸 수 있는 시간이 아닙니다|outside.*schedule/i },
  { code: "blocked", label: "차단된 키", re: /key is blocked|blocked key/i },
  { code: "expired", label: "만료된 키", re: /expired key|key expir|has expired/i },
  { code: "provider_budget", label: "공급자 키 한도 소진", re: /user=(provider|pool):\S*\s+over budget|(provider|pool):\S+.*budget/i },
  { code: "team_budget", label: "학급 예산 초과", re: /team.*(over budget|budget.*exceeded|exceeded.*budget)|budget.*team/i },
  { code: "budget", label: "예산 초과", re: /budget has been exceeded|exceededbudget|budget.*exceeded|over budget|max budget/i },
  // 새 LiteLLM 은 ModelAccessDeniedProxyException + "The requested model '…' is not available for this API key" 로 남긴다.
  { code: "model_denied", label: "허용 안 된 모델", re: /not allowed to access model|model.*not allowed|model.?access.?denied|not available for this api key|허용 목록에 없습니다/i },
  { code: "invalid_key", label: "잘못된 키", re: /invalid proxy server token|invalid api key passed|no api key passed|authentication error, invalid/i },
  { code: "rate_limit", label: "속도 제한(RPM/TPM)", re: /rate limit|ratelimit|crossed tpm|crossed rpm|max parallel request|too many requests|\b429\b/i },
  { code: "provider_quota", label: "공급자 요금 한도", re: /insufficient_quota|exceeded your current quota|billing/i },
  { code: "provider_auth", label: "공급자 키 인증 실패", re: /incorrect api key|invalid x-api-key|api key not valid|authenticationerror|permission denied|401/i },
  { code: "context_length", label: "입력이 너무 김", re: /context length|context_length|maximum context|too many tokens/i },
  { code: "content_policy", label: "콘텐츠 정책 거부", re: /content.?policy|safety/i },
  { code: "model_not_found", label: "없는 모델 이름", re: /model_not_found|invalid model name|notfounderror|does not exist/i },
  { code: "timeout", label: "응답 시간 초과", re: /timeout|timed out/i },
  { code: "provider_down", label: "공급자 서버 오류", re: /serviceunavailable|internalservererror|\b50[0-9]\b|overloaded/i },
];

function redact(text) {
  return String(text || "")
    .replace(/sk-[A-Za-z0-9_\-*.]{4,}/g, "sk-…")
    .replace(/\b[a-f0-9]{32,}\b/gi, "…")
    .replace(/Bearer\s+\S+/gi, "Bearer …")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function errorInfo(row) {
  const md = (row && row.metadata) || {};
  const info = md.error_information && typeof md.error_information === "object" ? md.error_information : {};
  return {
    message: String(info.error_message || md.error_message || "").trim(),
    klass: String(info.error_class || "").trim(),
    code: String(info.error_code || "").trim(),
  };
}

function explainFailure(row) {
  const { message, klass, code } = errorInfo(row);
  const hay = `${message} ${klass} ${code}`;
  for (const r of REASONS) {
    if (r.re.test(hay)) return { reason_code: r.code, reason: r.label };
  }
  if (!message && !klass) return { reason_code: "unknown", reason: "실패" };
  return { reason_code: "other", reason: klass || "오류" };
}

function isFailure(row) {
  const status = String((row && row.status) || (row && row.metadata && row.metadata.status) || "").toLowerCase();
  if (status) return status === "failure" || status === "error" || status === "failed";
  return Boolean(errorInfo(row).message);
}

function durationMs(row) {
  if (row.request_duration_ms != null && Number.isFinite(Number(row.request_duration_ms))) {
    return Math.round(Number(row.request_duration_ms));
  }
  const a = Date.parse(row.startTime || "");
  const b = Date.parse(row.endTime || "");
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
}

function toActivity(row, { keysByToken = new Map(), teamsById = new Map() } = {}) {
  const md = (row && row.metadata) || {};
  const token = String(row.api_key || md.user_api_key || "");
  const key = keysByToken.get(token) || null;
  const teamId = row.team_id || md.user_api_key_team_id || (key && key.team_id) || null;
  const team = teamsById.get(teamId) || null;
  const failed = isFailure(row);
  const out = {
    id: row.request_id || md.litellm_call_id || null,
    at: row.startTime || row.created_at || null,
    token: token || null,
    alias: md.user_api_key_alias || (key && key.key_alias) || null,
    team_id: teamId,
    team: md.user_api_key_team_alias || (team && (team.team_alias || String(team.team_id).slice(0, 8))) || null,
    model: row.model_group || row.model || null,
    provider: row.custom_llm_provider || null,
    tokens: Number(row.total_tokens) || 0,
    prompt_tokens: Number(row.prompt_tokens) || 0,
    completion_tokens: Number(row.completion_tokens) || 0,
    spend: Number(row.spend) || 0,
    ok: !failed,
    duration_ms: durationMs(row),
    ip: row.requester_ip_address || md.requester_ip_address || null,
  };
  if (failed) {
    Object.assign(out, explainFailure(row));
    const msg = errorInfo(row).message;
    out.error = msg ? redact(msg) : null;
  } else if (isUnpriced(row, out)) {
    // 토큰은 썼는데 비용이 정확히 0: LiteLLM 가격표에 없는 모델이다. 예산이 줄지 않는다.
    out.unpriced = true;
  }
  return out;
}

// 로컬 Ollama(무료)와 캐시 적중은 0원이 맞으므로 뺀다.
function isUnpriced(row, out) {
  if (!(out.tokens > 0) || out.spend !== 0) return false;
  if (/ollama/i.test(String(out.provider || "")) || /^ollama/i.test(String(row.model || ""))) return false;
  if (String(row.cache_hit || "").toLowerCase() === "true") return false;
  return true;
}

function summarizeActivity(items) {
  const byReason = {};
  const aliases = new Set();
  const unpricedModels = new Set();
  let unpriced = 0;
  let ok = 0;
  let spend = 0;
  let tokens = 0;
  for (const it of items || []) {
    if (it.alias) aliases.add(it.alias);
    spend += Number(it.spend) || 0;
    tokens += Number(it.tokens) || 0;
    if (it.ok) ok += 1;
    else byReason[it.reason_code || "unknown"] = (byReason[it.reason_code || "unknown"] || 0) + 1;
    if (it.unpriced) {
      unpriced += 1;
      if (it.model) unpricedModels.add(it.model);
    }
  }
  const total = (items || []).length;
  return {
    total,
    ok,
    failed: total - ok,
    spend: Math.round(spend * 1e6) / 1e6,
    tokens,
    active_keys: aliases.size,
    by_reason: byReason,
    unpriced,
    unpriced_models: [...unpricedModels].slice(0, 5),
  };
}

// LiteLLM 은 v2 날짜를 "YYYY-MM-DD HH:MM:SS"(UTC)로 받는다.
function utcStamp(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function activityQuery({ limit = 50, hours = 24, now = new Date(), modelGroup = "", status = "" } = {}) {
  const size = Math.min(PAGE_MAX, Math.max(1, Number(limit) || 50));
  const span = Math.min(24 * 31, Math.max(1, Number(hours) || 24));
  const start = new Date(now.getTime() - span * 3600 * 1000);
  const end = new Date(now.getTime() + 60 * 1000);
  const q = new URLSearchParams({
    start_date: utcStamp(start),
    end_date: utcStamp(end),
    page: "1",
    page_size: String(size),
    sort_by: "startTime",
    sort_order: "desc",
  });
  if (modelGroup) q.set("model_group", modelGroup);
  if (status === "success" || status === "failure") q.set("status_filter", status);
  return `/spend/logs/v2?${q.toString()}`;
}

function rowsOf(data) {
  if (Array.isArray(data)) return data;
  return (data && (data.data || data.logs)) || [];
}

module.exports = {
  PAGE_MAX,
  REASONS,
  redact,
  explainFailure,
  isFailure,
  toActivity,
  summarizeActivity,
  activityQuery,
  rowsOf,
};
