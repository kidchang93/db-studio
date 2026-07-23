# REVIEW

머지 전 자가 점검 체크리스트. 항목이 하나라도 어긋나면 머지하지 않는다.

## 1. 머지 전 필수 통과 (게이트)

| 검사 | 명령어 | 기준 |
|------|--------|------|
| Rust 컴파일 | `cd src-tauri && cargo check` | 에러 0 |
| Rust 린트 | `cd src-tauri && cargo clippy --all-targets` | 경고 0(불가피하면 `#[allow]` + 사유 주석) |
| Rust 포맷 | `cd src-tauri && cargo fmt --check` | 변경 없음 |
| Rust 테스트 | `cd src-tauri && cargo test` | 통과(외부 DB 필요 테스트는 `#[ignore]`) |
| 프론트 빌드 | `npm run build` | `tsc` 타입에러 0 + 번들 성공 |

## 2. Correctness

- [ ] IPC 타입이 Rust `models.rs` ↔ TS `types/`에서 1:1 대응하는가(필드명·옵셔널·enum 값)?
- [ ] 새/변경 command가 `lib.rs` `generate_handler!`와 `api/` 래퍼 양쪽에 반영됐는가?
- [ ] DB 값 변환이 `value.rs`를 경유하며 정밀도 손실 위험 타입을 문자열로 보존하는가?
- [ ] 그리드 CRUD의 `UPDATE/DELETE`가 PK/유니크 기반 WHERE만 쓰는가? PK 없는 테이블을 안전하게(읽기전용) 처리하는가?
- [ ] `apply_changes`가 트랜잭션으로 감싸지고 실패 시 롤백되는가?
- [ ] 지연 로딩 경계(스키마 트리)가 지켜지는가(전체 트리 일괄 로드 아님)?

## 3. 보안

- [ ] 사용자 값이 파라미터 바인딩으로 전달되는가(문자열 이어붙이기 없음)?
- [ ] 식별자가 드라이버별 `quote_ident`로 quoting 되는가?
- [ ] 비밀번호가 keyring에만 저장되고 JSON/로그/에러에 노출되지 않는가?
- [ ] 오류 메시지·로그에 자격증명·연결문자열 평문이 없는가?

## 4. 스타일 / 구조

- [ ] command가 얇은가(SQL/매핑 로직이 `db/`에 있는가)?
- [ ] `features` 간 직접 import가 없는가?
- [ ] 컴포넌트가 `invoke`를 직접 부르지 않고 `api/`→store 경유하는가?
- [ ] `any`/`as any`/`unwrap`(비테스트)이 없는가?
- [ ] 네이밍이 `docs/CODE_STYLE.md`를 따르는가?

## 5. 문서 동기화

- [ ] 아키텍처·설계·컨벤션이 바뀌었으면 해당 `docs/*`를 같은 PR에서 갱신했는가?
- [ ] 새 DB 종류/새 command 추가 시 관련 문서 절차(§DESIGN)를 따랐는가?

## 6. 흔한 실수 (리뷰 시 먼저 의심할 것)

- serde `rename_all = "camelCase"` 누락 → 프론트에서 `snake_case` 필드 undefined.
- Tauri command 인자를 프론트에서 잘못된 키로 전달(래퍼 함수로 캡슐화해 방지).
- SQLite 외 DB 테스트를 서버 없이 실행하려다 실패 → `#[ignore]`/feature 게이트 확인.
- 그리드에서 편집 즉시 커밋(자동저장) 구현 → 설계 위반. pending 세트 경유 필수.
- 대형 결과셋을 통째로 프론트에 전송 → 페이지네이션/행수 제한 확인.
- `number`로 내린 `BIGINT`/`NUMERIC` 정밀도 손실 → 문자열 보존 확인.
