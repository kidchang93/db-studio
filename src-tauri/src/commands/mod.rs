//! Tauri command 계층.
//!
//! command 는 얇게 유지한다 — 인자 검증 · state 조회 · 드라이버 위임 · DTO 매핑만.
//! SQL 생성/타입 매핑 등 비즈니스 로직은 `db/` 에 둔다.

pub mod connection;
pub mod data;
pub mod metadata;
pub mod query;
