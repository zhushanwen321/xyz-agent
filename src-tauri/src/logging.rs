use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

use log::{LevelFilter, Metadata, Record};

/// 双写 logger：同时输出到 stderr 和日志文件
struct DualLogger {
    file: Mutex<File>,
    level: LevelFilter,
}

impl log::Log for DualLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= self.level
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let msg = format!("[{ts}] {:5} {msg}\n", record.level(), msg = record.args());

        // stderr
        eprint!("{msg}");

        // file（忽略写入失败，避免日志拖垮主流程）
        if let Ok(mut file) = self.file.lock() {
            let _ = file.write_all(msg.as_bytes());
            let _ = file.flush();
        }
    }

    fn flush(&self) {
        if let Ok(mut file) = self.file.lock() {
            let _ = file.flush();
        }
    }
}

/// 初始化日志系统
pub fn init(log_dir: &Path) {
    std::fs::create_dir_all(log_dir).ok();

    let log_path = log_dir.join("app.log");
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .expect("cannot open log file");

    // dev 模式打 Debug 级别，release 打 Info 级别
    let level = if cfg!(debug_assertions) {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    };

    let logger = DualLogger {
        file: Mutex::new(file),
        level,
    };

    let logger_ptr = Box::into_raw(Box::new(logger));
    unsafe {
        log::set_logger(&*logger_ptr)
            .expect("cannot set logger");
    }
    log::set_max_level(level);

    log::info!("log file: {}", log_path.display());
    log::info!("log level: {:?}", level);
}
