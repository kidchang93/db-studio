# ARCHITECTURE

## 1. 큰 그림

```
┌──────────────────────────────────────────────────────────┐
│  Frontend (WebView) — React 19 + TS                       │
│                                                            │
│  features/ (connections · explorer · grid · query · layout)│
│     │  호출은 반드시 api/ 래퍼를 경유                       │
│     ▼                                                      │
│  api/  ── invoke("command", args) ──►                      │
│  store/ (zustand): connection · workspace · grid 상태      │
└───────────────────────────────┬──────────────────────────┘
                                 │ Tauri IPC (JSON, serde)
┌───────────────────────────────▼──────────────────────────┐
│  Backend (Rust, tokio) — src-tauri/                        │
│                                                            │
│  commands/  (connection · metadata · data · query)         │
│     │  얇은 계층: 인자 검증 → state 조회 → db 호출 → 매핑   │
│     ▼                                                      │
│  state.rs  (AppState: 활성 커넥션 레지스트리, Mutex)        │
│     ▼                                                      │
│  db/  Driver 트레이트 ──► postgres · mysql · sqlite · mssql │
│     │        value.rs: DB 셀 ↔ serde_json::Value           │
│     ▼                                                      │
│  profiles.rs (프로필 JSON + keyring 비밀번호)              │
└───────────────────────────────┬──────────────────────────┘
                                 │ 네트워크 / 파일
                         PostgreSQL · MySQL · SQLite · SQL Server
```

## 2. 디렉토리 구조

### 프론트엔드 `src/`

| 경로 | 책임 |
|------|------|
| `main.tsx`, `App.tsx` | 엔트리, 최상위 셸 마운트 |
| `types/` | 백엔드 `models.rs`와 1:1 대응하는 TS 타입 (IPC 계약) |
| `api/` | `invoke` 래퍼. **command 하나당 함수 하나.** 컴포넌트는 여기만 호출 |
| `store/` | zustand 스토어. `connectionStore`(프로필·활성연결), `workspaceStore`(탭·활성객체), 그리드/쿼리 상태 |
| `features/connections/` | 프로필 목록, 연결 추가/수정 다이얼로그(DB종류별 폼), 연결/해제 |
| `features/explorer/` | 좌측 스키마 트리 (DB→스키마→테이블→컬럼), 지연 로딩 |
| `features/grid/` | 데이터 그리드: 가상 스크롤, 인라인 편집, pending 변경 추적, 커밋 |
| `features/query/` | SQL 에디터(CodeMirror) + 결과 그리드 |
| `features/layout/` | AppShell, 리사이즈 패널, 탭바, 상태바 |
| `components/` | DB 무관 UI 프리미티브 (Button, Dialog, Select, Icon 등) |
| `styles/` | 전역 CSS, 테마 토큰(다크 기본) |

### 백엔드 `src-tauri/src/`

| 경로 | 책임 |
|------|------|
| `main.rs` | 바이너리 엔트리. `db_studio_lib::run()` 호출만 |
| `lib.rs` | `tauri::Builder` 구성, 플러그인/state/command 등록 |
| `error.rs` | `AppError`(thiserror) + `Result<T>` alias. serde 직렬화되어 프론트로 전달 |
| `models.rs` | IPC 경계의 serde 타입 (요청/응답 DTO). **프론트 `types/`와 동기화 필수** |
| `state.rs` | `AppState`: `connId → DbConnection` 레지스트리 (`tokio::sync::Mutex`) |
| `profiles.rs` | 연결 프로필 영속화(앱 config dir JSON) + `keyring` 비밀번호 |
| `commands/` | Tauri command. 얇게 유지 — 검증·매핑만, DB 로직은 `db/`에 위임 |
| `db/mod.rs` | `Driver` 트레이트, `DbConnection` enum(드라이버 디스패치), 팩토리 |
| `db/sql.rs` | 방언(dialect)별 SQL 빌더: quoting · 플레이스홀더 · 정렬/필터/페이지네이션 · CRUD 문장 |
| `db/value.rs` | DB 네이티브 값 ↔ `serde_json::Value` 변환 (컬럼 타입 → 논리 타입 매핑), 바인딩 매크로 |
| `db/{postgres,mysql,sqlite,mssql}.rs` | 드라이버별 구현 |

## 3. 레이어와 의존성 방향

```
commands  ──►  state  ──►  db (Driver)  ──►  value / (sqlx | tiberius)
   │                                            ▲
   └──► models (DTO) ◄──── db가 채워 반환 ───────┘
profiles ◄── commands (연결 저장/로드 시)
```

- **의존성은 항상 위→아래 단방향.** `db/`는 `commands/`·`state`를 모른다. `models.rs`는 순수 데이터 타입으로 어디서든 참조 가능하되 다른 모듈에 의존하지 않는다.
- `commands/`는 **얇은 어댑터**다. 비즈니스 로직(쿼리 생성, 타입 매핑)은 `db/`에 둔다.
- 프론트 `features/`는 `store/`와 `api/`만 의존한다. `features` 간 직접 import는 지양하고 공유가 필요하면 `components/`·`store/`로 승격한다.

## 4. 핵심 추상화 — `Driver` 트레이트

모든 DB는 하나의 `async` 트레이트로 추상화한다(정확한 시그니처는 `db/mod.rs`가 소스오브트루스). 개념적 표면:

| 메서드 | 역할 |
|--------|------|
| `test` | 연결 검증 (ping) |
| `list_databases` / `list_schemas` / `list_tables` / `list_columns` | 스키마 트리 지연 로딩 |
| `primary_keys(table)` | CRUD의 행 식별용 PK 컬럼 조회 |
| `fetch_page(table, page, sort, filter)` | 그리드 데이터 페이지네이션 조회 |
| `apply_changes(table, edits)` | pending 편집(insert/update/delete)을 **하나의 트랜잭션**으로 반영 |
| `run_query(sql)` | 임의 SELECT → `QueryResult{columns, rows}` |
| `run_execute(sql)` | 임의 DML/DDL → 영향 행 수 |

- 드라이버는 **컴파일타임에 컬럼 타입을 모른다.** 결과는 `value.rs`가 각 셀을 `serde_json::Value`로 변환해 균일한 `QueryResult`로 만든다. 값 타입 손실(예: `NUMERIC`, `BYTEA`, `UUID`)은 컬럼 메타의 `logical_type` 문자열로 보존한다.
- `sqlx`는 Postgres/MySQL/SQLite를 커버하고, SQL Server는 별도 `tiberius`로 구현한다. 두 경로 모두 동일한 `Driver` 트레이트를 만족시켜 `commands/`에서는 구분하지 않는다.

## 5. 데이터 흐름 예시 — 테이블 데이터 편집(CRUD)

1. 사용자가 트리에서 테이블 더블클릭 → `workspaceStore`에 그리드 탭 추가.
2. `api.fetchTablePage(connId, tableRef, page)` → command `data::fetch_table_page` → `state`에서 커넥션 조회 → `driver.fetch_page(...)` → `QueryResult` 반환.
3. 그리드에서 셀 편집/행 추가/삭제 → 즉시 DB에 쓰지 않고 `gridStore`의 pending 변경 세트에 누적(원본 대비 diff).
4. 사용자가 "커밋" → `api.applyChanges(connId, tableRef, edits)` → command `data::apply_changes` → `driver.apply_changes`가 PK 기반 `UPDATE/INSERT/DELETE`를 **트랜잭션**으로 실행.
5. 성공 시 페이지 재조회로 그리드 갱신, 실패 시 롤백 + 오류를 상태바/토스트로 표시.

## 6. 상태(state)와 커넥션 생명주기

- `AppState`는 `connId(String) → DbConnection` 맵을 `tokio::sync::Mutex`로 보관한다. `connId`는 연결 시 발급하는 불투명 ID.
- 커넥션은 내부적으로 커넥션 **풀**(sqlx `Pool`, tiberius는 관리형 커넥션)을 쥔다. 동시 쿼리는 풀에서 처리.
- 앱 종료/명시적 disconnect 시 풀을 닫는다. 프로필(접속정보)과 활성 커넥션(런타임 핸들)은 별개 개념이다.

## 7. 영속화

- **연결 프로필**: 앱 config dir(`app.path().app_config_dir()`)의 `profiles.json`. 비밀번호를 제외한 접속정보 + `keyring` 참조.
- **비밀번호**: `keyring` 크레이트로 OS 키체인(macOS Keychain / Windows Credential Manager)에 `service=DB Studio, account=profileId`로 저장.
- **UI 상태**(열린 탭, 패널 크기 등)는 로컬 저장 대상이나 MVP 범위 밖 → 추후 `docs`에 반영 후 추가.

## 8. 배포 & 자동 업데이트

**릴리스 경로: GitHub Releases + GitHub Actions (`.github/workflows/release.yml`)**

| 대상 | 산출물 | 생성 방법 |
|------|--------|-----------|
| macOS | `.dmg`, `.app`(유니버설) + `.app.tar.gz`/`.sig` | CI: `tauri-action` (matrix `macos-latest`, `--target universal-apple-darwin`) |
| Windows | `.msi`, `.exe`(NSIS) + `.sig` | CI: `tauri-action` (matrix `windows-latest`) |

- `v*` 태그 푸시 → 양 OS 빌드·서명·릴리스 자동 수행. 로컬 `npm run tauri build` 는 서명 없는 단발 빌드용.
- **자동 업데이트**: 앱은 시작 시 `plugins.updater.endpoints`(GitHub Releases의 `latest.json`)를 확인한다. 새 버전이 있으면 상태바에 업데이트 버튼을 띄우고, `downloadAndInstall` → `relaunch` 로 교체한다.
  - 업데이트 무결성은 **minisign** 서명으로 검증한다: 공개키는 `tauri.conf.json`(`plugins.updater.pubkey`), 개인키는 CI 시크릿(`TAURI_SIGNING_PRIVATE_KEY` + `..._PASSWORD`). OS 코드서명과는 별개.
  - 프론트: `src/lib/updater.ts`(check/install 래퍼) + `src/store/updateStore.ts`(상태) + `StatusBar` UI. 백엔드: `tauri-plugin-updater` + `tauri-plugin-process`(재시작), 데스크톱 한정 등록.
- 사내 배포이므로 OS 코드서명/공증은 하지 않음. 미서명 시 첫 실행에서 macOS Gatekeeper·Windows SmartScreen 경고가 뜰 수 있음을 안내한다.
- `tiberius`/`sqlx`의 TLS는 `rustls` 기반으로 벤더링해 OS별 네이티브 TLS 의존성을 줄인다.
