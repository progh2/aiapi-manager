#!/usr/bin/env sh
# Postgres 복구 (compose 서비스명: db)
# 사용: ./scripts/restore_postgres.sh <덤프.sql.gz|덤프.sql>
# 주의: 기존 litellm DB 내용을 덮어쓴다. 복구 전 확인.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
IN="${1:-}"
if [ -z "$IN" ] || [ ! -f "$IN" ]; then
  echo "사용법: $0 <덤프.sql.gz|덤프.sql>" >&2
  exit 1
fi
echo "복구 중 ← $IN (기존 데이터 덮어씀)"
case "$IN" in
  *.gz) gzip -dc "$IN" | docker compose exec -T db psql -U litellm -d litellm ;;
  *)    docker compose exec -T db psql -U litellm -d litellm < "$IN" ;;
esac
echo "복구 완료. admin-ui에서 키·조 데이터 확인."
