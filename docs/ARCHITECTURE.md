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
| `store/` | zustand 스토어. `connectionStore`(프로필·활성연결), `workspaceStore`(탭·활성객체), `logStore`(실행 로그), 그리드/쿼리 상태 |
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
| `db/script.rs` | 스크립트 텍스트 훑기: SQL Server `GO` 배치 분리, 결과셋 여부 판정, 변경 행 반환 절(`OUTPUT`/`RETURNING`) 삽입 |
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
| `run_query(sql)` | 단일 SELECT → `QueryResult{columns, rows}`. 내부 조회용(트레이트 메서드) |
| `run_execute(sql)` | 단일 DML/DDL → 영향 행 수. 내부 실행용(트레이트 메서드) |
| `run_script(sql, opts)` | 문장 여러 개 → `ScriptResult{results[], rowsAffected, sql[]}`. **SQL 콘솔이 쓰는 유일한 실행 경로**. `opts.captureChanges` 로 변경 행까지 받는다 |

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
- **SQL Server 는 유휴 연결에 주기적으로 `SELECT 1` 을 보낸다**(`KEEPALIVE_INTERVAL`, 3분). 이보다 오래 조용하면 서버·방화벽이 TCP 를 끊고, 다음 쿼리에서 재연결이 일어난다. 그때 죽은 소켓은 FIN 을 보내지 못해 **서버에 옛 세션이 그대로 남는다** — 앱을 켜 두기만 해도 20~30분마다 세션이 하나씩 쌓이던 원인이다. 태스크는 클라이언트를 `Weak` 로 참조해 드라이버가 사라지면 함께 끝난다. sqlx 계열은 풀이 커넥션을 닫을 때 정상 종료를 보내므로 해당 없다.
- **커넥션 하나가 서버 세션 하나다.** sqlx 풀은 최대 3개로 두고(그리드 조회 + 콘솔 실행이 겹쳐도 충분하다) 유휴 3분·수명 30분으로 회수한다. 앱을 켜 둔 채 손을 놓는 시간이 길어서, 그동안 자리를 붙들고 있을 이유가 없다.
- 앱 종료/명시적 disconnect 시 풀을 닫는다. **종료 경로는 두 갈래다** — 정상 종료는 `RunEvent::Exit`, 시그널(SIGTERM·SIGINT)은 `setup` 에서 띄운 핸들러가 잡는다. 둘 다 `AppState::close_all` 을 부른다. `RunEvent::Exit` 만으로는 부족하다 — `tauri dev` 가 재빌드하며 앱을 죽이거나 `kill` 로 끝낼 때는 오지 않아 세션이 그대로 남는다(개발 중 세션이 100개 넘게 쌓인 원인). SIGKILL 은 어떤 코드로도 잡을 수 없어 예외다 — 프로세스가 그냥 사라져도 OS 가 소켓을 정리하긴 하지만 서버가 그것을 알아채기까지 세션이 남아 있어(TCP keepalive 타임아웃), 연결 수가 제한된 운영 DB 에서는 그 사이에 자리를 차지한다.
- 각 드라이버는 접속 시 `application_name` 을 **"DB Studio"** 로 채운다(사용자가 `params` 로 지정하면 그것을 쓴다). 서버의 세션 목록(`sys.dm_exec_sessions.program_name` · `pg_stat_activity.application_name`)에서 우리 앱 세션을 구분해 남은 것을 찾아낼 수 있어야 하기 때문이다.
- 프로필(접속정보)과 활성 커넥션(런타임 핸들)은 별개 개념이다.

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
- **릴리스는 3단계**다. `create-release` 가 draft 릴리스를 **하나만** 만들어 그 id 를 넘기고, `build` 잡들이 그 릴리스에만 자산을 올린 뒤, `publish` 가 검증 후 공개한다.
  - id 를 공유하지 않으면 각 빌드 잡이 "태그로 draft 를 찾고 없으면 생성"을 각자 수행하는데, **draft 릴리스는 같은 태그로 여러 개 만들 수 있어** 두 잡이 서로 다른 릴리스에 올린다. 그러면 공개된 쪽 외의 플랫폼이 통째로 누락된다(v0.1.12 에서 macOS 자산이 사라진 원인).
  - `build` 잡은 `releaseId` 와 `tagName` 을 **둘 다** tauri-action 에 넘긴다. 릴리스 생성은 `releaseId` 가 있으면 건너뛰므로(`tauri-action/src/index.ts`: `if (tagName && !releaseId)`) 중복 생성 걱정 없이 안전하다. **`tagName` 을 빼면 안 된다** — draft 릴리스 자산의 URL 은 `/download/untagged-<hash>/` 이고 tauri-action 이 이를 치환할 때 `tagName` 이 없으면 `/latest/download/` 로 폴백한다. 그 URL 은 "가장 최신 릴리스"를 따라다니므로, 파일명에 버전이 없는 macOS 자산은 다음 릴리스가 나오는 순간 다른 버전 파일을 내려받아 minisign 검증이 깨진다(v0.1.13 publish 실패의 원인).
- `publish` 잡은 `latest.json` 의 각 플랫폼 서명이 실제 업로드된 `.sig` 파일과 일치하는지, 그리고 **필수 플랫폼(darwin ×2, windows)이 모두 있는지** 확인한 뒤에야 draft 를 해제한다. 서명만 대조하면 "없는 항목"은 검사 대상이 아니라 그냥 통과해 버린다. draft 릴리스는 `/releases/latest/download/` 로 노출되지 않으므로, 검증에 실패한 아티팩트는 업데이터에 도달하지 않는다.
  - 워크플로에는 `concurrency`(그룹 `release-<ref>`, 취소 안 함)를 걸어 같은 태그의 중복 실행을 순차화한다. 병렬 실행 시 두 실행의 산출물이 섞여 `latest.json` 의 서명과 실제 자산이 어긋난다(v0.1.8 macOS 업데이트 실패의 원인). 태그를 다시 푸시할 때는 앞선 실행이 끝난 뒤에 하는 것이 안전하다.
  - macOS 업데이터 자산 `DB.Studio_universal.app.tar.gz` 는 **파일명에 버전이 없어** 재실행 시 조용히 덮어써진다. 위 두 장치가 이 덮어쓰기로 인한 서명 불일치를 막는 안전장치다.
- **자동 업데이트**: 앱은 시작 시 `plugins.updater.endpoints`(GitHub Releases의 `latest.json`)를 확인한다. 새 버전이 있으면 상태바에 업데이트 버튼을 띄우고, `downloadAndInstall` → `relaunch` 로 교체한다.
  - 업데이트 무결성은 **minisign** 서명으로 검증한다: 공개키는 `tauri.conf.json`(`plugins.updater.pubkey`), 개인키는 CI 시크릿(`TAURI_SIGNING_PRIVATE_KEY` + `..._PASSWORD`). OS 코드서명과는 별개.
  - 프론트: `src/lib/updater.ts`(check/install 래퍼) + `src/store/updateStore.ts`(상태) + `StatusBar` UI. 백엔드: `tauri-plugin-updater` + `tauri-plugin-process`(재시작), 데스크톱 한정 등록.
- 사내 배포이므로 OS 코드서명/공증은 하지 않음. 미서명 시 첫 실행에서 macOS Gatekeeper·Windows SmartScreen 경고가 뜰 수 있음을 안내한다.
- `tiberius`/`sqlx`의 TLS는 `rustls` 기반으로 벤더링해 OS별 네이티브 TLS 의존성을 줄인다.
