#!/usr/bin/env sh
# Postgres 덤프 (compose 서비스명: db)
# 사용: ./scripts/backup_postgres.sh [출력경로]
# 전제: 스택이 떠 있음(docker compose 또는 docker-compose). 시놀로지는 sudo 로 실행
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# 시놀로지에는 docker compose 대신 docker-compose 만 있는 경우가 많다.
compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"; else docker-compose "$@"; fi
}
OUT="${1:-./backups/postgres-$(date +%Y%m%d-%H%M%S).sql.gz}"
mkdir -p "$(dirname "$OUT")"
echo "덤프 중 → $OUT"
compose exec -T db \
  pg_dump -U litellm -d litellm --clean --if-exists \
  | gzip -c > "$OUT"
echo "완료: $OUT"
ls -lh "$OUT"
