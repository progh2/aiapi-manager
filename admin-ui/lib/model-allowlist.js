// 학급/조·키 모델 허용 목록.
// LiteLLM /key/generate · /key/update · /team/new · /team/update 의 models 필드와 같다.
// 빈 목록은 제한 없음(프록시 전체). 키와 학급이 둘 다 있으면 교집합만 허용.

function normalizeModels(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    const m = String(raw == null ? "" : raw).trim();
    if (!m || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

function effectiveAllowlist({ keyModels, teamModels } = {}) {
  const key = normalizeModels(keyModels);
  const team = normalizeModels(teamModels);
  if (!key.length && !team.length) return { models: [], unrestricted: true };
  if (!key.length) return { models: team, unrestricted: false };
  if (!team.length) return { models: key, unrestricted: false };
  return { models: key.filter((m) => team.includes(m)), unrestricted: false };
}

function isModelAllowed(model, allowlist) {
  const name = String(model == null ? "" : model).trim();
  if (!name) return false;
  if (Array.isArray(allowlist) || allowlist == null) {
    const list = normalizeModels(allowlist);
    if (!list.length) return true;
    return list.includes(name);
  }
  if (allowlist.unrestricted) return true;
  return normalizeModels(allowlist.models).includes(name);
}

function assertModelAllowed(model, allowlist) {
  if (isModelAllowed(model, allowlist)) return String(model).trim();
  const list = Array.isArray(allowlist) || allowlist == null
    ? normalizeModels(allowlist)
    : normalizeModels(allowlist.models);
  const err = new Error(
    list.length
      ? `모델 '${model}'은(는) 허용 목록에 없습니다 (허용: ${list.join(", ")})`
      : `모델 '${model}'은(는) 허용 목록에 없습니다`
  );
  err.status = 403;
  err.code = "model_not_allowed";
  throw err;
}

// 발급 시 키에 넣을 models. 요청이 비면 학급 목록을 물려준다.
// 둘 다 있으면 교집합. 겹치지 않으면 400 (빈 배열은 LiteLLM에서 '전체 허용'이 됨).
function resolveIssueModels(requested, teamModels) {
  const want = normalizeModels(requested);
  const team = normalizeModels(teamModels);
  if (want.length && team.length) {
    const inter = want.filter((m) => team.includes(m));
    if (!inter.length) {
      const err = new Error(
        `선택한 모델이 학급 허용 목록과 겹치지 않습니다 (학급: ${team.join(", ")})`
      );
      err.status = 400;
      throw err;
    }
    return inter;
  }
  if (want.length) return want;
  return team;
}

async function teamModelsFor(litellm, teamId) {
  if (!teamId) return [];
  const listing = await litellm("/team/list", "GET");
  const teams = Array.isArray(listing) ? listing : listing.teams || [];
  const t = teams.find((x) => x.team_id === teamId);
  return normalizeModels(t && t.models);
}

function simulateChatCompletion({ model, keyModels, teamModels }) {
  const allow = effectiveAllowlist({ keyModels, teamModels });
  assertModelAllowed(model, allow);
  return { ok: true, model: String(model).trim() };
}

module.exports = {
  normalizeModels,
  effectiveAllowlist,
  isModelAllowed,
  assertModelAllowed,
  resolveIssueModels,
  teamModelsFor,
  simulateChatCompletion,
};
