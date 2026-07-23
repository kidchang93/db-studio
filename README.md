# DB Studio

DataGrip 스타일의 크로스플랫폼 데스크톱 DB 클라이언트. 스키마 탐색 · 데이터 그리드 인라인 CRUD · SQL 에디터를 제공한다.

- **지원 DB**: PostgreSQL · MySQL/MariaDB · SQLite · SQL Server
- **기술 스택**: Tauri v2 (Rust) + React 19 / TypeScript / Vite 7
- **배포**: Windows(`.msi`/`.exe`) · macOS(`.dmg`/`.app`) — 사내 배포용

프로젝트 기준과 아키텍처는 루트 `CLAUDE.md` 및 `docs/` 를 먼저 참고한다.

## 사전 준비

| 도구 | 비고 |
|------|------|
| Node.js 20+ | 프론트엔드 |
| Rust (stable) | 백엔드/번들 |
| OS별 Tauri 의존성 | macOS: Xcode CLT / Windows: WebView2 + MSVC 빌드툴 |

Tauri 시스템 요구사항: https://tauri.app/start/prerequisites/

## 개발

```bash
npm install
npm run tauri dev      # 핫리로드로 데스크톱 앱 실행
```

## 릴리스 & 자동 업데이트 (GitHub Releases)

태그를 푸시하면 GitHub Actions(`.github/workflows/release.yml`)가 **macOS(유니버설) + Windows** 실행파일을 빌드·서명하고 릴리스를 만든다. 설치된 앱은 시작 시 최신 릴리스를 확인해 **자동 업데이트**한다.

### 최초 1회 셋업

1. GitHub에 **public** 저장소 `kidchang93/db-studio` 를 만들고 이 코드를 푸시한다.
   - 저장소 이름을 다르게 하려면 `src-tauri/tauri.conf.json` 의 `plugins.updater.endpoints` URL을 그 이름으로 바꾼다.
2. 저장소 **Settings → Secrets and variables → Actions → New repository secret** 에 두 개 등록:
   | 이름 | 값 |
   |------|-----|
   | `TAURI_SIGNING_PRIVATE_KEY` | 로컬 파일 `~/.tauri/db-studio-updater.key` 의 **전체 내용** |
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 빈 값(키 생성 시 비밀번호를 설정하지 않았다면) |
   - 공개키는 이미 `tauri.conf.json` 에 들어 있다(`plugins.updater.pubkey`). 개인키 파일은 **절대 커밋하지 않는다.**

### 새 버전 배포

```bash
# 1) 버전 올리기: src-tauri/tauri.conf.json 의 version (+ package.json, Cargo.toml)
# 2) 커밋 후 태그 푸시
git commit -am "release: v0.1.1"
git tag v0.1.1
git push origin main --tags
```

→ Actions가 빌드/서명/릴리스를 자동 수행한다. 몇 분 뒤 릴리스 페이지에 `.dmg`/`.msi`/`.exe` 와 `latest.json` 이 올라온다. 기존 사용자 앱은 다음 실행 시 새 버전을 감지해 하단 상태바에 **업데이트 버튼**을 띄운다.

### 로컬 단발 빌드(서명·업데이트 없음)

```bash
npm run tauri build
```
- macOS: `src-tauri/target/release/bundle/dmg/*.dmg`, `.../macos/*.app`
- Windows: `src-tauri/target/release/bundle/msi/*.msi`, `.../nsis/*.exe`

> 사내 배포이므로 OS 코드 서명/공증은 하지 않는다. 미서명 시 첫 실행에서 macOS
> Gatekeeper("우클릭 → 열기"로 우회) · Windows SmartScreen 경고가 표시될 수 있다.
> 이는 업데이터의 minisign 서명과는 별개다.

### 코드 서명 (선택 — 경고 제거)

Gatekeeper/SmartScreen 경고를 없애려면 OS 코드 서명이 필요하다(유료 인증서). **인증서 없이도 릴리스는 정상 동작하며**, 아래 시크릿을 등록하면 릴리스 워크플로우가 자동으로 서명한다(비어 있으면 서명을 건너뛴다).

**macOS** (Apple Developer 계정 필요) — 아래 GitHub Secrets 등록 시 자동 서명 + 공증:

| Secret | 값 |
|--------|-----|
| `APPLE_CERTIFICATE` | Developer ID Application 인증서(.p12)를 base64 인코딩한 값 |
| `APPLE_CERTIFICATE_PASSWORD` | .p12 비밀번호 |
| `APPLE_SIGNING_IDENTITY` | 예: `Developer ID Application: 이름 (TEAMID)` |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | 공증용 Apple ID · 앱 전용 비밀번호 · 팀 ID |

**Windows** (Authenticode 인증서 필요) — `src-tauri/tauri.conf.json` 의 `bundle.windows` 에 인증서 지문을 추가하고 러너에 인증서를 설치하거나, Azure Trusted Signing 등을 `signCommand` 로 연결한다. (미서명 시 SmartScreen "추가 정보 → 실행"으로 우회 가능.)

## 품질 검사

```bash
# 백엔드
cd src-tauri && cargo test && cargo clippy --all-targets && cargo fmt --check
# 프론트엔드
npm run build         # tsc 타입체크 + vite 번들
```

## 사용법

1. 좌측 사이드바 상단 **＋** 로 연결을 추가한다(DB 종류별 폼).
2. **연결 테스트** 로 접속을 확인하고 저장한다. 비밀번호는 OS 키체인에 저장된다.
3. 프로필을 **더블클릭**(또는 🔌)하여 연결하면 스키마 트리가 펼쳐진다.
4. 테이블을 **더블클릭**하면 데이터 그리드가 열린다.
   - 셀 **더블클릭**으로 편집, **행 추가** / 행 번호 클릭 후 **선택 삭제**, 변경은 **커밋**(트랜잭션) 시 반영.
   - 정렬은 컬럼 헤더 클릭, 페이지네이션은 상단 화살표.
5. **SQL 콘솔**(터미널 아이콘)로 임의 쿼리를 실행한다(Ctrl/Cmd+Enter = 실행).

## 알려진 한계 (MVP)

- SQL Server(tiberius)의 DATE/TIME/DATETIME·XML 값은 현재 best-effort 문자열로 표시된다.
- Postgres 등 강타입 DB에서 그리드 편집 시, 입력값 타입이 컬럼 타입과 다르면 DB 오류가 그대로 표시될 수 있다(문자열/정수/불리언 등 일반 타입은 정상).
- 결과 그리드는 페이지 단위 제한(테이블 200행 / 쿼리 5000행)으로 대용량을 방어한다. 가상 스크롤은 후속 과제.
- 자세한 로드맵/설계 근거는 `docs/DESIGN.md`.
