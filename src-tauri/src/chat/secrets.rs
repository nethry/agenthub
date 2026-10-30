//! API keys for Chat, kept in the OS credential store (Windows Credential
//! Manager, macOS Keychain, Secret Service on Linux). Keys never reach
//! SQLite, logs, events or the frontend; the UI only gets the last 4
//! characters as a hint.

#[cfg(test)]
use std::collections::HashMap;

#[cfg(test)]
use parking_lot::Mutex;

use super::Provider;

/// A key in memory. `Debug` never prints it.
#[derive(Clone)]
pub struct ApiKey(String);

impl ApiKey {
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn hint(&self) -> String {
        let n = self.0.chars().count();
        self.0.chars().skip(n.saturating_sub(4)).collect()
    }
}

impl std::fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ApiKey(…{})", self.hint())
    }
}

pub trait SecretStore: Send + Sync {
    fn get(&self, provider: Provider) -> Result<Option<ApiKey>, String>;
    fn set(&self, provider: Provider, key: &str) -> Result<(), String>;
    fn delete(&self, provider: Provider) -> Result<(), String>;
}

/// Trims and checks a pasted key. Only shape is checked here; whether the
/// provider accepts it is decided by a real request.
pub fn clean_key(raw: &str) -> Result<String, String> {
    let key = raw.trim();
    if key.is_empty() {
        return Err("Paste an API key first".into());
    }
    if key.len() > 512 || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("That doesn't look like an API key (it has spaces or is too long)".into());
    }
    Ok(key.to_string())
}

const SERVICE: &str = "com.agenthub.desktop";

fn account(provider: Provider) -> String {
    format!("chat-{}-api-key", provider.as_str())
}

pub struct KeyringStore;

impl SecretStore for KeyringStore {
    fn get(&self, provider: Provider) -> Result<Option<ApiKey>, String> {
        let entry = keyring::Entry::new(SERVICE, &account(provider)).map_err(store_error)?;
        match entry.get_password() {
            Ok(k) => Ok(Some(ApiKey(k))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(store_error(e)),
        }
    }

    fn set(&self, provider: Provider, key: &str) -> Result<(), String> {
        keyring::Entry::new(SERVICE, &account(provider))
            .and_then(|e| e.set_password(key))
            .map_err(store_error)
    }

    fn delete(&self, provider: Provider) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, &account(provider)).map_err(store_error)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(store_error(e)),
        }
    }
}

/// keyring errors describe the store, never the secret.
fn store_error(e: keyring::Error) -> String {
    format!("The system credential store failed: {e}")
}

#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<Provider, String>>);

#[cfg(test)]
impl SecretStore for MemoryStore {
    fn get(&self, provider: Provider) -> Result<Option<ApiKey>, String> {
        Ok(self.0.lock().get(&provider).cloned().map(ApiKey))
    }
    fn set(&self, provider: Provider, key: &str) -> Result<(), String> {
        self.0.lock().insert(provider, key.to_string());
        Ok(())
    }
    fn delete(&self, provider: Provider) -> Result<(), String> {
        self.0.lock().remove(&provider);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_and_hint_never_show_the_key() {
        let key = ApiKey("sk-ant-api03-supersecretvalue-3F9A".into());
        let dbg = format!("{key:?}");
        assert!(!dbg.contains("supersecret"), "{dbg}");
        assert_eq!(key.hint(), "3F9A");
        assert_eq!(dbg, "ApiKey(…3F9A)");
    }

    #[test]
    fn cleans_pasted_keys() {
        assert_eq!(clean_key("  sk-abc123 \n").unwrap(), "sk-abc123");
        assert!(clean_key("   ").is_err());
        assert!(clean_key("sk-abc 123").is_err());
    }

    #[test]
    fn memory_store_round_trips() {
        let s = MemoryStore::default();
        assert!(s.get(Provider::OpenAI).unwrap().is_none());
        s.set(Provider::OpenAI, "k1").unwrap();
        assert_eq!(s.get(Provider::OpenAI).unwrap().unwrap().expose(), "k1");
        assert!(s.get(Provider::Anthropic).unwrap().is_none());
        s.delete(Provider::OpenAI).unwrap();
        assert!(s.get(Provider::OpenAI).unwrap().is_none());
    }
}
