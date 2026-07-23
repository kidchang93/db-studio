//! 연결 프로필 영속화.
//!
//! 프로필(비밀번호 제외)은 앱 config 디렉토리의 `profiles.json` 에 저장하고,
//! 비밀번호는 OS 키체인(`keyring`)에 별도 저장한다.

use crate::error::Result;
use crate::models::ConnectionProfile;
use std::path::{Path, PathBuf};

const KEYRING_SERVICE: &str = "DB Studio";

pub struct ProfileStore {
    file: PathBuf,
}

impl ProfileStore {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            file: config_dir.join("profiles.json"),
        }
    }

    pub fn load(&self) -> Result<Vec<ConnectionProfile>> {
        if !self.file.exists() {
            return Ok(Vec::new());
        }
        let data = std::fs::read(&self.file)?;
        Ok(serde_json::from_slice(&data)?)
    }

    pub fn save(&self, profiles: &[ConnectionProfile]) -> Result<()> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&self.file, serde_json::to_vec_pretty(profiles)?)?;
        Ok(())
    }

    /// 프로필을 upsert 한다(id 일치 시 교체, 아니면 추가).
    pub fn upsert(&self, profile: ConnectionProfile) -> Result<()> {
        let mut list = self.load()?;
        if let Some(existing) = list.iter_mut().find(|p| p.id == profile.id) {
            *existing = profile;
        } else {
            list.push(profile);
        }
        self.save(&list)
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        let mut list = self.load()?;
        list.retain(|p| p.id != id);
        self.save(&list)?;
        let _ = delete_password(id);
        Ok(())
    }
}

// ---- 비밀번호(키체인) ----

pub fn set_password(profile_id: &str, password: &str) -> Result<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, profile_id)?;
    entry.set_password(password)?;
    Ok(())
}

pub fn get_password(profile_id: &str) -> Result<Option<String>> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, profile_id)?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_password(profile_id: &str) -> Result<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, profile_id)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
