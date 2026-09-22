# aiapi-manager

학교 수업용 OpenAI API 사용량 관리 시스템. Synology DS918+ NAS(내부망)에서 LiteLLM Proxy를 돌려
학생별 **가상 API 키**(예산·모델 제한 포함)를 발급하고, Firebase 구글 로그인 기반 관리자 웹 UI로 키를 관리한다.

```
학생 코드 (OpenAI SDK, base_url만 변경)
        │  가상 키 (sk-...)
        ▼
LiteLLM Proxy (:4000) ──── Postgres (키·예산·사용량, 내부 전용)
        │  실제 OpenAI 키 (서버에만 존재)
        ▼
    OpenAI API

관리자 브라우저 ── Google 로그인 (Firebase) ──▶ admin-ui (:3000) ──▶ LiteLLM 관리 API
```

## 구성 요소

| 경로 | 설명 |
|---|---|
| `docker-compose.yml` | LiteLLM + Postgres + admin-ui 세 컨테이너. db·litellm·admin-ui 모두 healthcheck, `depends_on: service_healthy` |
| `litellm/config.yaml` | 학생에게 노출할 모델 목록 |
| `admin-ui/` | 관리자 웹 UI. Firebase 구글 로그인 → 학급/조·키 관리, 사용량 대시보드 |
| `admin-ui/public/charts.js` | 대시보드 차트(인라인 SVG, 외부 라이브러리 없음) |
| `scripts/issue_keys.py` | 학생 명단 CSV로 키 일괄 발급 (표준 라이브러리만 사용) |
| `scripts/revoke_camp_keys.py` | 캠프 키 당일 종료 후 차단·회수 (cron 훅) |

## 공통 사전 준비 (최초 1회)

어디에 설치하든 아래 두 가지를 먼저 끝낸다.

### 1. Firebase 설정 (관리자 로그인용)

설치마다 빠뜨리지 않도록 [Firebase 설정 체크리스트](docs/firebase-checklist.md)를 따른다.

1. [Firebase 콘솔](https://console.firebase.google.com)에서 **프로젝트 추가** (이름 예: `aiapi-manager`, 애널리틱스는 꺼도 됨)
2. 왼쪽 메뉴 **빌드 → Authentication → 시작하기 → 로그인 방법** 탭에서 **Google** 활성화 (지원 이메일 선택 후 저장)
3. **Authentication → 설정 → 승인된 도메인**에 관리자 UI 접속 주소를 추가
   - NAS라면 내부 IP (예: `192.168.0.10`), PC 테스트라면 `localhost`는 기본 포함됨
4. **프로젝트 개요 옆 톱니 → 프로젝트 설정 → 내 앱 → 웹 앱(</>) 추가** → 표시되는 `firebaseConfig`에서
   `apiKey`, `authDomain`, `projectId` 세 값을 `admin-ui/public/firebase-config.js`에 붙여넣기

### 2. 환경 변수 파일 만들기

저장소 루트에서:

```sh
cp .env.example .env
```

`.env`를 열어 다음을 채운다.

| 변수 | 값 |
|---|---|
| `OPENAI_API_KEY` | OpenAI 플랫폼에서 발급한 실제 키 (`sk-...`) |
| `LITELLM_MASTER_KEY` | 관리자용 마스터 키. `echo "sk-$(openssl rand -hex 24)"` 로 생성 |
| `POSTGRES_PASSWORD` | 임의의 강한 비밀번호 |
| `FIREBASE_PROJECT_ID` | Firebase 콘솔의 프로젝트 ID |
| `ADMIN_EMAILS` | 관리자로 허용할 구글 계정 (쉼표 구분) |

> `.env`와 `firebase-config.js` 수정본은 절대 공개 저장소에 올리지 말 것 (`.env`는 `.gitignore` 처리됨).

## 설치 A: Synology NAS (Container Manager)

DSM 7.2 이상의 **Container Manager** 기준. DS918+ 등 x86 기종에서 동작한다.

1. **Container Manager 설치** — DSM **패키지 센터**에서 `Container Manager` 검색 후 설치
   (구버전 DSM의 `Docker` 패키지도 동일하게 동작)
2. **공유 폴더 준비** — File Station에서 `docker` 공유 폴더(없으면 생성) 아래에 `aiapi-manager` 폴더 생성
3. **프로젝트 파일 올리기** — 두 방법 중 하나:
   - **File Station 업로드**: PC에서 이 저장소를 다운로드(GitHub → Code → Download ZIP)한 뒤 압축을 풀고,
     위 "공통 사전 준비"까지 마친 상태로 전체 폴더를 `docker/aiapi-manager`에 업로드
   - **SSH + git**: 제어판 → 터미널 및 SNMP → SSH 활성화 후
     ```sh
     ssh 관리자계정@NAS주소
     cd /volume1/docker
     git clone https://github.com/progh2/aiapi-manager.git
     cd aiapi-manager
     cp .env.example .env && vi .env        # 값 채우기
     vi admin-ui/public/firebase-config.js  # Firebase 값 입력
     ```
4. **Container Manager에서 프로젝트 생성**
   - Container Manager 실행 → 왼쪽 **프로젝트** → **생성**
   - 프로젝트 이름: `aiapi-manager`
   - 경로: `docker/aiapi-manager` 선택 → 기존 `docker-compose.yml`을 감지하면 **기존 파일 사용** 선택
   - 웹 포털 설정은 건너뛰어도 됨 → 완료를 누르면 이미지 다운로드·빌드 후 컨테이너 3개가 기동됨
     (admin-ui는 Dockerfile 빌드라 최초 기동에 몇 분 걸릴 수 있음)
5. **동작 확인**
   - 관리자 UI: `http://NAS내부IP:3000` → Google 로그인 → 키 발급 테스트
   - 프록시: `http://NAS내부IP:4000/health/liveliness` 가 응답하면 정상
   - 관리자 UI 헬스: `http://NAS내부IP:3000/health` → `{"status":"ok"}`
6. **포트가 겹칠 때** — NMS/PartDB 등 기존 컨테이너가 3000/4000을 쓰고 있다면
   `docker-compose.yml`의 `ports`에서 왼쪽 숫자만 바꾼다 (예: `"14000:4000"`).
7. **업데이트** — 저장소를 갱신(재업로드 또는 `git pull`)한 뒤 프로젝트 선택 → **동작 → 빌드**로 재빌드,
   또는 SSH에서 `docker compose up -d --build`

## 설치 B: 일반 PC / 서버

Docker Desktop(Windows/Mac) 또는 docker engine + compose plugin(Linux)이 설치되어 있으면 된다.

```sh
git clone https://github.com/progh2/aiapi-manager.git
cd aiapi-manager
cp .env.example .env                      # 값 채우기 (공통 사전 준비 참고)
# admin-ui/public/firebase-config.js 에 Firebase 값 입력
docker compose up -d --build
```

- 관리자 UI: `http://localhost:3000`, 프록시: `http://localhost:4000`
- 학생들이 접속해야 한다면 PC의 내부 IP(예: `http://192.168.0.20:4000`)를 안내하고,
  그 주소를 Firebase 승인된 도메인에도 추가한다. PC가 꺼지면 서비스도 꺼지므로 상시 운영은 NAS 쪽을 권장.
- 중지: `docker compose down` / 로그 확인: `docker compose logs -f litellm`

## NAS/PC 재확인 (이슈 #9)

P0 [#2](https://github.com/progh2/aiapi-manager/issues/2)·[#3](https://github.com/progh2/aiapi-manager/issues/3)을 tarho.local / Synology / PC에서 다시 확인하는 런북: [docs/nas-pc-recheck.md](docs/nas-pc-recheck.md). 결과는 [이슈 #9](https://github.com/progh2/aiapi-manager/issues/9)에 붙인다.

## 사용량 대시보드와 예측

관리자 UI 상단에서 기간(14~90일)과 예측 구간(7~30일)을 골라 볼 수 있다.

- **요약 카드** — 기간 총 지출, 하루 평균, 최근 추세($/일), N일 뒤 누적 예측, 학급/조 예산 소진 예상일
- **누적 지출과 예측** — 실선은 실제, 점선은 예측. 학급/조 예산 합계가 지출과 비슷한 규모면 예산선도 함께 그린다
- **일별 지출** — 하루 단위 막대. 주말·과제 마감 같은 패턴이 드러난다
- **학생별 / 학급/조별 지출** — 회색 트랙이 예산, 색 막대가 사용액. 예산을 넘긴 학생은 빨간 막대에 `초과` 표시

### 예측 방식과 한계

최근 기간의 **누적 지출에 최소제곱 직선을 맞춰** 연장한 값이다(단순 선형 추세). 계산은 서버의
`forecast()` 한 함수에 있고, 그래서 다음 성질을 갖는다.

- 지금까지의 속도가 유지된다고 가정한다. **시험 기간이나 과제 마감처럼 사용이 몰리는 구간은 반영하지 못한다.**
- 방학·휴일로 사용이 끊기면 예측이 과대평가된다. 반대로 학기 초 데이터로 예측하면 과소평가되기 쉽다.
- 기록이 3일 미만이면 예측을 내지 않는다.

즉 **"이 속도라면 대략 이쯤"** 정도의 감을 잡는 용도이고, 정확한 지출 보장이 아니다.
실제 차단은 예측이 아니라 LiteLLM의 예산 한도가 담당한다.

데이터 출처는 LiteLLM의 `/user/daily/activity`다. (`/global/spend/report`는 엔터프라이즈 전용이라 쓰지 않는다.)

## 학급/조 운영

반이나 조 단위로 묶어 관리할 수 있다. **학급/조 예산은 소속 학생들의 합산 사용량에 적용**되고,
개별 키 예산과 중첩으로 걸린다. 예를 들어 "3학년A반 전체 $50 + 학생당 $2"처럼 두 겹으로 막을 수 있다.

관리자 UI의 **학급/조 관리** 영역에서 학급/조를 만들고(예산·리셋 주기·허용 모델·RPM/TPM 지정),
키 발급 시 **소속 학급/조**를 고르면 그 학급/조에 들어간다. 키 목록은 학급/조로 필터링된다.

### 학급·키 모델 허용 목록

수업에서 쓸 모델만 열어 두려면 학급/조를 만들거나 수정할 때, 또는 키를 발급·수정할 때
**허용 모델**을 고른다. 예: `gpt-4o-mini`만.

- 값은 LiteLLM 학급/키의 `models` 필드로 넘어간다. 새 인증 체계는 없다
- 학급에만 정하고 키 발급 때 비워 두면, 그 학급 목록이 키에 복사된다
- 키와 학급이 둘 다 있으면 **교집합**만 허용된다. 목록에 없는 모델은 프록시가 거부한다
- 아무것도 고르지 않으면 제한 없음(프록시에 올라온 모델 전체)

일괄 부여 화면에서도 같은 체크박스를 쓴다. CLI는 `--models gpt-4o-mini`(기본값)이다.

### 학급 일괄 예산 할당

관리자 UI의 **학급 일괄 예산 할당**에서 학급/조·인당 예산·만료일(달력)을 고른 뒤 명단을 넣는다.

- **CSV 파일**을 올리거나, 한 줄에 한 명씩 붙여넣는다
- 헤더 `학번,이름` 과 CLI와 같은 `name,student_id` 둘 다 된다. 헤더가 없으면 첫 칸이 숫자일 때 학번으로 본다
- 새 학급 이름을 적으면 없는 반은 그때 만든다
- 만료일을 고르면 그날 끝까지로 LiteLLM `duration`을 계산한다 (`/key/generate`는 상대 기간만 받음)

```
학번,이름
20261001,홍길동
20261002,김철수
```

끝나면 **행마다 성공/실패**가 표로 나오고, 성공한 키는 `alias,student_id,name,api_key` CSV로 받을 수 있다.
키는 이때만 볼 수 있으므로 반드시 내려받는다. 이미 있는 별칭은 실패로 남고 나머지는 계속 발급된다.

### 캠프 짧은 키 (명단 없이 N개)

중학생 AI 체험캠프처럼 학번 명단이 없으면 **캠프 짧은 키**에서 인원 N만 넣고 만든다.

- 만료는 **오늘 23:59 당일 종료**로 고정이다. 다른 날로 바꿀 수 없다
- 허용 모델은 **저가 모델만 필수** (이 프록시 기본: `gpt-4o-mini`). `gpt-4o` 는 거절한다
- 코드는 `CAMP-A7K2`처럼 짧고, 헷갈리는 글자(0/O, 1/I/L)는 빼 둔다
- 학생 API 키는 코드 앞에 `sk-`를 붙인 `sk-CAMP-A7K2`이다. LiteLLM이 짧은 커스텀 키를 거절하면 장문 `sk-…`를 만들고, 목록에 코드↔키 매핑을 같이 보여 준다
- 결과는 큰 글씨 목록·복사·CSV·인쇄용 보기
- 캠프가 끝나면 **오늘 캠프 키 일괄 차단** 또는 아래 스케줄 훅으로 막는다

관리 API `POST /api/keys/camp` `{ count, prefix?, budget?, team_id?, models }` 는 다른 관리 API와 같이 Firebase ID 토큰 + `ADMIN_EMAILS`이다. `models` 는 저가 모델 1개 이상 필수. `expires` 를 오늘이 아닌 값으로 보내면 400이다.

### 캠프 키 당일 회수

LiteLLM `duration`(오늘 23:59:59)에 더해, 운영자가 캠프 키만 모아 차단할 수 있다. 학급 일괄 키는 건드리지 않는다.

- 화면: **오늘 캠프 키 일괄 차단** (수업이 일찍 끝났을 때) / **만료된 캠프 키 차단**
- 관리 API `POST /api/keys/camp/revoke` `{ action: "block"|"delete", when: "today"|"due"|"all" }`
- 같은 필터를 `POST /api/keys/revoke` 의 `filter=camp|camp_today|camp_due` 로도 쓸 수 있다
- 스케줄(cron)은 LiteLLM 마스터 키로 아래를 자정 직후에 돌린다

```sh
python3 scripts/revoke_camp_keys.py \
  --base-url http://NAS주소:4000 --master-key $LITELLM_MASTER_KEY \
  --when due --action block
```

키 메타 `metadata.aiapi_camp.schedule_revoke` 에 `{ at: "end_of_day", filter: "camp_due", action: "block" }` 를 남겨 둔다.

### 기간 만료 키 일괄 회수·차단

학기·캠프가 끝나면 키 목록에서 학급/조 또는 **만료됨 / 만료 임박(7일)** 필터로 모은 뒤
선택한 키를 한꺼번에 막는다.

- **일괄 차단** — 개별 차단과 같은 LiteLLM `/key/block`. 학생은 더 이상 호출할 수 없고, 나중에 해제할 수 있다
- **일괄 회수(삭제)** — 개별 삭제와 같은 `/key/delete`. 되돌릴 수 없다
- 결과는 행마다 성공/실패. 이미 차단된 키는 차단 시 성공(이미 차단됨)으로 남긴다
- 확인 대화상자 후에만 실행된다. 관리 API는 계속 Firebase ID 토큰 + `ADMIN_EMAILS`

### 개별 학생 예산 충전·기간 연장

키 목록의 **상세**에서 한 학생만 금액을 더하거나 만료를 늘린다. 일반 **수정**은 한도를 통째로 바꾸고, 연장은 지금부터 N일이다.

- **예산 충전** — 현재 `max_budget`에 가산한다 (예: $2 → $4). 무제한 키는 수정에서 한도를 먼저 정한다
- **기간 연장** — 기존 만료일이 미래면 그 날짜에 일수를 더하고, 지났거나 없으면 지금부터 더한다. 달력 만료일도 된다
- **이력** — 누가·언제·얼마(또는 새 만료)가 키 상세에 남는다. LiteLLM `/key/update`의 `metadata.aiapi_history`에 저장된다
- 관리 API `GET /api/keys/info`, `POST /api/keys/adjust` 는 Firebase ID 토큰 + `ADMIN_EMAILS`

## 학생 키 일괄 발급 (CLI)

```sh
python3 scripts/issue_keys.py students.csv \
  --base-url http://NAS주소:4000 --master-key $LITELLM_MASTER_KEY \
  --budget 2.0 --models gpt-4o-mini --output issued_keys.csv
```

`students.csv`는 `name,student_id` 또는 `학번,이름` 헤더 (`students.example.csv` 참고).
발급 결과 `issued_keys.csv`를 학생들에게 개별 배포한 뒤 삭제한다. 끝에 성공/실패 건수가 출력된다.

그룹에 넣으면서 학기 종료일로 발급하려면:

```sh
python3 scripts/issue_keys.py students.csv \
  --base-url http://NAS주소:4000 --master-key $LITELLM_MASTER_KEY \
  --team 3학년A반 --team-budget 50 \
  --budget 2.0 --budget-duration 30d --expires 2026-12-31 --rpm 10 --output issued_keys.csv
```

`--team`은 같은 이름의 그룹이 있으면 재사용하고, 없으면 새로 만든다.
`--expires`가 있으면 `--duration`보다 우선한다 (그날 23:59:59까지).

| 옵션 | 의미 |
|---|---|
| `--budget` | 학생 1명당 예산(USD) |
| `--budget-duration` | 예산 리셋 주기 (`1d`/`7d`/`30d`). 생략하면 총액 한도 |
| `--duration` | 키 만료 기한 (`90d` = 한 학기). 생략하면 무기한 |
| `--expires` | 달력 만료일 (`YYYY-MM-DD`). LiteLLM `duration`으로 변환 |
| `--rpm` / `--tpm` | 분당 요청 수 / 토큰 수 제한 |
| `--models` | 허용 모델. 기본 `gpt-4o-mini`. 새 학급을 만들 때도 같이 넣는다 |
| `--team` / `--team-budget` | 소속 그룹과 그룹 전체 예산 |

## 학생 사용법

```python
from openai import OpenAI
client = OpenAI(api_key="발급받은 키", base_url="http://NAS주소:4000")
resp = client.chat.completions.create(model="gpt-4o-mini", messages=[...])
```

예산이 소진되면 요청이 자동 차단된다. 사용량은 관리자 UI 또는
LiteLLM 자체 대시보드(`http://NAS주소:4000/ui`, 마스터 키로 로그인)에서 확인.


## Postgres 백업·복구

절차·스크립트: [docs/postgres-backup.md](docs/postgres-backup.md) (`scripts/backup_postgres.sh`, `scripts/restore_postgres.sh`).
NAS/PC에서 키·조 UI까지 재확인하는 순서는 [docs/nas-pc-recheck.md](docs/nas-pc-recheck.md) (이슈 #9).

## 보안 메모

- 실제 OpenAI 키와 마스터 키는 `.env`에만 존재하며 git에 커밋하지 않는다 (`.gitignore` 처리됨).
- Postgres는 외부 포트를 열지 않고 도커 내부 네트워크로만 접근한다.
- admin-ui는 Firebase ID 토큰을 서버에서 검증하고 `ADMIN_EMAILS` 목록에 있는 계정만 허용한다.
- 전체 시스템은 학교 내부망 전용을 전제로 한다. 외부 노출이 필요해지면 Cloudflare Tunnel 등을 앞단에 둘 것.
