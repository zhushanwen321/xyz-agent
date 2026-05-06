use std::process::{Child, Command};
use std::sync::Mutex;

pub struct SidecarManager {
    process: Mutex<Option<Child>>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
        }
    }

    pub fn start(&self, port: u16) -> Result<(), String> {
        let child = Command::new("node")
            .args([
                "node_modules/.bin/tsx",
                "sidecar/src/index.ts",
                "--port",
                &port.to_string(),
            ])
            .spawn()
            .map_err(|e| format!("Failed to start sidecar: {}", e))?;

        let mut proc = self.process.lock().map_err(|e| e.to_string())?;
        *proc = Some(child);
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut proc = self.process.lock().map_err(|e| e.to_string())?;
        if let Some(mut child) = proc.take() {
            child
                .kill()
                .map_err(|e| format!("Failed to stop sidecar: {}", e))?;
            child.wait().ok();
        }
        Ok(())
    }
}
