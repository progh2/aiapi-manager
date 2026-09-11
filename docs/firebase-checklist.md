# Firebase 설정 체크리스트

관리자 UI 구글 로그인에 필요한 사전 준비. 설치할 때마다 아래를 빠짐없이 확인한다.

로컬 기동은 기존과 같다: `docker compose up -d --build`

## 체크리스트

- [ ] **Firebase 프로젝트 생성**
  - [Firebase 콘솔](https://console.firebase.google.com) → 프로젝트 추가
  - 이름 예: `aiapi-manager` (애널리틱스는 꺼도 됨)
  - 콘솔에 표시된 **프로젝트 ID**를 적어 둔다

- [ ] **Authentication → Google 활성화**
  - 빌드 → Authentication → 시작하기 → 로그인 방법 → **Google** 사용 설정
  - 지원 이메일 선택 후 저장

- [ ] **승인된 도메인** (NAS 내부 IP + localhost)
  - Authentication → 설정 → 승인된 도메인
  - NAS라면 내부 IP 추가 (예: `192.168.0.10`). 호스트만 넣고 `http://`·포트는 빼기
  - `localhost`는 기본 포함. PC에서 `http://localhost:3000`이면 추가 불필요
  - 브라우저가 내부 IP로 접속한다면 그 IP도 넣기

- [ ] **웹 앱 `firebaseConfig` → `admin-ui/public/firebase-config.js`**
  - 프로젝트 개요 옆 톱니 → 프로젝트 설정 → 내 앱 → 웹 앱(`</>`) 추가
  - 표시되는 값 중 `apiKey`, `authDomain`, `projectId`만 붙여넣기
  - 저장소에는 `REPLACE_ME` 플레이스홀더만 둔다. 실제 값은 커밋하지 않음

  ```js
  window.FIREBASE_CONFIG = {
    apiKey: "REPLACE_ME",
    authDomain: "REPLACE_ME.firebaseapp.com",
    projectId: "REPLACE_ME",
  };
  ```

- [ ] **`.env`: `FIREBASE_PROJECT_ID`, `ADMIN_EMAILS`**
  - 저장소 루트에서 `cp .env.example .env` 후 채움
  - `FIREBASE_PROJECT_ID=my-firebase-project` — 콘솔 프로젝트 ID. `firebase-config.js`의 `projectId`와 **같아야** 함
  - `ADMIN_EMAILS=admin@example.com` — 관리자로 허용할 구글 계정 (쉼표 구분, 여러 명이면 `a@example.com,b@example.com`)
  - `.env`는 git에 올리지 않음 (`.gitignore`)
  - 값을 바꾼 뒤에는 `docker compose up -d --build`로 컨테이너를 다시 띄운다

## 메모

- `.env`와 채워 넣은 `firebase-config.js`는 공개 저장소에 커밋하지 않는다.
- `FIREBASE_PROJECT_ID`와 `firebase-config.js`의 `projectId`가 다르면 토큰 검증이 실패한다.
- `ADMIN_EMAILS`에 없는 계정은 로그인해도 관리 화면에 들어가지 못한다.
- `auth/unauthorized-domain`이면 지금 접속 중인 호스트(NAS IP 또는 `localhost`)를 승인된 도메인에 추가한다.

## 검수 체크 (이슈 #4)

1. 위 체크리스트대로 설정한 뒤 `docker compose up -d --build`
2. `ADMIN_EMAILS`에 있는 구글 계정으로 `http://localhost:3000`(또는 `http://NAS내부IP:3000`) 로그인 → 관리 화면 진입
3. 목록에 없는 계정으로 로그인 시도 → 관리 권한 없음 / 로그인 화면으로 돌아감
