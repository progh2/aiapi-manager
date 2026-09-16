# NAS/PC 재확인 런북 (이슈 #9)

P0 [#2](https://github.com/progh2/aiapi-manager/issues/2)(키·조 백업·복구)·[#3](https://github.com/progh2/aiapi-manager/issues/3)(풀스택 healthy)은 클라우드 VM에서 **부분 통과**였다.
이 문서는 **tarho.local** / Synology / 일반 PC에서 다시 확인하는 절차다. 결과는 [이슈 #9](https://github.com/progh2/aiapi-manager/issues/9)에 붙인다.

기능 구현(일괄발급·대시보드)은 하지 않는다. **실제 API 키·마스터 키·비밀번호·가상 키 값은 커밋하거나 이슈에 붙이지 않는다.**

## 1. 사전 준비

1. 저장소 최신화 (`main` 기준):

   ```sh
   git pull
   ```

2. `.env` — 저장소 루트에서 `cp .env.example .env` 후 값을 채운다.
   - `.env.example`에는 플레이스홀더만 있다. **시크릿은 커밋하지 않는다** (`.gitignore`).
3. Firebase — [firebase-checklist.md](firebase-checklist.md)를 따른다.
   - `admin-ui/public/firebase-config.js`는 저장소에 `REPLACE_ME`만 둔다. 실제 값은 커밋하지 않는다.

## 2. 기동 (#3)

```sh
docker compose up -d --build
docker compose ps
```

`db`·`litellm`·`admin-ui`가 **전부 `healthy`**가 될 때까지 기다린다. admin-ui 최초 빌드는 몇 분 걸릴 수 있다.

## 3. 헬스 프로브

포트는 `.env`의 `LITELLM_PORT`(기본 4000)·`ADMIN_UI_PORT`(기본 3000)를 따른다. NAS면 `localhost`를 내부 IP로 바꾼다.

```sh
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:4000/health/liveliness
curl -sS http://localhost:3000/health
```

기대: litellm liveliness **200**, admin-ui **200** `{"status":"ok"}`.

## 4. #2 경로 (키·조 → 덤프 → 복구 → UI)

명령 상세는 [postgres-backup.md](postgres-backup.md).

1. **시드** — admin-ui에 키·조가 있으면 그대로 쓴다. 없으면 테스트용 그룹·키를 **하나씩** 만든다 (별칭 예: `재확인-조`, `재확인-키`). 실제 OpenAI 키는 필요 없다.
2. 그룹명·키 **별칭만** 메모한다. `sk-...` 값은 적지 않는다.
3. 덤프:

   ```sh
   chmod +x scripts/backup_postgres.sh scripts/restore_postgres.sh
   ./scripts/backup_postgres.sh ./backups/recheck.sql.gz
   gzip -t ./backups/recheck.sql.gz && ls -lh ./backups/recheck.sql.gz
   ```

4. 복구 — 아래 중 하나.

   - 같은 스택에서 덮어쓰기:

     ```sh
     ./scripts/restore_postgres.sh ./backups/recheck.sql.gz
     ```

   - 더 강하게(볼륨 초기화): 덤프가 있는 것을 확인한 뒤 스택 중지 → `data/postgres`를 **삭제하지 말고 이름만 변경** → `docker compose up -d` → 위 restore. 운영 데이터면 덤프 확인 전에는 볼륨을 건드리지 않는다.

5. admin-ui에서 키·조 **별칭**이 유지되는지 확인한다.

## 5. 이슈 #9에 붙일 로그 (시크릿 없이)

아래만 붙여 넣는다. 키·비밀번호·`.env`·`firebase-config` 실제 값은 넣지 않는다.

- [ ] 호스트: `tarho.local` / Synology / PC (어느 쪽인지)
- [ ] `git rev-parse --short HEAD`
- [ ] `docker compose ps` — db·litellm·admin-ui 전부 healthy
- [ ] litellm `/health/liveliness` HTTP 코드
- [ ] admin-ui `/health` 응답 (`{"status":"ok"}`)
- [ ] 덤프: 경로·크기·`gzip -t` 결과
- [ ] 복구: 스크립트 마지막 몇 줄
- [ ] admin-ui: 키·조 **별칭만** (값 금지)
- [ ] 항목별 통과/실패. 실패면 어느 서비스·어느 단계인지

(선택) Firebase 실로그인 여부 — [firebase-checklist.md](firebase-checklist.md) 검수 체크. 이메일은 붙여 넣지 않아도 된다.

## 6. Synology vs PC

설치·포트·업데이트는 README를 따른다. 백업 스크립트는 동일하다.

| 환경 | 설치 | 접속 | 비고 |
|---|---|---|---|
| Synology | README [설치 A](../README.md#설치-a-synology-nas-container-manager) | `http://NAS내부IP:3000` / `:4000` | SSH 예: `/volume1/docker/aiapi-manager`. Container Manager **동작 → 빌드** 또는 `docker compose up -d --build`. 주기 백업은 [postgres-backup.md](postgres-backup.md) Synology 절 |
| 일반 PC | README [설치 B](../README.md#설치-b-일반-pc--서버) | `http://localhost:3000` / `:4000` | Docker Desktop 또는 engine + compose. PC가 꺼지면 서비스도 꺼짐 |
| tarho.local | 위 둘 중 해당 절 | 그 환경의 호스트/IP | 포트 충돌 시 `.env`의 `LITELLM_PORT` / `ADMIN_UI_PORT` |
