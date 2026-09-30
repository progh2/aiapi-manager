// 학급 봉쇄. 시험·사고 때 학급 키를 한꺼번에 막고, 해제할 때는 봉쇄로 막은 키만 다시 연다.
// 봉쇄 전에 이미 막혀 있던 키(개별 차단, 폐기 후 새 키로 바뀐 키)는 해제 때 건드리지 않는다.
// 표시는 키와 학급 metadata.aiapi_lockdown 에 남긴다.

const LOCK_KEY = "aiapi_lockdown";

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function listAllKeys(litellm) {
  const keys = [];
  for (let page = 1; page <= 100; page++) {
    const data = await litellm(`/key/list?return_full_object=true&size=100&page=${page}`);
    keys.push(...(data.keys || []));
    if (page >= (data.total_pages || 1)) break;
  }
  return keys;
}

async function findTeam(litellm, teamId) {
  const data = await litellm("/team/list");
  const teams = Array.isArray(data) ? data : data.teams || [];
  return teams.find((t) => t.team_id === teamId) || null;
}

function lockOf(obj) {
  const meta = obj && obj.metadata;
  return meta && typeof meta === "object" && meta[LOCK_KEY] ? meta[LOCK_KEY] : null;
}

function withoutLock(metadata) {
  const next = { ...(metadata && typeof metadata === "object" ? metadata : {}) };
  delete next[LOCK_KEY];
  return next;
}

async function lockdownTeam(body, { litellm, actor = null, now = new Date() } = {}) {
  const teamId = String(body?.team_id || "").trim();
  if (!teamId) throw httpError("team_id가 필요합니다", 400);
  const team = await findTeam(litellm, teamId);
  if (!team) throw httpError("학급을 찾을 수 없습니다", 404);
  if (lockOf(team)) throw httpError("이미 봉쇄된 학급입니다", 409);
  const stamp = { at: now.toISOString(), by: actor, reason: String(body?.reason || "").slice(0, 120) || null };

  const keys = (await listAllKeys(litellm)).filter((k) => k.team_id === teamId);
  const results = [];
  for (const key of keys) {
    const token = key.token || key.key;
    const row = { alias: key.key_alias || null, token, team_id: teamId };
    if (key.blocked) {
      results.push({ ...row, skipped: true, blocked: true });
      continue;
    }
    try {
      await litellm("/key/update", "POST", { key: token, metadata: { ...(key.metadata || {}), [LOCK_KEY]: stamp } });
      await litellm("/key/block", "POST", { key: token });
      results.push({ ...row, blocked: true });
    } catch (e) {
      results.push({ ...row, error: e.message });
    }
  }
  const locked = results.filter((r) => r.blocked && !r.skipped).length;
  await litellm("/team/update", "POST", {
    team_id: teamId,
    metadata: { ...(team.metadata || {}), [LOCK_KEY]: { ...stamp, keys: locked } },
  });
  return { action: "lock", team_id: teamId, team_alias: team.team_alias || null, results, lockdown: stamp };
}

async function liftLockdown(body, { litellm } = {}) {
  const teamId = String(body?.team_id || "").trim();
  if (!teamId) throw httpError("team_id가 필요합니다", 400);
  const team = await findTeam(litellm, teamId);
  if (!team) throw httpError("학급을 찾을 수 없습니다", 404);

  const keys = (await listAllKeys(litellm)).filter((k) => k.team_id === teamId);
  const results = [];
  for (const key of keys) {
    if (!lockOf(key)) continue;
    const token = key.token || key.key;
    const row = { alias: key.key_alias || null, token, team_id: teamId };
    try {
      if (key.blocked) await litellm("/key/unblock", "POST", { key: token });
      await litellm("/key/update", "POST", { key: token, metadata: withoutLock(key.metadata) });
      results.push({ ...row, unblocked: true });
    } catch (e) {
      results.push({ ...row, error: e.message });
    }
  }
  if (lockOf(team)) {
    await litellm("/team/update", "POST", { team_id: teamId, metadata: withoutLock(team.metadata) });
  }
  return { action: "unlock", team_id: teamId, team_alias: team.team_alias || null, results };
}

module.exports = { LOCK_KEY, lockOf, withoutLock, lockdownTeam, liftLockdown };
