// 학급 일괄 예산 부여. LiteLLM /key/generate · /team/new 를 감싼다.
const {
  parseRoster,
  normalizeStudentList,
  durationFromExpiryDate,
} = require("./roster");
const {
  normalizeModels,
  resolveIssueModels,
  teamModelsFor,
} = require("./model-allowlist");

const MAX_BULK = 500;

function keyGenerateParams(body) {
  const p = {};
  if (body.budget !== undefined && body.budget !== "") p.max_budget = Number(body.budget);
  if (body.budget_duration) p.budget_duration = body.budget_duration;
  if (body.expires) {
    p.duration = durationFromExpiryDate(body.expires);
  } else if (body.duration) {
    p.duration = body.duration;
  }
  if (Array.isArray(body.models)) p.models = normalizeModels(body.models);
  if (body.rpm_limit) p.rpm_limit = Number(body.rpm_limit);
  if (body.tpm_limit) p.tpm_limit = Number(body.tpm_limit);
  if (body.max_parallel_requests) p.max_parallel_requests = Number(body.max_parallel_requests);
  return p;
}

async function resolveTeam(litellm, team, teamBudget, extra = {}) {
  const listing = await litellm("/team/list", "GET");
  const teams = Array.isArray(listing) ? listing : listing.teams || [];
  const found = teams.find((t) => t.team_alias === team || t.team_id === team);
  if (found) {
    return {
      team_id: found.team_id,
      created: false,
      team_alias: found.team_alias || team,
      models: normalizeModels(found.models),
    };
  }
  const payload = { team_alias: team };
  if (teamBudget !== undefined && teamBudget !== "") payload.max_budget = Number(teamBudget);
  const models = normalizeModels(extra.models);
  if (models.length) payload.models = models;
  const created = await litellm("/team/new", "POST", payload);
  return {
    team_id: created.team_id,
    created: true,
    team_alias: team,
    models: payload.models || [],
  };
}

function parseBodyRoster(body) {
  if (body.csv != null && String(body.csv).trim()) return parseRoster(body.csv);
  return normalizeStudentList(body.students);
}

/**
 * 명단 전원에게 같은 예산·기간의 가상 키를 순차 발급한다.
 * 부분 실패는 나머지를 계속 진행하고 results[].error 로 남긴다.
 */
async function assignClassBudgets(body, { litellm }) {
  const parsed = parseBodyRoster(body);
  if (!parsed.students.length && !parsed.errors.length) {
    const err = new Error("students 배열 또는 csv가 필요합니다");
    err.status = 400;
    throw err;
  }
  if (parsed.students.length > MAX_BULK) {
    const err = new Error(`한 번에 ${MAX_BULK}명까지 발급할 수 있습니다`);
    err.status = 400;
    throw err;
  }

  let params;
  try {
    params = keyGenerateParams(body);
  } catch (e) {
    if (!e.status) e.status = 400;
    throw e;
  }

  let teamId = body.team_id || "";
  let teamCreated = false;
  let teamAlias = null;
  let teamModels = [];
  const teamName = String(body.team || "").trim();
  if (!teamId && teamName) {
    const resolved = await resolveTeam(litellm, teamName, body.team_budget, {
      models: body.models,
    });
    teamId = resolved.team_id;
    teamCreated = resolved.created;
    teamAlias = resolved.team_alias;
    teamModels = resolved.models || [];
  } else if (teamId) {
    teamModels = await teamModelsFor(litellm, teamId);
  }

  try {
    const models = resolveIssueModels(params.models || body.models, teamModels);
    if (models.length) params.models = models;
    else delete params.models;
  } catch (e) {
    if (!e.status) e.status = 400;
    throw e;
  }

  const results = [];
  for (const s of parsed.students) {
    try {
      const data = await litellm("/key/generate", "POST", {
        key_alias: s.alias,
        team_id: teamId || undefined,
        ...params,
      });
      results.push({
        alias: s.alias,
        student_id: s.student_id,
        name: s.name,
        key: data.key,
        max_budget: data.max_budget ?? params.max_budget ?? null,
        duration: params.duration || null,
        expires: data.expires || null,
      });
    } catch (e) {
      results.push({
        alias: s.alias,
        student_id: s.student_id,
        name: s.name,
        error: e.message,
      });
    }
  }
  for (const e of parsed.errors) {
    results.push({
      alias: e.alias || e.raw || `line ${e.line}`,
      student_id: e.student_id || null,
      name: e.name || null,
      line: e.line,
      error: e.error,
    });
  }

  return {
    results,
    team_id: teamId || null,
    team_created: teamCreated,
    team_alias: teamAlias,
    duration: params.duration || null,
    expires: body.expires || null,
    max_budget: params.max_budget ?? null,
    models: params.models || [],
  };
}

module.exports = {
  MAX_BULK,
  keyGenerateParams,
  resolveTeam,
  parseBodyRoster,
  assignClassBudgets,
};
