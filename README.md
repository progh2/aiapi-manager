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
| `docker-compose.yml` | LiteLLM + Postgres + admin-ui 세 컨테이너 |
| `litellm/config.yaml` | 학생에게 노출할 모델 목록 |
| `admin-ui/` | 관리자 웹 UI. Firebase 구글 로그인 → 그룹·키 관리, 사용량 조회 |
| `scripts/issue_keys.py` | 학생 명단 CSV로 키 일괄 발급 (표준 라이브러리만 사용) |

## 공통 사전 준비 (최초 1회)

어디에 설치하든 아래 두 가지를 먼저 끝낸다.

### 1. Firebase 설정 (관리자 로그인용)

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

## 그룹(반·조) 운영

반이나 조 단위로 묶어 관리할 수 있다. **그룹 예산은 소속 학생들의 합산 사용량에 적용**되고,
개별 키 예산과 중첩으로 걸린다. 예를 들어 "3학년A반 전체 $50 + 학생당 $2"처럼 두 겹으로 막을 수 있다.

관리자 UI의 **그룹 관리** 영역에서 그룹을 만들고(예산·리셋 주기·RPM/TPM 지정),
키 발급 시 **소속 그룹**을 고르면 그 그룹에 들어간다. 키 목록은 그룹으로 필터링된다.

### 여러 학생 한 번에 추가

관리자 UI의 **여러 명 일괄 발급** 칸에 명단을 한 줄에 한 명씩 붙여넣는다.

```
20261001,홍길동
20261002,김철수
```

발급이 끝나면 `학번-이름,키` 형식의 **CSV 다운로드 링크**가 뜬다. 키는 이때만 볼 수 있으므로 반드시 내려받는다.
이미 있는 별칭은 건너뛰고 나머지는 계속 발급되므로, 명단에 기존 학생이 섞여 있어도 안전하다.

## 학생 키 일괄 발급 (CLI)

```sh
python3 scripts/issue_keys.py students.csv \
  --base-url http://NAS주소:4000 --master-key $LITELLM_MASTER_KEY \
  --budget 2.0 --models gpt-4o-mini --output issued_keys.csv
```

`students.csv`는 `name,student_id` 헤더 형식 (`students.example.csv` 참고).
발급 결과 `issued_keys.csv`를 학생들에게 개별 배포한 뒤 삭제한다.

그룹에 넣으면서 학기 단위로 발급하려면:

```sh
python3 scripts/issue_keys.py students.csv \
  --base-url http://NAS주소:4000 --master-key $LITELLM_MASTER_KEY \
  --team 3학년A반 --team-budget 50 \
  --budget 2.0 --budget-duration 30d --duration 90d --rpm 10 --output issued_keys.csv
```

`--team`은 같은 이름의 그룹이 있으면 재사용하고, 없으면 새로 만든다.

| 옵션 | 의미 |
|---|---|
| `--budget` | 학생 1명당 예산(USD) |
| `--budget-duration` | 예산 리셋 주기 (`1d`/`7d`/`30d`). 생략하면 총액 한도 |
| `--duration` | 키 만료 기한 (`90d` = 한 학기). 생략하면 무기한 |
| `--rpm` / `--tpm` | 분당 요청 수 / 토큰 수 제한 |
| `--team` / `--team-budget` | 소속 그룹과 그룹 전체 예산 |

## 학생 사용법

```python
from openai import OpenAI
client = OpenAI(api_key="발급받은 키", base_url="http://NAS주소:4000")
resp = client.chat.completions.create(model="gpt-4o-mini", messages=[...])
```

예산이 소진되면 요청이 자동 차단된다. 사용량은 관리자 UI 또는
LiteLLM 자체 대시보드(`http://NAS주소:4000/ui`, 마스터 키로 로그인)에서 확인.

## 보안 메모

- 실제 OpenAI 키와 마스터 키는 `.env`에만 존재하며 git에 커밋하지 않는다 (`.gitignore` 처리됨).
- Postgres는 외부 포트를 열지 않고 도커 내부 네트워크로만 접근한다.
- admin-ui는 Firebase ID 토큰을 서버에서 검증하고 `ADMIN_EMAILS` 목록에 있는 계정만 허용한다.
- 전체 시스템은 학교 내부망 전용을 전제로 한다. 외부 노출이 필요해지면 Cloudflare Tunnel 등을 앞단에 둘 것.
