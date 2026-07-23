# CODE_STYLE

## 1. 공통

- 언어/주석: 코드 식별자는 영어, 설명 주석은 한국어 허용. 주석은 "왜"를 남기고 "무엇"의 중복 서술은 피한다.
- 포맷터가 진실: Rust는 `cargo fmt`, 프론트는 Prettier 기본(2 스페이스). 수동 정렬로 다투지 않는다.
- 죽은 코드·미사용 import 남기지 않는다(`noUnusedLocals`, clippy 경고 0 목표).

## 2. Rust (`src-tauri/`)

### 네이밍
- 모듈/파일: `snake_case` (`db/postgres.rs`, `commands/data.rs`).
- 타입/트레이트/enum: `PascalCase` (`Driver`, `QueryResult`, `DbKind`, `AppError`).
- 함수/변수: `snake_case`. Tauri command 함수도 `snake_case` (`fetch_table_page`) — 프론트에서 동일 이름으로 invoke.
- serde 필드: Rust는 `snake_case`, 프론트로는 **`#[serde(rename_all = "camelCase")]`** 로 내보내 TS 컨벤션과 맞춘다. (경계 타입 전부 적용, 일관성 필수)

### 패턴
- command 시그니처 예:
  ```rust
  #[tauri::command]
  async fn fetch_table_page(
      state: tauri::State<'_, AppState>,
      req: FetchPageRequest,
  ) -> Result<QueryResult> { ... }
  ```
- 오류: `thiserror`로 `AppError` 정의, `Result<T> = std::result::Result<T, AppError>`. 함수는 `?`로 전파. `unwrap/expect` 금지(테스트 제외).
- 비동기: 모든 DB 접근 command는 `async fn`. 블로킹 라이브러리 사용 시 `tokio::task::spawn_blocking`으로 감싼다.
- 트레이트 객체: `Driver`는 `#[async_trait]` + `Send + Sync`. 디스패치는 `DbConnection` enum match(정적 디스패치 선호), 동적 필요 시 `Box<dyn Driver>`.
- SQL 식별자 quoting은 드라이버별 `quote_ident`로만. 인라인 문자열 조립 금지.

### 금지
- command 안에 SQL 생성·타입 매핑 로직 직접 작성(→ `db/`로).
- 값 변환을 드라이버마다 복붙(→ `value.rs` 공용).
- 자격증명을 로그/에러/파일에 노출.

## 3. TypeScript / React (`src/`)

### 네이밍
- 컴포넌트 파일·컴포넌트: `PascalCase` (`ConnectionDialog.tsx`, `DataGrid.tsx`).
- 훅: `useXxx` (`useActiveConnection`). 스토어: `xxxStore.ts` + `useXxxStore`.
- 일반 모듈/유틸: `camelCase.ts`. 타입: `PascalCase`.
- API 래퍼 함수: command와 대응하는 `camelCase` (`fetchTablePage`).

### 패턴
- 함수형 컴포넌트 + 훅. 클래스 컴포넌트 금지.
- 상태는 zustand 스토어에. 컴포넌트 로컬 UI 상태만 `useState`.
- **부작용/IPC는 컴포넌트에서 직접 `invoke` 하지 않는다.** 항상 `api/` 래퍼 경유 → 스토어 액션에서 호출.
- 타입 우선: `any` 금지(`unknown` 후 좁히기). IPC 반환은 `types/`의 명시 타입으로 단언 아닌 검증.
- 스타일: CSS Modules 또는 전역 CSS + 테마 토큰(`styles/theme.css`의 CSS 변수). 인라인 스타일은 동적 값에 한정.
- 접근성·키보드: 그리드/트리는 키보드 내비게이션 고려(Enter/Tab/방향키).

### 금지
- `features` 간 직접 import(공유는 `components/`·`store/`로 승격).
- IPC 반환을 타입 없이 사용하거나 `as any`로 뭉개기.
- 매직 문자열 command 이름 남발(→ `api/`에 상수/함수로 캡슐화).

## 4. 파일 배치 규칙

- 새 기능은 `features/<name>/` 아래 컴포넌트+로컬훅+스타일을 모은다.
- 여러 기능이 공유하면 `components/`(UI) 또는 `store/`(상태) 또는 `lib/`(순수 유틸)로 승격.
- 백엔드 새 command 영역은 `commands/<area>.rs`로 분리하고 `commands/mod.rs`에서 재노출.

## 5. 테스트 스타일

- Rust: `db/` 매핑·quoting 등 순수 로직은 `#[cfg(test)] mod tests`로 유닛 테스트. SQLite는 서버 불필요 → 통합 테스트에 적극 활용(임시 파일/인메모리 DB).
- 프론트: 순수 유틸/스토어 로직 위주로 테스트(그리드 diff 계산 등). E2E는 MVP 이후.
- 외부 DB 서버가 필요한 테스트는 기본 CI에서 제외하고 `#[ignore]` 또는 feature 게이트.
