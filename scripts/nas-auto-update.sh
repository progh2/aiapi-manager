#!/bin/bash
# NAS 자동 업데이트: GitHub 에 새 커밋이 있으면 가져와 다시 빌드하고, 새 버전이 제대로 뜨지 않으면 되돌린다.
#
# DSM 제어판 → 작업 스케줄러 → 생성 → 예약된 작업 → 사용자 정의 스크립트
#   사용자: root · 일정: 매일 10분마다
#   명령: bash /volume1/docker/aiapi-manager/scripts/nas-auto-update.sh
#
# 선택 환경 변수 (명령 앞에 붙인다. 예: AIAPI_UPDATE_HOURS="0-7,17-23" bash .../nas-auto-update.sh)
#   AIAPI_UPDATE_BRANCH          가져올 브랜치 (기본 main)
#   AIAPI_UPDATE_HOURS           새 버전을 적용할 서울 시각. "0-7,17-23" 이면 수업 중에는 확인만 하고 적용을 미룬다
#   AIAPI_UPDATE_DRY_RUN=1       적용하지 않고 무엇을 할지만 남긴다
#   AIAPI_UPDATE_HEALTH_TIMEOUT  새 버전이 건강해지기를 기다릴 초 (기본 240)
#
# 결과는 admin-ui/data/auto-update.json(관리 화면 08 기록 → 시스템 상태)과 auto-update.log 에 남는다.
set -u
export PATH="/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:${PATH:-}"

DIR="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH="${AIAPI_UPDATE_BRANCH:-main}"
HOURS="${AIAPI_UPDATE_HOURS:-}"
DRY_RUN="${AIAPI_UPDATE_DRY_RUN:-}"
HEALTH_TIMEOUT="${AIAPI_UPDATE_HEALTH_TIMEOUT:-240}"
CONTAINERS="${AIAPI_UPDATE_CONTAINERS:-aiapi-postgres aiapi-litellm aiapi-admin-ui}"
DOCKER="${DOCKER:-docker}"
STATE_DIR="$DIR/admin-ui/data"
STATUS="$STATE_DIR/auto-update.json"
LOG="$STATE_DIR/auto-update.log"
LOCK="${AIAPI_UPDATE_LOCK:-/tmp/aiapi-auto-update.lock}"

mkdir -p "$STATE_DIR"

# 서울 시각. 시간대 자료가 없는 NAS 에서도 되도록 POSIX 표기(KST-9)를 쓴다.
now() { TZ=KST-9 date '+%Y-%m-%dT%H:%M:%S+09:00'; }
log() { echo "$(now) $*" >> "$LOG"; }
# root 로 돌 때 저장소 주인이 달라도 git 이 멈추지 않게 한다.
g() { git -c safe.directory="$DIR" -C "$DIR" "$@"; }
# JSON 문자열: 역슬래시·따옴표를 막고 줄바꿈은 빈칸으로
jstr() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\r\t' '   '; }

write_status() { # 상태 메시지 [적용 시각]
  local status="$1" msg="$2" applied_at="${3:-}" head="" subject=""
  if [ -z "$applied_at" ] && [ -f "$STATUS" ]; then
    applied_at="$(sed -n 's/.*"applied_at":"\([^"]*\)".*/\1/p' "$STATUS" | head -n 1)"
  fi
  head="$(g rev-parse --short HEAD 2>/dev/null || true)"
  subject="$(g log -1 --format=%s 2>/dev/null || true)"
  printf '{"checked_at":"%s","status":"%s","message":"%s","branch":"%s","commit":"%s","subject":"%s","applied_at":"%s","hours":"%s"}\n' \
    "$(now)" "$status" "$(jstr "$msg")" "$(jstr "$BRANCH")" "$head" "$(jstr "$subject")" "$applied_at" "$(jstr "$HOURS")" > "$STATUS.tmp" \
    && mv "$STATUS.tmp" "$STATUS"
  [ "$status" = "ok" ] || log "[$status] $msg"
}

fail() { write_status error "$1"; exit 1; }

# 새 버전을 적용해도 되는 시각인지. "0-7,17-23" · "22-6"(자정 넘김) · "12"(한 시간)
in_hours() {
  [ -z "$HOURS" ] && return 0
  local h range a b
  h=$((10#$(TZ=KST-9 date +%H)))
  for range in ${HOURS//,/ }; do
    a="${range%-*}"
    b="${range#*-}"
    [[ "$a" =~ ^[0-9]+$ && "$b" =~ ^[0-9]+$ ]] || continue
    a=$((10#$a))
    b=$((10#$b))
    if [ "$a" -le "$b" ]; then
      [ "$h" -ge "$a" ] && [ "$h" -le "$b" ] && return 0
    else
      { [ "$h" -ge "$a" ] || [ "$h" -le "$b" ]; } && return 0
    fi
  done
  return 1
}

wait_healthy() {
  local end state c all
  end=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while :; do
    all=1
    for c in $CONTAINERS; do
      state="$($DOCKER inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null || echo missing)"
      case "$state" in healthy | running) ;; *) all=0 ;; esac
    done
    [ "$all" = 1 ] && return 0
    [ "$(date +%s)" -ge "$end" ] && return 1
    sleep 5
  done
}

# 저장소 파일 주인을 처음 받은 계정으로 되돌린다(root 로 돌아도 나중에 손으로 git 을 쓸 수 있게). DB 폴더는 건드리지 않는다.
restore_owner() {
  [ "$(id -u)" = 0 ] || return 0
  local owner
  owner="$(stat -c '%u:%g' "$DIR" 2>/dev/null)" || return 0
  [ "$owner" = "0:0" ] && return 0
  chown -R "$owner" "$DIR/.git" 2>/dev/null
  (cd "$DIR" && g ls-files -z | xargs -0 chown "$owner" 2>/dev/null)
  return 0
}

compose() {
  if $DOCKER compose version >/dev/null 2>&1; then
    (cd "$DIR" && $DOCKER compose "$@")
  elif command -v docker-compose >/dev/null 2>&1; then
    (cd "$DIR" && docker-compose "$@")
  else
    return 127
  fi
}

# ---------------------------------------------------------------- 시작
# 겹쳐 돌지 않게 잠근다. 한 시간 넘은 잠금은 죽은 것으로 본다.
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then
    rm -rf "$LOCK"
    mkdir "$LOCK" 2>/dev/null || exit 0
  else
    exit 0
  fi
fi
trap 'rm -rf "$LOCK"' EXIT

# 기록 파일이 커지면 끝부분만 남긴다.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 524288 ]; then
  tail -n 400 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

command -v git >/dev/null 2>&1 || fail "git 이 없습니다. 패키지 센터에서 Git Server 를 설치하세요"
[ -d "$DIR/.git" ] || fail "git 저장소가 아닙니다. README '자동 업데이트' 의 준비 단계를 따라 주세요"

if ! g fetch --quiet origin "$BRANCH" 2>> "$LOG"; then
  fail "GitHub 에서 가져오지 못했습니다. 인터넷 연결과 배포 키(Deploy key)를 확인하세요"
fi
LOCAL="$(g rev-parse HEAD)"
REMOTE="$(g rev-parse "origin/$BRANCH")" || fail "origin/$BRANCH 를 찾을 수 없습니다"

if [ "$LOCAL" = "$REMOTE" ]; then
  write_status ok "최신 상태입니다"
  exit 0
fi
if ! g merge-base --is-ancestor "$LOCAL" "$REMOTE"; then
  fail "NAS 쪽 기록이 GitHub 과 갈라졌습니다. 손으로 확인해 주세요(git status)"
fi
DIRTY="$(g status --porcelain --untracked-files=no)"
if [ -n "$DIRTY" ]; then
  fail "NAS 에서 고친 파일이 있어 멈췄습니다: $(echo "$DIRTY" | head -n 3 | tr '\n' ' ')— 포트 등은 .env 로 옮기세요"
fi
NEW_SUBJECT="$(g log -1 --format=%s "$REMOTE")"
COUNT="$(g rev-list --count "$LOCAL..$REMOTE")"
if ! in_hours; then
  write_status waiting "새 버전 ${COUNT}개가 있지만 적용 시각($HOURS)이 아니라 기다립니다: $NEW_SUBJECT"
  exit 0
fi
if [ -n "$DRY_RUN" ]; then
  write_status dry_run "적용할 새 버전 ${COUNT}개: $NEW_SUBJECT"
  exit 0
fi

compose version >/dev/null 2>&1 || fail "docker compose 를 찾을 수 없습니다"
log "새 버전 ${COUNT}개 적용 시작 ($(g rev-parse --short "$LOCAL") → $(g rev-parse --short "$REMOTE"))"
g log --oneline "$LOCAL..$REMOTE" | head -n 20 >> "$LOG"
g merge --ff-only --quiet "$REMOTE" || fail "새 버전을 가져오지 못했습니다(fast-forward 실패)"
restore_owner

if compose up -d --build >> "$LOG" 2>&1 && wait_healthy; then
  $DOCKER image prune -f >/dev/null 2>&1 || true
  write_status updated "새 버전을 적용했습니다: $NEW_SUBJECT" "$(now)"
  exit 0
fi

# 새 버전이 뜨지 않으면 이전 버전으로 되돌린다.
log "새 버전이 제대로 뜨지 않아 $(g rev-parse --short "$LOCAL") 로 되돌립니다"
g reset --hard --quiet "$LOCAL"
restore_owner
compose up -d --build >> "$LOG" 2>&1
if wait_healthy; then
  write_status rolled_back "새 버전($(g rev-parse --short "$REMOTE"))이 제대로 뜨지 않아 이전 버전으로 되돌렸습니다. auto-update.log 를 확인하세요"
else
  write_status error "새 버전도, 되돌린 버전도 제대로 뜨지 않습니다. Container Manager 에서 확인하세요"
fi
exit 1
