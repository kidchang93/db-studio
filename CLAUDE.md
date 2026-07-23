# DB Studio

DataGrip 스타일의 크로스플랫폼 데스크톱 DB 클라이언트. 스키마 탐색 · 데이터 그리드 인라인 CRUD · SQL 에디터를 제공하며, PostgreSQL / MySQL·MariaDB / SQLite / SQL Server 를 지원한다. 사내 배포용(Windows · macOS 실행파일)이며 앱스토어/서명 배포는 범위 밖이다.

## 기술 스택

| 계층 | 기술 |
|------|------|
| 셸/번들 | Tauri v2 (Rust) — Windows `.msi`/`.exe`, macOS `.dmg`/`.app` |
| 백엔드 | Rust (tokio async), Tauri command IPC |
| DB 드라이버 | `sqlx`(PostgreSQL·MySQL·SQLite) + `tiberius`(SQL Server) |
| 프론트엔드 | React 19 + TypeScript + Vite 7 |
| 상태관리 | zustand |
| 데이터 그리드 | `@tanstack/react-table` + `@tanstack/react-virtual` (가상 스크롤) |
| SQL 에디터 | `@uiw/react-codemirror` + `@codemirror/lang-sql` |
| 레이아웃 | `react-resizable-panels` |

> 정확한 버전과 feature 플래그는 `package.json` / `src-tauri/Cargo.toml`이 **단일 진실 원천**이다. 문서에는 버전을 중복 기재하지 않는다.

## 빌드 / 실행 명령어

| 목적 | 명령어 | 위치 |
|------|--------|------|
| 의존성 설치 | `npm install` | 루트 |
| 개발 실행 (핫리로드) | `npm run tauri dev` | 루트 |
| 프론트 타입체크+빌드 | `npm run build` (`tsc && vite build`) | 루트 |
| 로컬 단발 번들 | `npm run tauri build` | 루트 |
| 릴리스(양 OS 자동) | `git tag v0.x.y && git push --tags` → GitHub Actions | 루트 |
| Rust 컴파일 체크 | `cargo check` | `src-tauri/` |
| Rust 린트 | `cargo clippy --all-targets` | `src-tauri/` |
| Rust 포맷 | `cargo fmt` | `src-tauri/` |
| Rust 테스트 | `cargo test` | `src-tauri/` |

정식 배포는 **GitHub Actions**(`.github/workflows/release.yml`)로 태그 푸시 시 macOS(유니버설)·Windows 실행파일을 자동 빌드·서명·릴리스한다. 설치된 앱은 시작 시 **자동 업데이트**를 확인한다(minisign 서명 검증). 상세는 `docs/ARCHITECTURE.md`의 "배포 & 자동 업데이트" 절과 `README.md`. 로컬 `npm run tauri build`는 서명 없는 단발 빌드용.

## docs 인덱스 — 작업 전 필독 매핑

| 작업 | 먼저 읽을 문서 |
|------|----------------|
| 모듈 배치 / 레이어 / IPC 흐름 파악 | `docs/ARCHITECTURE.md` |
| 새 DB 드라이버 추가, Driver 트레이트 변경 | `docs/ARCHITECTURE.md` + `docs/DESIGN.md` |
| 새 Tauri command / 프론트 API 추가 | `docs/DESIGN.md` |
| 네이밍 · 파일 배치 · 언어별 컨벤션 | `docs/CODE_STYLE.md` |
| PR/머지 전 자가 점검 | `docs/REVIEW.md` |
| 서브에이전트로 작업 분담 | `docs/SUBAGENTS.md` |

## 절대 하지 말아야 할 것

- **사용자 입력 값을 SQL 문자열에 직접 이어붙이지 않는다.** 값은 항상 드라이버 파라미터 바인딩으로 전달한다. 식별자(테이블/컬럼명)는 DB별 규칙으로 quoting 후 사용한다. (`docs/DESIGN.md` "SQL 안전성")
- **DB 비밀번호를 프로필 JSON에 평문 저장하지 않는다.** 비밀번호는 OS 키체인(`keyring`)에 저장하고, 프로필 파일에는 참조 키만 남긴다.
- **드라이버 결과를 프론트 타입 없이 반환하지 않는다.** 모든 IPC 반환 타입은 `src-tauri/src/models.rs`의 serde 타입과 `src/types/`의 TS 타입이 1:1로 대응해야 한다.
- **블로킹 DB 호출을 UI 스레드/동기 command로 만들지 않는다.** command는 `async fn`으로 작성하고 tokio 위에서 동작시킨다.
- **`.unwrap()` / `.expect()`를 command 경로에 남기지 않는다.** 오류는 `AppError`로 변환해 프론트에 문자열/코드로 전달한다(`src-tauri/src/error.rs`).
- **그리드 편집을 즉시 자동 커밋하지 않는다.** 변경은 pending 상태로 모았다가 사용자가 명시적으로 커밋(트랜잭션)한다. (`docs/DESIGN.md` "CRUD 편집 모델")
- 기존 표준 문서를 근거 없이 덮어쓰지 않는다. 아키텍처·컨벤션이 바뀌면 같은 작업에서 해당 문서를 함께 갱신한다.
