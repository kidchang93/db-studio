# SUBAGENTS

이 레포에서 서브에이전트(Agent 도구 / Workflow)를 운영하는 방식.

## 1. 역할 분담

| 역할 | 에이전트 | 용도 |
|------|----------|------|
| 탐색 | `Explore` | 코드/설정 위치 파악, 크레이트·라이브러리 현재 API 조사(읽기 전용) |
| 조사 | `general-purpose` | 외부 문서(docs.rs/npm) 버전·API 검증, 여러 파일 교차 조사 |
| 구현 | `general-purpose` | 잘 정의된 독립 컴포넌트 구현(드라이버 하나, 기능 폴더 하나) |
| 리뷰 | `Explore`/`general-purpose` | `docs/REVIEW.md` 기준 자가 리뷰 |

## 2. 병렬화 판단

**병렬화 안전 (독립적, 인터페이스 확정 후):**
- `db/` 드라이버 구현 — `Driver` 트레이트·`models.rs`·`value.rs` 인터페이스가 확정된 뒤라면 postgres/mysql/sqlite/mssql 각각을 병렬로 구현 가능.
- `features/` 폴더별 UI — `types/`·`api/`·`store/` 계약이 확정된 뒤라면 explorer/grid/query를 병렬 구현 가능.
- 문서 조사(여러 라이브러리 버전 확인)는 병렬로.

**순차 필수 (공유 계약 변경):**
- `Driver` 트레이트, `models.rs`, `error.rs`, `value.rs`, `state.rs` 변경 — 모든 드라이버·command가 의존하므로 먼저 확정 후 전파.
- `types/`·`api/` 계약 변경 — 프론트 전 기능이 의존.
- `lib.rs` command 등록은 통합 지점 — 병렬 구현 후 한 곳에서 병합.

**원칙: 공유 인터페이스(트레이트·DTO·API 계약)를 먼저 단독으로 확정하고, 그 위의 구현만 팬아웃한다.**

## 3. 서브에이전트 프롬프트 필수 컨텍스트

모든 파생 에이전트 프롬프트에 반드시 포함:
1. 레포 루트 `CLAUDE.md` 경로와 핵심 제약(SQL 안전성, 타입 계약 동기화, 비밀번호 keyring).
2. 작업과 관련된 docs 경로:
   - 드라이버 작업 → `docs/ARCHITECTURE.md`(§4 Driver), `docs/DESIGN.md`(§3~5).
   - 프론트 기능 → `docs/DESIGN.md`(§2 IPC, §6 CRUD, §8 UX), `docs/CODE_STYLE.md`(§3).
3. 확정된 인터페이스 파일 경로(`db/mod.rs`, `models.rs`, `src/types/`, `src/api/`)와 "이 계약을 바꾸지 말 것" 명시.
4. 완료 기준: `docs/REVIEW.md`의 게이트 명령(`cargo check`/`clippy`, `npm run build`) 통과.

## 4. 결과물 검수

- 파생 에이전트 산출물은 병합 전 `docs/CODE_STYLE.md`·`docs/REVIEW.md` 기준으로 검수한다.
- 특히 확인: serde `camelCase` 경계, command 얇음 유지, `features` 간 직접 import 없음, `unwrap/any` 없음.
- 여러 에이전트가 만든 코드를 병합한 뒤 반드시 통합 지점(`lib.rs` 핸들러 등록, `api/` 래퍼, 타입 동기화)을 한 번에 점검하고 게이트 명령을 재실행한다.

## 5. Workflow 사용

- Workflow(다중 에이전트 오케스트레이션)는 사용자가 명시적으로 요청("워크플로우 돌려줘", ultracode 등)한 경우에만 사용한다.
- 사용 시에도 위 §3 컨텍스트 전파와 §4 검수 기준을 각 단계 프롬프트에 반영한다.
