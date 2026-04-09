use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("LLM API error: {0}")]
    Llm(String),
    #[error("Storage error: {0}")]
    Storage(String),
    #[error("Session not found: {0}")]
    SessionNotFound(String),
    #[error("Config error: {0}")]
    Config(String),
}

// 让 Tauri command 能返回 Result<T, String>
impl From<AppError> for String {
    fn from(err: AppError) -> String {
        err.to_string()
    }
}

// Serialize 用于 Tauri event payload（只取 message）
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_llm_error_to_string() {
        let err = AppError::Llm("rate limited".into());
        assert_eq!(err.to_string(), "LLM API error: rate limited");
    }

    #[test]
    fn test_storage_error_into_string() {
        let err = AppError::Storage("disk full".into());
        let s: String = err.into();
        assert_eq!(s, "Storage error: disk full");
    }

    #[test]
    fn test_session_not_found_serializes_as_str() {
        let err = AppError::SessionNotFound("abc-123".into());
        let json = serde_json::to_string(&err).unwrap();
        assert_eq!(json, "\"Session not found: abc-123\"");
    }

    #[test]
    fn test_all_variants_convert_to_string() {
        let cases: Vec<AppError> = vec![
            AppError::Llm("e1".into()),
            AppError::Storage("e2".into()),
            AppError::SessionNotFound("e3".into()),
            AppError::Config("e4".into()),
        ];
        let strings: Vec<String> = cases.into_iter().map(|e| e.into()).collect();
        assert_eq!(strings[0], "LLM API error: e1");
        assert_eq!(strings[1], "Storage error: e2");
        assert_eq!(strings[2], "Session not found: e3");
        assert_eq!(strings[3], "Config error: e4");
    }
}
