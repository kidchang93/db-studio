//! SSH 터널(bastion 경유). OS `ssh` 클라이언트로 로컬 포트포워딩한다.
//!
//! 무거운 Rust SSH 스택 대신 OS `ssh` 를 사용해 known_hosts·ssh-agent·config 등
//! 성숙한 기능을 그대로 활용한다. 인증은 **키 기반**(에이전트/키파일)만 지원한다
//! (`BatchMode=yes` 로 비밀번호 프롬프트를 막아 CI/헤드리스에서도 안전).

use crate::error::{AppError, Result};
use crate::models::SshConfig;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};

/// 살아 있는 SSH 터널. 값이 drop 되면 ssh 프로세스도 종료된다(`kill_on_drop`).
pub struct SshTunnel {
    _child: Child,
    local_port: u16,
}

impl SshTunnel {
    /// bastion 을 거쳐 `remote_host:remote_port` 로 가는 로컬 포워드를 연다.
    pub async fn open(ssh: &SshConfig, remote_host: &str, remote_port: u16) -> Result<Self> {
        let local_port = free_local_port()?;

        let mut cmd = Command::new("ssh");
        cmd.args(ssh_args(ssh, local_port, remote_host, remote_port))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            // 실패 원인(Permission denied·bad permissions 등)을 오류로 돌려주려고 받아 둔다.
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // GUI 앱이 콘솔 프로그램을 띄우면 Windows 는 콘솔 창을 새로 연다.
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

        let mut child = cmd.spawn().map_err(|e| {
            AppError::Connection(format!("ssh 실행 실패(OS ssh 클라이언트 설치 확인): {e}"))
        })?;

        // 로컬 포트가 열릴 때까지 최대 ~10초 대기. ssh 는 인증이 끝난 뒤에야 포트를 연다.
        for _ in 0..50 {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(AppError::Connection(exit_message(&mut child, status).await));
            }
            if tokio::net::TcpStream::connect(("127.0.0.1", local_port))
                .await
                .is_ok()
            {
                return Ok(SshTunnel {
                    _child: child,
                    local_port,
                });
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        Err(AppError::Connection("SSH 터널 준비 시간 초과".into()))
    }

    pub fn local_port(&self) -> u16 {
        self.local_port
    }
}

fn ssh_args(ssh: &SshConfig, local_port: u16, remote_host: &str, remote_port: u16) -> Vec<String> {
    let mut args: Vec<String> = [
        "-N", // 원격 명령 없이 포워딩만
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "BatchMode=yes", // 비밀번호 프롬프트 금지(키 전용)
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=30",
        "-L",
    ]
    .map(String::from)
    .to_vec();
    args.push(format!(
        "127.0.0.1:{local_port}:{remote_host}:{remote_port}"
    ));
    // 포트·키·사용자를 비우면 넘기지 않는다 — ~/.ssh/config 의 Host 별칭 설정을 덮지 않도록.
    if let Some(port) = ssh.port {
        args.extend(["-p".into(), port.to_string()]);
    }
    if let Some(key) = ssh.key_path.as_deref().filter(|k| !k.is_empty()) {
        args.extend(["-i".into(), key.into()]);
    }
    args.push(match ssh.user.as_deref().filter(|u| !u.is_empty()) {
        Some(user) => format!("{user}@{}", ssh.host),
        None => ssh.host.clone(),
    });
    args
}

/// 종료된 ssh 의 stderr 를 오류 문구로 만든다.
async fn exit_message(child: &mut Child, status: ExitStatus) -> String {
    let mut buf = Vec::new();
    if let Some(mut stderr) = child.stderr.take() {
        // ProxyCommand 같은 자식이 파이프를 쥐고 있으면 EOF 가 오지 않는다.
        let _ = tokio::time::timeout(Duration::from_secs(1), stderr.read_to_end(&mut buf)).await;
    }
    let detail = String::from_utf8_lossy(&buf);
    let detail = detail.trim();
    if detail.is_empty() {
        format!("SSH 터널이 종료됨({status}). 호스트/사용자/키 권한을 확인하세요.")
    } else {
        format!("SSH 터널 실패: {detail}")
    }
}

/// 사용 가능한 로컬 포트를 하나 확보한다(바인딩 후 즉시 해제 → ssh 에 전달).
fn free_local_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| AppError::Connection(format!("로컬 포트 할당 실패: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::Internal(e.to_string()))?
        .port();
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(host: &str, port: Option<u16>, user: Option<&str>, key: Option<&str>) -> SshConfig {
        SshConfig {
            host: host.into(),
            port,
            user: user.map(Into::into),
            key_path: key.map(Into::into),
        }
    }

    #[test]
    fn explicit_fields_become_flags_and_destination() {
        let args = ssh_args(
            &cfg("15.165.77.96", Some(22), Some("ubuntu"), Some("~/k.pem")),
            5000,
            "127.0.0.1",
            5432,
        );
        assert!(args.contains(&"127.0.0.1:5000:127.0.0.1:5432".to_string()));
        assert!(args.ends_with(&[
            "-p".into(),
            "22".into(),
            "-i".into(),
            "~/k.pem".into(),
            "ubuntu@15.165.77.96".into()
        ]));
    }

    #[test]
    fn config_alias_leaves_port_key_user_to_ssh_config() {
        let args = ssh_args(
            &cfg("kcal-prod-db", None, Some(""), Some("")),
            5000,
            "db",
            5432,
        );
        assert_eq!(args.last().map(String::as_str), Some("kcal-prod-db"));
        assert!(!args.iter().any(|a| a == "-p" || a == "-i"));
    }
}
