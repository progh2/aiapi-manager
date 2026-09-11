# Postgres 백업·복구

키·조·사용량 데이터가 들어 있는 Postgres(`db` 서비스, 볼륨 `./data/postgres`)를 덤프·복구한다.
로컬 PC와 Synology Container Manager(SSH) 공통.

## 전제

- 저장소 루트에서 스택이 떠 있음: `docker compose up -d --build`
- Postgres 외부 포트는 열지 않음. 덤프는 `docker compose exec`로만 수행

## 백업

```sh
chmod +x scripts/backup_postgres.sh scripts/restore_postgres.sh
./scripts/backup_postgres.sh
# 또는 경로 지정
./scripts/backup_postgres.sh ./backups/before-upgrade.sql.gz
```

`backups/`는 git에 올리지 말 것(민감 데이터).

## 복구

```sh
./scripts/restore_postgres.sh ./backups/before-upgrade.sql.gz
```

복구 후 admin-ui에서 키·조가 유지되는지 확인.

## Synology

1. SSH로 NAS 접속 후 `cd /volume1/docker/aiapi-manager` (설치 경로에 맞게)
2. 위와 동일하게 `./scripts/backup_postgres.sh` 실행
3. 주기 백업: 제어판 → 작업 스케줄러에서 매일 위 스크립트 호출, 또는 Hyper Backup으로 `docker/aiapi-manager/backups`·`data/postgres` 폴더 포함

## 검수 체크 (이슈 #2)

1. 키·조 데이터가 있는 상태에서 덤프
2. 데이터 초기화 또는 별도 환경에서 복구
3. admin-ui에서 키·조 유지 확인
