#!/bin/bash
# NAS 자동 업데이트 준비 (한 번만). SSH 로 NAS 에 들어가 다음을 실행한다:
#   sudo bash /volume1/docker/aiapi-manager/scripts/nas-auto-update-setup.sh
#
# 하는 일: git 확인 → 읽기 전용 배포 키 만들기 → GitHub 등록 안내 → 연결 시험(22번이 막히면 443)
#          → 저장소를 SSH 로 받게 설정(ZIP 으로 설치했으면 제자리에서 git 저장소로 바꿈) → 첫 확인
set -u
export PATH="/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:${PATH:-}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
KEY=/root/.ssh/aiapi_deploy
g() { git -c safe.directory="$DIR" -C "$DIR" "$@"; }
say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✖ %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = 0 ] || die "sudo 로 실행하세요: sudo bash $0"
command -v git >/dev/null 2>&1 || die "git 이 없습니다. DSM 패키지 센터에서 'Git Server' 를 설치한 뒤 다시 실행하세요."
command -v ssh-keygen >/dev/null 2>&1 || die "ssh-keygen 이 없습니다. DSM 제어판 → 터미널 및 SNMP 에서 SSH 를 켜 두었는지 확인하세요."

# 저장소 주소: 지금 원격이 있으면 그 owner/repo, 없으면 기본값
REPO="progh2/aiapi-manager"
if [ -d "$DIR/.git" ]; then
  url="$(g remote get-url origin 2>/dev/null || true)"
  guess="$(printf '%s' "$url" | sed -n -e 's#^https://[^/]*github.com/\(.*\)$#\1#p' -e 's#^git@github.com:\(.*\)$#\1#p' | sed 's#\.git$##')"
  [ -n "$guess" ] && REPO="$guess"
fi
REPO_SSH="git@github.com:${REPO}.git"

say "1) 읽기 전용 배포 키"
mkdir -p /root/.ssh && chmod 700 /root/.ssh
if [ ! -f "$KEY" ]; then
  ssh-keygen -q -t ed25519 -N "" -f "$KEY" -C "aiapi-nas-$(hostname)" || die "키를 만들지 못했습니다"
fi
touch /root/.ssh/config && chmod 600 /root/.ssh/config
if ! grep -q "aiapi_deploy" /root/.ssh/config; then
  printf '\nHost github.com\n  IdentityFile %s\n  IdentitiesOnly yes\n' "$KEY" >> /root/.ssh/config
fi
echo "아래 한 줄을 GitHub 저장소(https://github.com/${REPO}) → Settings → Deploy keys → Add deploy key 에 붙여 넣으세요."
echo "Title 은 아무거나(예: 학교 NAS), 'Allow write access' 는 켜지 마세요(읽기 전용)."
echo
cat "$KEY.pub"
echo
read -r -p "등록했으면 Enter 를 누르세요… " _

say "2) GitHub 연결 시험"
test_ssh() { ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -T git@github.com 2>&1 | grep -q "successfully authenticated"; }
if ! test_ssh; then
  echo "22번 포트로 안 되어 443 번(ssh.github.com)으로 다시 시도합니다(학교 방화벽 대비)."
  if ! grep -q "ssh.github.com" /root/.ssh/config; then
    sed -i "s#^Host github.com\$#Host github.com\n  Hostname ssh.github.com\n  Port 443#" /root/.ssh/config
  fi
  test_ssh || die "GitHub 에 연결하지 못했습니다. 배포 키를 등록했는지, NAS 가 인터넷에 나갈 수 있는지 확인하세요."
fi
echo "연결됨 ✓"

say "3) 저장소 설정"
if [ -d "$DIR/.git" ]; then
  g remote set-url origin "$REPO_SSH"
  echo "원격을 $REPO_SSH 로 바꿨습니다."
else
  echo "ZIP 으로 설치된 폴더라 제자리에서 git 저장소로 바꿉니다. .env · admin-ui/data · data(DB) 는 그대로 둡니다."
  [ -f "$DIR/docker-compose.yml" ] && cp "$DIR/docker-compose.yml" "$DIR/docker-compose.yml.before-git" && echo "기존 docker-compose.yml 은 docker-compose.yml.before-git 으로 남겼습니다(포트를 고쳤다면 .env 로 옮기세요)."
  g init -q && g remote add origin "$REPO_SSH" && g fetch -q origin main && g checkout -q -f -B main origin/main \
    || die "git 저장소로 바꾸지 못했습니다"
fi
g branch -q --set-upstream-to=origin/main 2>/dev/null || true

say "4) 첫 확인"
bash "$DIR/scripts/nas-auto-update.sh"
cat "$DIR/admin-ui/data/auto-update.json" 2>/dev/null
echo

say "5) 마지막: 작업 스케줄러에 등록"
cat <<EOF
DSM 제어판 → 작업 스케줄러 → 생성 → 예약된 작업 → 사용자 정의 스크립트
  일반     : 작업 이름 'aiapi 자동 업데이트', 사용자 root
  일정     : 매일 · 첫 실행 00:00 · 빈도 10분마다 · 마지막 실행 23:50
  작업 설정: 사용자 정의 스크립트에
             bash $DIR/scripts/nas-auto-update.sh
             (수업 중 적용을 피하려면: AIAPI_UPDATE_HOURS="0-7,17-23" bash $DIR/scripts/nas-auto-update.sh)
             '스크립트가 비정상적으로 종료되는 경우에만 실행 세부 정보를 이메일로 보내기' 를 켜 두면 실패를 메일로 받습니다.
관리 화면 08 기록 → 시스템 상태에서 '자동 업데이트' 줄로 확인할 수 있습니다.
EOF
