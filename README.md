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
| `admin-ui/` | 관리자 웹 UI. Firebase 구글 로그인 → 허용된 이메일만 키 발급/삭제/사용량 조회 |
| `scripts/issue_keys.py` | 학생 명단 CSV로 키 일괄 발급 (표준 라이브러리만 사용) |

## 설치 (NAS)

1. **Firebase 설정** (관리자 로그인용, 최초 1회)
   - [Firebase 콘솔](https://console.firebase.google.com)에서 프로젝트 생성
   - Authentication → Sign-in method → **Google** 활성화
   - Authentication → Settings → 승인된 도메인에 NAS 내부 IP/호스트명 추가
   - 프로젝트 설정 → 웹 앱 등록 후 config 값을 `admin-ui/public/firebase-config.js`에 입력
2. **환경 변수**
   ```sh
   cp .env.example .env   # 값 채우기: OpenAI 키, 마스터 키, DB 비번, Firebase 프로젝트 ID, 관리자 이메일
   ```
3. **기동** — NAS에 이 저장소를 클론한 뒤:
   ```sh
   docker compose up -d --build
   ```
   - LiteLLM 프록시: `http://NAS주소:4000`
   - 관리자 UI: `http://NAS주소:3000`

## 학생 키 일괄 발급

```sh
python3 scripts/issue_keys.py students.csv \
  --base-url http://NAS주소:4000 --master-key $LITELLM_MASTER_KEY \
  --budget 2.0 --models gpt-4o-mini --output issued_keys.csv
```

`students.csv`는 `name,student_id` 헤더 형식 (`students.example.csv` 참고).
발급 결과 `issued_keys.csv`를 학생들에게 개별 배포한 뒤 삭제한다.

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
