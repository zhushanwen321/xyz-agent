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
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

impl PartialEq for AppError {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Llm(a), Self::Llm(b)) => a == b,
            (Self::Storage(a), Self::Storage(b)) => a == b,
            (Self::SessionNotFound(a), Self::SessionNotFound(b)) => a == b,
            (Self::Config(a), Self::Config(b)) => a == b,
            (Self::Io(a), Self::Io(b)) => a.kind() == b.kind() && a.to_string() == b.to_string(),
            (Self::Serialization(a), Self::Serialization(b)) => a.to_string() == b.to_string(),
            _ => false,
        }
    }
}

impl From<AppError> for String {
    fn from(err: AppError) -> String {
        err.to_string()
    }
}

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

}
