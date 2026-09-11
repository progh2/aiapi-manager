#!/usr/bin/env sh
# Postgres 덤프 (compose 서비스명: db)
# 사용: ./scripts/backup_postgres.sh [출력경로]
# 전제: 저장소 루트에서 docker compose 로 스택이 떠 있음
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="${1:-./backups/postgres-$(date +%Y%m%d-%H%M%S).sql.gz}"
mkdir -p "$(dirname "$OUT")"
echo "덤프 중 → $OUT"
docker compose exec -T db \
  pg_dump -U litellm -d litellm --clean --if-exists \
  | gzip -c > "$OUT"
echo "완료: $OUT"
ls -lh "$OUT"
