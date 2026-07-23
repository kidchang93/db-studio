//! SSH 터널(bastion 경유). OS `ssh` 클라이언트로 로컬 포트포워딩한다.
//!
//! 무거운 Rust SSH 스택 대신 OS `ssh` 를 사용해 known_hosts·ssh-agent·config 등
//! 성숙한 기능을 그대로 활용한다. 인증은 **키 기반**(에이전트/키파일)만 지원한다
//! (`BatchMode=yes` 로 비밀번호 프롬프트를 막아 CI/헤드리스에서도 안전).

use crate::error::{AppError, Result};
use crate::models::SshConfig;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

/// 살아 있는 SSH 터널. Drop 시 자식 프로세스를 종료한다.
pub struct SshTunnel {
    child: Child,
    local_port: u16,
}

impl SshTunnel {
    /// bastion 을 거쳐 `remote_host:remote_port` 로 가는 로컬 포워드를 연다.
    pub async fn open(ssh: &SshConfig, remote_host: &str, remote_port: u16) -> Result<Self> {
        let local_port = free_local_port()?;
        let ssh_port = ssh.port.unwrap_or(22);
        let target = format!("{}@{}", ssh.user, ssh.host);
        let forward = format!("127.0.0.1:{local_port}:{remote_host}:{remote_port}");

        let mut cmd = Command::new("ssh");
        cmd.arg("-N") // 원격 명령 없이 포워딩만
            .args(["-o", "ExitOnForwardFailure=yes"])
            .args(["-o", "StrictHostKeyChecking=accept-new"])
            .args(["-o", "BatchMode=yes"]) // 비밀번호 프롬프트 금지(키 전용)
            .args(["-o", "ConnectTimeout=10"])
            .args(["-o", "ServerAliveInterval=30"])
            .args(["-L", &forward])
            .args(["-p", &ssh_port.to_string()]);
        if let Some(key) = &ssh.key_path {
            if !key.is_empty() {
                cmd.args(["-i", key]);
            }
        }
        cmd.arg(&target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let child = cmd.spawn().map_err(|e| {
            AppError::Connection(format!("ssh 실행 실패(OS ssh 클라이언트 설치 확인): {e}"))
        })?;
        let mut tunnel = SshTunnel { child, local_port };

        // 로컬 포트가 열릴 때까지 최대 ~10초 대기.
        for _ in 0..50 {
            if let Ok(Some(status)) = tunnel.child.try_wait() {
                return Err(AppError::Connection(format!(
                    "SSH 터널이 종료됨(코드 {status}). 호스트/사용자/키 권한을 확인하세요."
                )));
            }
            if tokio::net::TcpStream::connect(("127.0.0.1", local_port))
                .await
                .is_ok()
            {
                return Ok(tunnel);
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        Err(AppError::Connection("SSH 터널 준비 시간 초과".into()))
    }

    pub fn local_port(&self) -> u16 {
        self.local_port
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
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
