use std::env;
use std::fs;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::Emitter;

pub struct SidecarManager {
    process: Mutex<Option<Child>>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
        }
    }

    /// Find an available port in the range [3210, 3220].
    fn find_available_port() -> Result<u16, String> {
        for port in 3210..=3220 {
            if TcpStream::connect(format!("127.0.0.1:{}", port)).is_err() {
                // Connection refused means port is free
                return Ok(port);
            }
        }
        Err("No available port in range 3210-3220".to_string())
    }

    /// Write the discovered port to ~/.xyz-agent/sidecar.port
    fn write_port_file(port: u16) -> Result<(), String> {
        let dir = home_dir()?.join(".xyz-agent");
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create ~/.xyz-agent: {}", e))?;
        fs::write(dir.join("sidecar.port"), port.to_string())
            .map_err(|e| format!("Failed to write sidecar.port: {}", e))?;
        Ok(())
    }

    /// Wait for sidecar to become healthy by attempting TCP connect.
    fn health_check(port: u16) -> Result<(), String> {
        for _ in 0..30 {
            if TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok() {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(200));
        }
        Err(format!(
            "Sidecar health check timed out on port {}",
            port
        ))
    }

    /// Start the sidecar process on an available port, perform health check,
    /// write port file, and emit the `sidecar-port` event.
    pub fn start(&self, app: &tauri::AppHandle) -> Result<u16, String> {
        // Stop any existing process first
        self.stop()?;

        let port = Self::find_available_port()?;

        log::info!("Starting sidecar on port {}", port);

        let child = Command::new("node")
            .args([
                "node_modules/.bin/tsx",
                "sidecar/src/index.ts",
                &format!("--port={}", port),
            ])
            .spawn()
            .map_err(|e| format!("Failed to start sidecar: {}", e))?;

        {
            let mut proc = self.process.lock().map_err(|e| e.to_string())?;
            *proc = Some(child);
        }

        // Wait for sidecar to be ready
        Self::health_check(port)?;

        // Write port file
        Self::write_port_file(port)?;

        // Notify frontend
        app.emit("sidecar-port", port)
            .map_err(|e| format!("Failed to emit sidecar-port: {}", e))?;

        log::info!("Sidecar ready on port {}", port);
        Ok(port)
    }

    /// Stop the sidecar process. Uses child.kill() for cross-platform support.
    pub fn stop(&self) -> Result<(), String> {
        let mut proc = self.process.lock().map_err(|e| e.to_string())?;
        if let Some(mut child) = proc.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }
}

/// Get the user's home directory using std::env (no external deps).
fn home_dir() -> Result<PathBuf, String> {
    env::var("HOME")
        .or_else(|_| env::var("USERPROFILE").map(|p| p))
        .map(PathBuf::from)
        .map_err(|_| "Cannot determine home directory".to_string())
}
