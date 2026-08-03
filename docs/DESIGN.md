# DESIGN

설계 원칙과 주요 결정. 새 기능은 여기 규칙을 따른다.

## 1. 설계 원칙

1. **DB 차이를 한 곳(`db/`)에 가둔다.** 위 계층은 `Driver` 트레이트와 균일한 `QueryResult`만 본다. `commands/`·프론트에 DB 분기(`if kind == Postgres`)를 흘리지 않는다.
2. **얇은 command, 두꺼운 driver.** command는 검증·state조회·DTO매핑만. SQL 생성/타입 매핑은 driver가 책임.
3. **명시적 커밋.** 파괴적 작업(행 삭제, 다중 UPDATE, DDL)은 사용자의 명시적 확인·커밋을 거친다. 그리드 편집은 자동 저장하지 않는다.
4. **타입 계약 동기화.** IPC 경계 타입은 Rust `models.rs` ↔ TS `types/`가 항상 1:1.
5. **직관성 우선(UX).** DataGrip을 벤치마크로, 흔한 작업(테이블 열기·편집·필터·정렬)은 최소 클릭으로. 위험 작업은 확인 단계로.

## 2. IPC 계약 (command ↔ api)

- command 하나당 프론트 `api/` 함수 하나. 이름을 맞춘다: 예) command `fetch_table_page` ↔ `api.fetchTablePage`.
- 인자는 객체 하나(`serde` 구조체)로 받는다. 위치 인자 나열 대신 명명 필드.
- 반환은 `Result<T, AppError>`. 프론트 `api/` 래퍼가 reject를 잡아 `AppError` 형태로 정규화한다.
- 새 command 추가 절차:
  1. `models.rs`에 요청/응답 타입 정의 → `types/`에 대응 TS 타입 추가.
  2. `commands/<영역>.rs`에 `#[tauri::command] async fn` 작성, `lib.rs`의 `generate_handler!`에 등록.
  3. `api/`에 래퍼 함수 추가.

## 3. `Driver` 트레이트 설계 규칙

- 모든 메서드는 `async`. 반환은 `crate::error::Result<T>`.
- 스키마 조회는 **지연 로딩** 단위로 분리(databases → schemas → tables → columns). 한 번에 전체 트리를 끌어오지 않는다(대형 DB 대비).
- 결과 셀은 `value.rs`를 통해서만 `serde_json::Value`로 변환한다. 드라이버별 변환 로직 중복 금지 — 공통 매핑은 `value.rs`에 모은다.
- **새 DB 추가 절차**: `db/<name>.rs`에서 `Driver` 구현 → `DbConnection` enum에 variant 추가 → 팩토리(`db/mod.rs`)에서 `DbKind`로 분기 → `models.rs::DbKind`에 종류 추가 → 프론트 연결 폼에 종류 추가.

## 4. 값·타입 매핑 (`value.rs`)

- DB 네이티브 타입을 **논리 타입** 집합으로 정규화: `null · bool · int · float · decimal · string · bytes · date · time · datetime · json · uuid · array`.
- 프론트로는 `serde_json::Value`로 보내되, 컬럼 메타에 원본 DB 타입명(`db_type`)과 논리 타입(`logical_type`)을 함께 실어 그리드 렌더링·편집기 선택에 사용.
- 정밀도 손실 위험(`NUMERIC`, `BIGINT`, `bytea`, `uuid`, 시간대)은 **문자열로 보존**하는 것을 기본으로 한다. JS `number`로 내려 정밀도를 잃지 않는다.

## 5. SQL 안전성 (필수)

- **값**은 항상 드라이버 파라미터 바인딩(`$1`/`?`)으로 전달. 문자열 이어붙이기 금지.
- **식별자**(테이블/컬럼/스키마명)는 값 바인딩이 불가하므로 DB별 규칙으로 quoting: Postgres/SQLite `"ident"`, MySQL `` `ident` ``, SQL Server `[ident]`. 내부 따옴표는 이스케이프. 이 로직은 driver별 `quote_ident`로 캡슐화.
- 그리드 CRUD의 `UPDATE/DELETE`는 **행을 하나로 특정하는 WHERE**만 쓴다. 기본 키가 있으면 그 컬럼을, 없으면 **모든 컬럼의 원본 값**을 조건으로 쓴다(바이너리 컬럼은 `=` 비교를 DB가 거부하거나 부정확해 제외).
  - 값으로 찾는 쪽은 행이 유일하다는 보장이 없다. 그래서 실행 후 **영향 행 수가 정확히 1인지 확인**하고, 아니면 트랜잭션째 취소한다(`db/sql.rs` 의 `ensure_single_row`). 0행이면 보고 있던 행이 그사이 바뀐 것이라 조용히 넘기지 않고 알린다.
  - **이 검사가 되돌릴 수 없는 다중 변경을 막는 유일한 방어선이다.** 드라이버를 추가하거나 `apply_changes` 를 고칠 때 빠뜨리면 안 된다. sqlx 계열은 `?` 로 빠져나가면 트랜잭션이 drop 되며 롤백되지만, SQL Server 는 트랜잭션을 직접 몰기 때문에 `ROLLBACK` 을 손으로 보내야 한다.
  - 회귀 테스트: `db/sqlite.rs` 의 `edit_without_primary_key`(서버 불필요).
- 사용자가 직접 작성한 SQL 에디터 쿼리는 그대로 실행하되(신뢰 경계는 사용자 자신), 다중 문장·DDL 실행 시 확인 단계를 둔다.
- **SQL Server 에서 `N` 접두사가 빠진 비ASCII 리터럴로 쓰기를 실행하려 하면 먼저 확인받는다**(`src/lib/sqlText.ts` 의 `scanSqlText` → `QueryTab` 의 확인 대화상자). `'영업부'` 는 **DB 기본 collation 의 코드페이지**로 해석되어, 그 코드페이지에 한글이 없으면 서버에 닿기도 전에 `?`(0x3F)로 바뀐다. **컬럼이 NVARCHAR 여도 리터럴 단계에서 이미 죽으므로** 컬럼 타입으로는 막을 수 없다. 원문이 남지 않아 되돌릴 수 없다.
  - 스마트 인용부호와 달리 **자동으로 고치지 않는다** — 임의로 `N` 을 붙이면 사용자가 의도한 비유니코드 비교/저장을 바꿔 버릴 수 있다. 실행 여부는 사용자가 정한다.
  - **쓰기(INSERT·UPDATE·MERGE)만 막고 조회는 묻지 않는다.** 조회는 리터럴이 깨져도 결과가 안 맞는 것이 즉시 드러나고 손실이 없다. 매 조회마다 묻는 편이 더 해롭다.
  - 그리드 인라인 편집은 **파라미터 바인딩**으로 나가므로(`ColumnData::String` → NVARCHAR) 이 문제가 없다. 위험한 것은 사용자가 콘솔에 직접 쓴 SQL 뿐이다.
  - 회귀 테스트: `src-tauri/src/db/mssql.rs` 의 `korean_text_by_collation_and_n_prefix`.
- 사용자가 SQL을 입력하는 곳(SQL 에디터, 그리드 WHERE 필터 바)은 **입력 시점에 스마트 인용부호를 ASCII 따옴표로 정규화**한다(`src/lib/sqlText.ts`의 `normalizeSmartQuotes`). macOS 가 `'` 를 `‘`(U+2018)로 자동 변환하면 DB 가 문자열 구분자로 인식하지 못해 구문 오류가 난다(SQL Server 102). 입력창 값 자체를 바꾸므로 사용자도 화면에서 정규화 결과를 확인할 수 있다.

## 6. CRUD 편집 모델 (그리드)

- 그리드는 서버(DB) 데이터의 스냅샷 + **pending 변경 세트**를 분리 보관한다.
- 변경 종류: `insert`(신규 행), `update`(셀 단위 diff, 행 PK로 식별), `delete`(PK로 식별).
- 편집 중인 셀은 시각적으로 표시(더티 마커). 커밋 전까지 DB 미반영.
- **커밋**: `apply_changes`가 하나의 트랜잭션에서 delete→update→insert 순으로 실행, 실패 시 전체 롤백.
- **되돌리기**: 커밋 전 pending은 로컬에서 취소 가능. 커밋 후 되돌리기는 범위 밖.
- PK 없는 테이블도 편집할 수 있다. 대신 값으로 행을 찾는다는 사실과 그 한계(값이 완전히 같은 행이 여럿이면 커밋이 통째로 취소됨)를 그리드 상단에 상시 안내하고, 구조 뷰에서 기본 키를 지정하도록 유도한다.

### 테이블 구조 변경 (Table Modify)

PK 가 없으면 값 조합으로 행을 찾아야 해 편집이 제약되므로(§5), **구조 뷰에서 기본 키를 지정**할 수 있다.

- **2단계 계약**: `plan_primary_key`(계획·검증, 실행 안 함) → 사용자 확인 → `apply_primary_key`(재검증 후 실행). `ALTER TABLE` 은 되돌릴 수 없으므로 실행될 SQL 을 그대로 보여준 뒤에만 적용한다.
- **사전 검증을 서버에서 한다**: 대상 컬럼의 NULL 건수와 값 조합 중복을 실제 데이터로 세어 `blockers` 에 담는다. DB 가 뱉는 제약 위반 오류보다 먼저, 어떤 컬럼이 왜 안 되는지 한국어로 알려주기 위함. `warnings` 는 막지는 않지만 알려야 할 변경(예: NOT NULL 전환).
- **미리보기와 실행 사이에 데이터가 바뀔 수 있으므로** `apply` 는 계획을 다시 세워 `blockers` 가 비었을 때만 DDL 을 실행한다.
- **DB 차이는 `Dialect::pk_style`(`PkStyle`)에 가둔다** — 드라이버나 command 에 분기를 두지 않는다.
  | 방식 | DB | DDL |
  |------|-----|-----|
  | `AddPrimaryKey` | PostgreSQL · MySQL | `ALTER TABLE … ADD PRIMARY KEY (…)` (NULL→NOT NULL 은 DB 가 처리) |
  | `AlterThenConstraint` | SQL Server | nullable 컬럼을 `ALTER COLUMN … NOT NULL` 로 바꾼 뒤 명명 제약 추가 |
  | `Unsupported` | SQLite | 기존 테이블에 PK 추가 불가(테이블 재생성 필요) → `blockers` 로 안내 |
- 검증·DDL 생성 로직은 `Driver` 트레이트의 **기본 구현**으로 두어 드라이버 4곳에 중복되지 않게 한다. 드라이버는 `dialect()` 만 제공한다.

**컬럼 속성 변경**(이름·타입·NULL·기본값)도 같은 2단계 계약을 쓴다(`plan_alter_column` → `apply_alter_column`).

- 변경 요청은 `ColumnChange` 로 표현하며 **지정하지 않은 속성은 유지**된다. 기본값만은 "제거"와 "유지"를 구분해야 해서 `set_default` 플래그를 따로 둔다(`Option<Option<T>>` 회피).
- **이름 변경은 항상 마지막 문장**이다. 앞선 문장들이 아직 옛 이름을 참조하기 때문.
- 사전 검증: NOT NULL 전환 시 NULL 건수, 이름 충돌, PK 컬럼의 NULL 허용 시도를 막는다. 타입 변경은 막지 않고 경고로 알린다(변환 가능 여부는 DB 가 판단).
- DB 차이는 `Dialect::column_alter`(`ColumnAlterStyle`) · `rename_style`(`RenameStyle`)에 가둔다.
  | 방식 | DB | 특징 |
  |------|-----|------|
  | `PerAttribute` | PostgreSQL | 속성마다 개별 문장 |
  | `Redefine` | MySQL | `MODIFY COLUMN` 으로 정의 전체를 다시 쓴다 — 바꾸지 않는 속성도 포함해야 한다 |
  | `AlterColumnAndConstraint` | SQL Server | 타입+NULL 은 한 문장, 기본값은 **명명 제약**이라 기존 것을 떼고 다시 붙인다. 제약 이름은 드라이버가 `default_constraint_name()` 으로 조회해 넘긴다 |
  | `RenameOnly` | SQLite | 이름 변경만 가능 → 나머지는 `blockers` 로 안내 |
  | `RenameColumn` / `SpRename` | 앞 3종 / SQL Server | SQL Server 만 `sp_rename` 이며 식별자가 **문자열 인자**로 들어가므로 작은따옴표를 이스케이프한다 |
- 프론트의 DDL 미리보기(차단 사유·경고·SQL)는 `DdlPlanView` 로 공통화해 기능이 늘어도 같은 형태로 확인받게 한다.

### DDL 보기

구조 뷰에서 테이블의 CREATE 문을 확인할 수 있다.

- **정확한 원문을 주는 DB 는 그대로 쓴다** — MySQL `SHOW CREATE TABLE`, SQLite `sqlite_master.sql`.
- PostgreSQL·SQL Server 는 표준 명령이 없어 **컬럼 메타로 조립한 근사치**를 만든다(`Driver::table_ddl` 기본 구현). 인덱스·외래키가 빠지므로 `TableDdl::exact = false` 로 내려보내고 UI 가 그 사실을 명시한다. **근사치를 원문처럼 보여주지 않는 것이 핵심**이다.

## 6-1. 데이터 내보내기

- 변환은 `src/lib/exportData.ts` 의 **순수 함수**(`formatRows`)로 두어 그리드·쿼리 결과가 같은 로직을 쓴다. 형식: CSV · TSV · JSON · Markdown · SQL INSERT.
- **escape 는 형식별 규칙을 따른다** — CSV 는 RFC 4180(구분자·따옴표·개행이 있으면 감싸고 따옴표는 두 번), SQL 은 작은따옴표 두 번, Markdown 은 파이프와 개행 치환. 여기가 틀리면 내보낸 파일이 조용히 깨지므로 형식 추가 시 반드시 확인한다.
- **NULL 은 빈 값**으로 내보낸다(JSON 만 `null` 유지). `NULL` 이라는 글자가 데이터로 다시 적재되는 것을 막기 위함.
- 파일 저장은 OS 저장 대화상자(`plugin-dialog`)로 경로를 받아 `write_text_file` command 가 쓴다. 임의 경로 쓰기를 열지 않기 위해 **사용자가 직접 고른 경로만** 백엔드로 넘어간다.
- 내보내기 범위는 셀 범위를 잡았으면 그 부분, 아니면 현재 페이지 전체다. 숨긴 컬럼은 제외된다(화면에 보이는 것과 일치시킨다).

## 6-2. 선택 셀 집계

- 그리드에서 두 칸 이상 선택하면 툴바에 집계 값을 보여준다.
- 서버에 다시 묻지 않고 **화면에 보이는 값**(`cellValue`)을 센다. 편집 중인 pending 값이 반영되어야 하고, 페이지 밖은 애초에 선택할 수 없다.
- **숫자로 읽히는 문자열도 센다** — `NUMERIC`·`BIGINT` 는 정밀도 보존 때문에 문자열로 내려오기 때문(§4). boolean 은 일부러 제외한다(true/false 를 1/0 으로 더하면 오해를 부른다).
- 집계 함수는 상태바에서 고른다(합계·평균·최소·최대·개수, 기본 합계) — DataGrip 의 aggregator 위젯과 같은 역할이다.
- 합계는 JS 배정밀도로 계산하므로 안전 정수(2^53-1)를 넘으면 `≈` 를 붙여 **근사임을 밝힌다**. 정확한 집계가 필요하면 SQL 콘솔의 `SUM()` 이 맞는 도구다 — 그리드 집계는 눈으로 확인하는 참고값이다.

## 6-3. SQL 콘솔 실행 경로

- **실행 버튼은 문장 종류를 보고 조회/실행 경로를 자동으로 가른다**(`returnsRows`). DML·DDL 을 조회 경로(`run_query`)로 보내면 결과셋이 없어 빈 표와 "0행 반환"만 남고, 정작 알아야 할 영향 행 수는 실행 경로(`run_execute`)에서만 나온다.
- **실행해 보고 되돌리는 폴백은 쓰지 않는다** — 이미 나간 INSERT 를 다시 보낼 수 없으므로 보내기 전에 첫 키워드로만 판단한다. 애매한 것(`EXEC`·`CALL`)은 조회 쪽에 둔다. 잘못 골라도 데이터는 상하지 않고 영향 행 수를 못 볼 뿐이다.
- 쓰기 결과는 상태바뿐 아니라 **토스트로도** 알린다. 상태바는 화면 맨 아래라 놓치기 쉬운데, 몇 행이 바뀌었는지는 실행 직후 반드시 확인해야 하는 정보다.
- "스크립트 실행" 버튼은 남겨 둔다 — 다중 문장처럼 판단과 무관하게 실행 경로를 강제해야 할 때가 있다.

## 6-3-1. 구문 오류 위치 표시

실행이 실패하면 결과 영역 위에 오류 배너를 띄우고, **DB 가 알려 준 위치를 찾으면 에디터 커서를 그리로 옮긴다**(`findErrorSpot`).

- DB 마다 주는 정보가 달라 있는 것부터 차례로 본다: PostgreSQL 은 **문자 위치**(가장 정확), SQL Server 는 **줄 번호**, MySQL·SQLite 는 위치 없이 `near '토큰'` 뿐이라 그 토큰을 본문에서 찾는다.
- PostgreSQL 의 위치는 오류 메시지가 아니라 **별도 필드**에 있어 `Display` 에 실리지 않는다. `error.rs` 가 `PgDatabaseError::position()` 에서 꺼내 `(위치: N)` 으로 붙인다 — 이걸 안 하면 가장 정확한 정보를 놓친다.
- **못 찾으면 짚지 않는다.** 틀린 자리를 짚으면 사용자가 멀쩡한 곳을 의심하게 되므로, 위치를 확신할 수 없으면 메시지만 보여 준다.

## 6-3-2. SQL 자동완성

- 키워드 완성은 `@codemirror/lang-sql` 이 방언별로 이미 제공한다. **테이블·컬럼 완성은 `schema` 옵션에 `{테이블: [컬럼…]}` 을 넘겨야** 동작한다.
- 그 목록은 `schema_snapshot` command 로 **카탈로그를 한 번에 훑어** 가져온다. `list_columns` 는 테이블당 왕복이 한 번씩이라(테이블 백 개면 IPC 백 번) 자동완성에는 쓸 수 없다.
- 콘솔의 DB·스키마 컨텍스트(§6-3)가 바뀔 때만 다시 받는다. 큰 스키마에서 매번 받으면 콘솔을 열 때마다 멈칫한다.
- **CodeMirror `extensions` 배열은 `useMemo` 로 고정한다.** 매 렌더 새 배열을 주면 에디터가 통째로 재구성되어 커서와 실행 취소 이력이 날아간다.
- 스냅샷을 못 받아도 콘솔은 그대로 쓸 수 있어야 한다 — 자동완성은 있으면 좋은 것이지 실행의 전제가 아니다.
- 회귀 테스트: `db/sqlite.rs` 의 `schema_snapshot_groups_columns`(컬럼이 테이블별로 순서대로 묶이는지).

## 6-4. 로그 패널

상태바 오른쪽 버튼으로 여닫는 하단 패널(`features/layout/LogPanel.tsx` + `store/logStore.ts`).

- **왜 필요한가**: 토스트는 5초 뒤 사라지고 상태바는 마지막 한 줄만 남아, 무슨 일이 있었는지 되짚을 방법이 없었다. 특히 **그리드 커밋은 백엔드가 문장을 만들기 때문에** 사용자가 무엇이 실행됐는지 알 길이 아예 없었다.
- 남기는 것: 조회 · 실행 · 커밋 · 오류. 항목을 클릭하면 실제로 나간 SQL 이 펼쳐진다. 최근 300건만 메모리에 둔다.
- **오류는 `uiStore.toastError` 한 곳에서 기록한다.** 모든 오류가 그 함수를 지나므로 기록 지점을 흩뿌리지 않아도 빠짐없이 남는다.
- **커밋 SQL 은 응답(`ApplyChangesResult::statements`)에 실어 보낸다** — 드라이버가 `AppHandle` 을 들고 이벤트를 쏘게 하면 "`db/` 는 위 계층을 모른다"는 의존성 규칙(`ARCHITECTURE.md` §3)이 깨진다. 타입 계약을 넓히는 쪽이 레이어를 지키는 길이다.
- **값은 담지 않는다.** 파라미터 바인딩이라 문형만 남으며, 이건 로그에 개인정보·자격증명이 새지 않게 하는 조건이기도 하다(§9). 회귀 테스트(`db/sqlite.rs` 의 `crud_roundtrip`)가 값이 섞이지 않는지 확인한다.

## 6-5. 레코드 뷰

커서 행 하나를 오른쪽 사이드 패널에 세로로 펼친다(`⌘/Ctrl+Shift+Enter` — DataGrip 과 같은 키).

- 컬럼이 수십 개인 테이블은 그리드에서 한 행을 읽으려면 가로로 계속 스크롤해야 한다. 여기서는 `컬럼명 · 값`을 위에서 아래로 훑는다. 컬럼·값 검색도 된다.
- **숨긴 컬럼도 보여준다.** 숨김은 그리드 가로폭을 줄이려는 장치이고, 이 패널은 반대로 레코드 전체를 확인하려는 곳이라 목적이 다르다.
- **편집은 그리드에서 한다.** 값을 누르면 그리드의 그 셀로 커서가 옮겨 갈 뿐이다. 편집 UI 를 두 곳에 두면 pending 상태(더티 마커·되돌리기)가 갈라져 어느 쪽이 진짜인지 흐려진다.
- DataGrip 의 **Transpose 와는 다른 기능**이다. Transpose 는 그리드 전체를 전치하는 것이라 행이 200개인 페이지에서는 열이 200개가 되어 가로 스크롤 문제가 그대로 남는다. "컬럼 많은 테이블에서 한 행 보기"에는 레코드 뷰가 맞다.

## 6-6. 관련 레코드 탐색 (F4)

커서 행을 기준으로 외래키를 따라 다른 테이블로 이동한다(DataGrip 의 Related Rows 와 같은 키).

- **양방향이다.** 이 행이 참조하는 부모(`outgoing`)와 이 행을 참조하는 자식(`incoming`)을 함께 모으고, 대상이 여럿이면 고르게 한다.
- `ForeignKeyRef::columns` 는 **방향과 무관하게 언제나 기준 테이블 쪽** 컬럼이다. 들어오는 FK 는 카탈로그가 반대로 주므로 드라이버가 뒤집어 담는다 — 여기가 틀리면 엉뚱한 컬럼으로 필터를 걸어 관계없는 행을 연다. 회귀 테스트로 고정했다(`db/sqlite.rs`·`db/mssql.rs` 의 `relations_both_directions`).
- **조건은 문자열 WHERE 가 아니라 `FilterSpec` 으로 넘긴다.** 그래야 백엔드에서 값 바인딩과 식별자 quoting 을 거친다(§5). 값을 SQL 에 이어 붙이면 이스케이프를 프론트가 떠안고 DB 방언 차이까지 프론트로 새어 나온다.
- 나가는 FK 값이 NULL 이면 부모가 없다는 뜻이라 대상에서 뺀다. 들어오는 쪽은 `IS NULL` 로 건다 — `= NULL` 은 아무것도 걸지 못한다.
- 카탈로그 모양이 DB 마다 달라 `Driver::relations` 에 기본 구현을 두지 않는다. SQLite 는 들어오는 FK 를 알려 주는 카탈로그가 없어 **모든 테이블의 `PRAGMA` 를 훑는다** — 스키마가 크면 그만큼 비용이 든다.

## 7. 오류 처리

- 백엔드: `AppError`(thiserror)로 종류 구분(`Connection`, `Query`, `Mapping`, `NotFound`, `Validation`, `Internal`). serde 직렬화해 `{ kind, message, detail? }`로 프론트 전달.
- 프론트: `api/` 래퍼가 reject를 정규화 → 스토어에 저장 → 상태바/토스트로 표시. DB 오류 메시지(SQLSTATE 등)는 원문을 detail에 보존해 디버깅 지원.
- command 경로에 `unwrap()/expect()` 금지. 모든 실패는 `?`로 `AppError`에 매핑.
- 사용자가 작성한 조건이 섞인 문장(WHERE 필터 바 등)이 실패하면 `AppError::with_sql()`로 **실제 전송된 SQL을 오류에 덧붙인다**. 어떤 문자가 들어갔는지 눈으로 봐야 원인을 알 수 있는 부류(위 스마트 인용부호 등)가 있기 때문. 현재 SQL Server 드라이버의 `fetch_page`에 적용되어 있고, sqlx 계열은 SQL 소유권 구조상 미적용.

## 8. UX 설계 지침 (DataGrip 벤치마크)

| 영역 | 지침 |
|------|------|
| 레이아웃 | 좌: 스키마 트리 / 중앙: 탭(그리드·에디터) / 하단: 상태·로그. 패널 리사이즈 가능 |
| 트리 탐색 | **↑↓ 는 행 단위, ←→ 는 계층 단위**로 나눈다. → 는 닫힌 폴더를 펼치고 이미 열려 있으면 첫 자식으로 내려가며, ← 는 열린 폴더를 접고 아니면 **부모로 점프**한다. ← 가 한 칸씩 위로 가면 테이블이 수백 개인 스키마를 빠져나오는 데 그 횟수만큼 눌러야 한다. 트리 DOM 은 평면(들여쓰기만 `paddingLeft`)이라 부모를 찾을 수 없으므로 각 행이 `data-depth` 를 싣는다 — 새 노드 종류를 추가하면 이 속성을 빠뜨리지 않는다. 검색창 안에서는 ←→ 를 가로채지 않는다(캐럿 이동이 우선) |
| 테이블 열기 | 트리 더블클릭 → 데이터 그리드 탭. 기본 페이지 크기 제한(예 200행) + 페이지네이션 |
| 편집 | 셀 더블클릭/Enter로 인라인 편집, Tab 이동, 신규행은 하단 빈 행, 삭제는 행 선택 후 단축키/버튼 |
| 정렬·필터 | 컬럼 헤더 클릭 정렬, 컬럼별 간단 필터 입력. 서버측 정렬/필터로 위임 |
| 안전장치 | 커밋 전 변경 요약 프리뷰, 삭제·대량변경 확인 다이얼로그 |
| 피드백 | 실행 시간·영향 행수·연결 상태를 상태바에 상시 표시 |

## 9. 보안·프라이버시

- 비밀번호는 OS 키체인(`keyring`)에만 저장. 프로필 JSON·로그·오류 메시지에 비밀번호를 남기지 않는다.
- 연결 문자열/쿼리 로그에 자격증명이 섞이지 않도록 마스킹.
- 사내 도구 전제이나, 원격 텔레메트리·외부 전송은 하지 않는다(전량 로컬).

## 10. 연결 전송 보안 옵션

- **SSL/TLS**(`SslConfig`): 모드(disable~verify-full) + CA/클라이언트 cert/key 경로. PG/MySQL 은 sqlx 옵션으로, MSSQL 은 encrypt/trust(+CA)로 매핑(`db/*.rs::connect`). 인증서는 **파일 경로**만 프로필에 저장(파일 자체는 사용자 디스크에 유지).
- **SSH 터널**(`SshConfig`): OS `ssh` 클라이언트로 로컬 포트포워딩(`db/tunnel.rs`). 키 기반 인증(`BatchMode`), 터널은 `ManagedConnection` 수명에 묶여 disconnect 시 종료. `verify-full` + SSH 동시 사용 시 호스트명 검증이 127.0.0.1 과 충돌할 수 있음(문서화된 한계).
- **자유 파라미터**(`params`): 드라이버가 인식하는 키만 적용(예: PG `application_name`). 미지원 키는 무시.
- 새 전송 옵션 추가 시: `models.rs`(+TS 타입) → 각 드라이버 `connect` 매핑 → `ConnectionDialog` 고급 섹션 UI 순으로 확장.

<!-- 남은 로드맵: FK 탐색, 쿼리 북마크, Transpose(행↔열).
     쿼리 히스토리(⌘E) · 다크/라이트 테마 토글 · 결과 export · 선택 셀 집계는 구현 완료. -->
