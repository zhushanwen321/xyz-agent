use std::collections::HashMap;
use std::time::SystemTime;

/// 记录已读取文件的信息，用于生成上下文摘要注入 system prompt
#[derive(Debug, Clone)]
struct FileInfo {
    size_bytes: u64,
    line_count: u32,
    last_read: SystemTime,
}

pub struct DataContext {
    files: HashMap<String, FileInfo>,
}

impl DataContext {
    pub fn new() -> Self {
        Self {
            files: HashMap::new(),
        }
    }

    pub fn record_file_read(&mut self, path: &str, size_bytes: u64, line_count: u32) {
        self.files.insert(
            path.to_string(),
            FileInfo {
                size_bytes,
                line_count,
                last_read: SystemTime::now(),
            },
        );
    }

    /// 生成已读取文件摘要，最多 20 条，按最近读取时间降序
    pub fn generate_summary(&self) -> Option<String> {
        if self.files.is_empty() {
            return None;
        }

        let mut entries: Vec<_> = self.files.iter().collect();
        entries.sort_by(|a, b| b.1.last_read.cmp(&a.1.last_read));

        let lines: Vec<String> = entries
            .iter()
            .take(20)
            .map(|(path, info)| {
                format!(
                    "- {} ({} lines, {:.1}KB)",
                    path,
                    info.line_count,
                    info.size_bytes as f64 / 1024.0
                )
            })
            .collect();

        Some(lines.join("\n"))
    }
}

impl Default for DataContext {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn test_record_and_summary() {
        let mut ctx = DataContext::new();
        ctx.record_file_read("src/main.rs", 2048, 50);
        ctx.record_file_read("src/lib.rs", 4096, 120);

        let summary = ctx.generate_summary().unwrap();
        assert!(summary.contains("src/main.rs"));
        assert!(summary.contains("50 lines"));
        assert!(summary.contains("2.0KB"));
        assert!(summary.contains("src/lib.rs"));
        assert!(summary.contains("120 lines"));
        assert!(summary.contains("4.0KB"));
    }

    #[test]
    fn test_empty_context_returns_none() {
        let ctx = DataContext::new();
        assert!(ctx.generate_summary().is_none());
    }

    #[test]
    fn test_summary_sorted_by_recency() {
        let mut ctx = DataContext::new();

        // 先记录 file_a
        ctx.record_file_read("file_a.rs", 100, 10);
        thread::sleep(Duration::from_millis(10));
        // 再记录 file_b，应排在前面
        ctx.record_file_read("file_b.rs", 200, 20);

        let summary = ctx.generate_summary().unwrap();
        let pos_a = summary.find("file_a.rs").unwrap();
        let pos_b = summary.find("file_b.rs").unwrap();
        assert!(pos_b < pos_a, "file_b should appear before file_a");
    }
}
