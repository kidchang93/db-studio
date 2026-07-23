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
- 그리드 CRUD가 생성하는 `UPDATE/DELETE`는 **PK(또는 유니크 키) 기반 WHERE**만 사용. PK가 없는 테이블은 편집을 막고 안내(전체행 매칭 위험 회피).
- 사용자가 직접 작성한 SQL 에디터 쿼리는 그대로 실행하되(신뢰 경계는 사용자 자신), 다중 문장·DDL 실행 시 확인 단계를 둔다.

## 6. CRUD 편집 모델 (그리드)

- 그리드는 서버(DB) 데이터의 스냅샷 + **pending 변경 세트**를 분리 보관한다.
- 변경 종류: `insert`(신규 행), `update`(셀 단위 diff, 행 PK로 식별), `delete`(PK로 식별).
- 편집 중인 셀은 시각적으로 표시(더티 마커). 커밋 전까지 DB 미반영.
- **커밋**: `apply_changes`가 하나의 트랜잭션에서 delete→update→insert 순으로 실행, 실패 시 전체 롤백.
- **되돌리기**: 커밋 전 pending은 로컬에서 취소 가능. 커밋 후 되돌리기는 범위 밖.
- PK 없는 테이블: 읽기 전용 그리드로 표시하고 편집 UI 비활성 + 사유 안내.

## 7. 오류 처리

- 백엔드: `AppError`(thiserror)로 종류 구분(`Connection`, `Query`, `Mapping`, `NotFound`, `Validation`, `Internal`). serde 직렬화해 `{ kind, message, detail? }`로 프론트 전달.
- 프론트: `api/` 래퍼가 reject를 정규화 → 스토어에 저장 → 상태바/토스트로 표시. DB 오류 메시지(SQLSTATE 등)는 원문을 detail에 보존해 디버깅 지원.
- command 경로에 `unwrap()/expect()` 금지. 모든 실패는 `?`로 `AppError`에 매핑.

## 8. UX 설계 지침 (DataGrip 벤치마크)

| 영역 | 지침 |
|------|------|
| 레이아웃 | 좌: 스키마 트리 / 중앙: 탭(그리드·에디터) / 하단: 상태·로그. 패널 리사이즈 가능 |
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

<!-- TODO: 확인 필요 — 쿼리 히스토리/북마크, 결과 export(CSV/JSON), 다크·라이트 테마 토글은 MVP 이후 로드맵. -->
