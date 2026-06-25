//! Tauri command surface for Port Process Pal.

mod ports;

use ports::{KillSummary, PortInfo};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
fn list_ports() -> Result<Vec<PortInfo>, String> {
    ports::list_ports()
}

#[tauri::command]
fn kill_process(pid: u32) -> Result<(), String> {
    ports::kill_process(pid)
}

#[tauri::command]
fn kill_all(pids: Vec<u32>) -> KillSummary {
    ports::kill_all(pids)
}

#[tauri::command]
fn open_in_browser(app: tauri::AppHandle, port: u16) -> Result<(), String> {
    let url = format!("http://localhost:{port}");
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("Could not open browser: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_ports,
            kill_process,
            kill_all,
            open_in_browser
        ])
        .run(tauri::generate_context!())
        .expect("error while running Port Process Pal");
}
