// 학급 시간표는 팀 metadata 에 두고, 키는 aiapi_schedule_from 으로 따르는지 구분한다.
// team: 학급 시간표를 바꾼 뒤 이 키도 다시 쓴다. key: 이 키만의 시간대라 학급을 고쳐도 둔다.
const { normalizeSchedule } = require("./schedule");

function teamWindows(team) {
  const raw = team && team.metadata && team.metadata.aiapi_schedule;
  return Array.isArray(raw) ? raw : [];
}

function applyIssueSchedule(metadata, { team = null, teamCreated = false } = {}) {
  const meta = { ...(metadata || {}) };
  const requested = Array.isArray(meta.aiapi_schedule) ? meta.aiapi_schedule : [];
  if (requested.length) {
    meta.aiapi_schedule = requested;
    meta.aiapi_schedule_from = teamCreated ? "team" : "key";
    return meta;
  }
  if (team) {
    meta.aiapi_schedule = teamWindows(team);
    meta.aiapi_schedule_from = "team";
    return meta;
  }
  meta.aiapi_schedule = [];
  meta.aiapi_schedule_from = "key";
  return meta;
}

function keysFollowingTeam(keys, teamId) {
  return (keys || []).filter((key) => key.team_id === teamId
    && (key.metadata || {}).aiapi_schedule_from === "team");
}

function teamScheduleMetadata(existing, schedule) {
  return { ...(existing && typeof existing === "object" ? existing : {}), aiapi_schedule: normalizeSchedule(schedule) };
}

// 캠프 키의 빈 시간표는 당일 항상이다. 학급 시간표로 바꾸지 않는다.
function keepCampSchedule(metadata, current) {
  const meta = { ...(metadata || {}) };
  const camp = current && current.metadata && current.metadata.aiapi_camp;
  if (!camp) return meta;
  if (!meta.aiapi_camp) meta.aiapi_camp = camp;
  if (meta.aiapi_schedule_from === "team") {
    meta.aiapi_schedule = [];
    meta.aiapi_schedule_from = "key";
  }
  return meta;
}

module.exports = {
  teamWindows,
  applyIssueSchedule,
  keysFollowingTeam,
  teamScheduleMetadata,
  keepCampSchedule,
};
