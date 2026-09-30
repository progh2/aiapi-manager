#!/bin/bash
# nas-auto-update.sh 시험. 가짜 GitHub(맨 저장소)·가짜 NAS 저장소·가짜 docker 로 돌린다.
#   bash scripts/nas-auto-update.test.sh
set -u
SCRIPT="$(cd "$(dirname "$0")" && pwd)/nas-auto-update.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PASS=0; FAILN=0
ok() { if [ "$1" = 1 ]; then echo "PASS  $2"; PASS=$((PASS+1)); else echo "FAIL  $2 ${3:-}"; FAILN=$((FAILN+1)); fi; }

# 시험은 이 컴퓨터의 git 설정(~/.gitconfig)을 건드리지 않는다.
export GIT_CONFIG_GLOBAL="$WORK/gitconfig" GIT_CONFIG_NOSYSTEM=1
git config --global init.defaultBranch main
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# 가짜 GitHub: 맨 저장소 + 개발용 복제
git init -q --bare "$WORK/origin.git"
git clone -q "$WORK/origin.git" "$WORK/dev" 2>/dev/null
mkdir -p "$WORK/dev/scripts"
cp "$SCRIPT" "$WORK/dev/scripts/"
echo "v1" > "$WORK/dev/app.txt"
printf 'admin-ui/data/\n' > "$WORK/dev/.gitignore"
(cd "$WORK/dev" && git add -A && git commit -qm "v1" && git push -q origin HEAD:main)
# 가짜 NAS
git clone -q "$WORK/origin.git" "$WORK/nas"
NAS="$WORK/nas"
STATUS="$NAS/admin-ui/data/auto-update.json"

# 가짜 docker: 부른 명령을 적고, UNHEALTHY 파일이 있으면 건강하지 않다고 답한다
cat > "$WORK/docker" <<'DOCK'
#!/bin/bash
echo "$*" >> "$(dirname "$0")/docker.calls"
case "$1" in
  compose) exit 0 ;;
  inspect) if [ -f "$(dirname "$0")/UNHEALTHY" ] && grep -q v2-bad "$NAS_DIR/app.txt" 2>/dev/null; then echo unhealthy; else echo healthy; fi ;;
  image) exit 0 ;;
esac
DOCK
chmod +x "$WORK/docker"
run() { NAS_DIR="$NAS" DOCKER="$WORK/docker" AIAPI_UPDATE_LOCK="$WORK/lock" AIAPI_UPDATE_HEALTH_TIMEOUT=2 bash "$NAS/scripts/nas-auto-update.sh"; }
field() { sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" "$STATUS"; }
push() { (cd "$WORK/dev" && echo "$1" > app.txt && git commit -qam "$1" && git push -q origin HEAD:main); }

# 1) 변화 없음
run; ok "$([ "$(field status)" = ok ] && echo 1)" "변화가 없으면 ok, 빌드하지 않음"
ok "$([ ! -f "$WORK/docker.calls" ] || ! grep -q "compose up" "$WORK/docker.calls"; echo $(( $? == 0 )))" "변화 없을 때 compose up 안 부름"

# 2) 새 커밋 → 가져와 빌드
push "v2"
run
ok "$([ "$(field status)" = updated ] && [ "$(cat "$NAS/app.txt")" = v2 ] && echo 1)" "새 커밋을 가져와 적용" "$(field status) $(cat "$NAS/app.txt")"
ok "$(grep -q "compose up -d --build" "$WORK/docker.calls" && echo 1)" "compose up -d --build 를 부름"
ok "$([ -n "$(field applied_at)" ] && echo 1)" "적용 시각을 남김"
APPLIED="$(field applied_at)"
run
ok "$([ "$(field status)" = ok ] && [ "$(field applied_at)" = "$APPLIED" ] && echo 1)" "다음 확인에서도 적용 시각 유지"

# 3) NAS 에서 고친 파일이 있으면 멈춤
push "v3"
echo "local edit" > "$NAS/app.txt"
run
ok "$([ "$(field status)" = error ] && [ "$(cat "$NAS/app.txt")" = "local edit" ] && echo 1)" "고친 파일이 있으면 건드리지 않고 멈춤" "$(field message)"
(cd "$NAS" && git checkout -q -- app.txt)

# 4) 적용 시각이 아니면 기다림
NOWH=$((10#$(TZ=KST-9 date +%H))); OTHER=$(( (NOWH + 12) % 24 ))
NAS_DIR="$NAS" DOCKER="$WORK/docker" AIAPI_UPDATE_LOCK="$WORK/lock" AIAPI_UPDATE_HOURS="$OTHER" bash "$NAS/scripts/nas-auto-update.sh"
ok "$([ "$(field status)" = waiting ] && [ "$(cat "$NAS/app.txt")" = v2 ] && echo 1)" "적용 시각이 아니면 기다림" "$(field message)"
NAS_DIR="$NAS" DOCKER="$WORK/docker" AIAPI_UPDATE_LOCK="$WORK/lock" AIAPI_UPDATE_HOURS="$NOWH" bash "$NAS/scripts/nas-auto-update.sh"
ok "$([ "$(field status)" = updated ] && [ "$(cat "$NAS/app.txt")" = v3 ] && echo 1)" "적용 시각이면 적용"

# 5) 새 버전이 건강하지 않으면 되돌림
touch "$WORK/UNHEALTHY"
push "v2-bad"
run
ok "$([ "$(field status)" = rolled_back ] && [ "$(cat "$NAS/app.txt")" = v3 ] && echo 1)" "건강하지 않으면 이전 버전으로 되돌림" "$(field status) $(cat "$NAS/app.txt")"
rm -f "$WORK/UNHEALTHY"

# 6) 이미 돌고 있으면 조용히 끝남
mkdir "$WORK/lock"; before="$(field checked_at)"; sleep 1
run
ok "$([ "$(field checked_at)" = "$before" ] && echo 1)" "잠겨 있으면 겹쳐 돌지 않음"
rmdir "$WORK/lock"

# 7) 기록 파일과 JSON 모양
ok "$(python3 -c "import json,sys; json.load(open('$STATUS'))" 2>/dev/null && echo 1)" "상태 파일이 올바른 JSON"
ok "$([ -s "$NAS/admin-ui/data/auto-update.log" ] && echo 1)" "기록 파일을 남김"

echo "---- $PASS 통과, $FAILN 실패"
[ "$FAILN" = 0 ]
