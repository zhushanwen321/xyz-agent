// 防止 Windows release 模式下出现额外控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    xyz_agent::run()
}
