//! OS-level port enumeration and process control.
//!
//! Everything here is "run a command, parse its output into structs." Each
//! public function branches per-OS and is written so that a single unparseable
//! row never takes down the whole list.

use serde::Serialize;
use std::process::Command;

#[cfg(target_os = "windows")]
use serde::Deserialize;

#[cfg(not(target_os = "windows"))]
use std::collections::HashSet;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// One listening port and the process that owns it.
#[derive(Debug, Clone, Serialize)]
pub struct PortInfo {
    pub port: u16,
    pub protocol: String,
    pub pid: u32,
    pub process_name: String,
    /// Full executable path / command line, when the OS will give it up.
    pub path: Option<String>,
    /// Process start time as a human-readable string, when available.
    pub started_at: Option<String>,
    /// True for privileged ports and well-known system processes. Such rows
    /// are shown but excluded from bulk actions and styled as muted.
    pub protected: bool,
}

/// Outcome of a "stop all" sweep.
#[derive(Debug, Clone, Serialize)]
pub struct KillSummary {
    pub killed: Vec<u32>,
    pub skipped: Vec<u32>,
    pub failed: Vec<KillFailure>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KillFailure {
    pub pid: u32,
    pub reason: String,
}

/// Well-known system process names that should never be offered for bulk kill.
const SYSTEM_PROCESSES: &[&str] = &[
    "system",
    "registry",
    "idle",
    "smss",
    "csrss",
    "wininit",
    "services",
    "lsass",
    "winlogon",
    "svchost",
    "spoolsv",
    "dwm",
    "launchd",
    "systemd",
    "kernel_task",
    "mdnsresponder",
    "rpcbind",
];

/// Decide whether a row is protected from killing.
fn is_protected(port: u16, pid: u32, name: &str) -> bool {
    if pid <= 1 || pid == 4 || pid == std::process::id() {
        return true;
    }
    if port < 1024 {
        return true;
    }
    let lower = name.to_ascii_lowercase();
    SYSTEM_PROCESSES.iter().any(|s| lower == *s)
}

/// Hard guard used by the kill paths: these PIDs are never terminated no matter
/// what the frontend asks for.
fn is_untouchable(pid: u32) -> bool {
    pid <= 1 || pid == 4 || pid == std::process::id()
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

pub fn list_ports() -> Result<Vec<PortInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        list_ports_windows()
    }
    #[cfg(not(target_os = "windows"))]
    {
        list_ports_unix()
    }
}

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(target_os = "windows")]
#[derive(Deserialize)]
struct PsConn {
    port: u16,
    protocol: String,
    pid: u32,
    process_name: Option<String>,
    path: Option<String>,
    started_at: Option<String>,
}

/// Windows: one PowerShell call returns listening TCP connections joined with
/// process metadata as JSON, which is far cleaner to consume than scraping
/// `netstat` + `tasklist`.
#[cfg(target_os = "windows")]
fn list_ports_windows() -> Result<Vec<PortInfo>, String> {
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$conns = Get-NetTCPConnection -State Listen
$seen = @{}
$out = foreach ($c in $conns) {
    $key = "$($c.LocalPort)-$($c.OwningProcess)"
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $p = Get-Process -Id $c.OwningProcess
    $start = $null
    try { if ($p -and $p.StartTime) { $start = $p.StartTime.ToString('o') } } catch {}
    [PSCustomObject]@{
        port         = [int]$c.LocalPort
        protocol     = 'TCP'
        pid          = [int]$c.OwningProcess
        process_name = if ($p) { $p.ProcessName } else { 'unknown' }
        path         = if ($p) { $p.Path } else { $null }
        started_at   = $start
    }
}
ConvertTo-Json -InputObject @($out) -Depth 3 -Compress
"#;

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("failed to run PowerShell: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let conns: Vec<PsConn> = serde_json::from_str(trimmed)
        .map_err(|e| format!("failed to parse port data: {e}"))?;

    let mut ports = Vec::with_capacity(conns.len());
    for c in conns {
        let name = c.process_name.unwrap_or_else(|| "unknown".to_string());
        let protected = is_protected(c.port, c.pid, &name);
        ports.push(PortInfo {
            port: c.port,
            protocol: c.protocol,
            pid: c.pid,
            process_name: name,
            path: c.path.filter(|p| !p.is_empty()),
            started_at: c.started_at.filter(|s| !s.is_empty()),
            protected,
        });
    }
    sort_ports(&mut ports);
    Ok(ports)
}

/// macOS / Linux: `lsof` lists the listening sockets and owning processes; a
/// follow-up `ps` per unique PID fills in start time and the full command.
#[cfg(not(target_os = "windows"))]
fn list_ports_unix() -> Result<Vec<PortInfo>, String> {
    let output = Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN"])
        .output()
        .map_err(|e| format!("failed to run lsof: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut ports: Vec<PortInfo> = Vec::new();
    let mut seen: HashSet<(u16, u32)> = HashSet::new();

    for line in stdout.lines().skip(1) {
        // COMMAND  PID  USER  FD  TYPE  DEVICE  SIZE/OFF  NODE  NAME
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 9 {
            continue; // never let one odd row sink the whole list
        }
        let name = cols[0].to_string();
        let pid: u32 = match cols[1].parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let addr = cols[cols.len() - 1];
        let port: u16 = match addr.rsplit(':').next().and_then(|p| p.parse().ok()) {
            Some(p) => p,
            None => continue,
        };
        if !seen.insert((port, pid)) {
            continue;
        }
        let (started_at, path) = ps_details(pid);
        let protected = is_protected(port, pid, &name);
        ports.push(PortInfo {
            port,
            protocol: "TCP".to_string(),
            pid,
            process_name: name,
            path,
            started_at,
            protected,
        });
    }
    sort_ports(&mut ports);
    Ok(ports)
}

/// Returns `(started_at, command)` for a PID via `ps`. Failures degrade to
/// `None` rather than erroring out the whole listing.
#[cfg(not(target_os = "windows"))]
fn ps_details(pid: u32) -> (Option<String>, Option<String>) {
    let started_at = Command::new("ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .output()
        .ok()
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        });

    let command = Command::new("ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
        .ok()
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        });

    (started_at, command)
}

fn sort_ports(ports: &mut [PortInfo]) {
    ports.sort_by(|a, b| a.port.cmp(&b.port));
}

// ---------------------------------------------------------------------------
// Killing
// ---------------------------------------------------------------------------

pub fn kill_process(pid: u32) -> Result<(), String> {
    if is_untouchable(pid) {
        return Err(format!("PID {pid} is protected and cannot be terminated."));
    }

    #[cfg(target_os = "windows")]
    {
        kill_windows(pid)
    }
    #[cfg(not(target_os = "windows"))]
    {
        kill_unix(pid)
    }
}

#[cfg(target_os = "windows")]
fn kill_windows(pid: u32) -> Result<(), String> {
    let output = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("failed to run taskkill: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let msg = String::from_utf8_lossy(&output.stderr);
        let msg = msg.trim();
        if msg.is_empty() {
            Err(format!("Could not terminate PID {pid}. It may require elevation."))
        } else {
            Err(msg.to_string())
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn kill_unix(pid: u32) -> Result<(), String> {
    // Graceful first, then escalate to SIGKILL only if it survives.
    let graceful = Command::new("kill")
        .arg(pid.to_string())
        .output()
        .map_err(|e| format!("failed to run kill: {e}"))?;

    if graceful.status.success() {
        return Ok(());
    }

    let forced = Command::new("kill")
        .args(["-9", &pid.to_string()])
        .output()
        .map_err(|e| format!("failed to run kill -9: {e}"))?;

    if forced.status.success() {
        Ok(())
    } else {
        let msg = String::from_utf8_lossy(&forced.stderr);
        let msg = msg.trim();
        if msg.is_empty() {
            Err(format!("Could not terminate PID {pid}. It may require elevation."))
        } else {
            Err(msg.to_string())
        }
    }
}

/// Terminate a batch of PIDs, honouring the untouchable guard, and report what
/// happened to each one.
pub fn kill_all(pids: Vec<u32>) -> KillSummary {
    let mut summary = KillSummary {
        killed: Vec::new(),
        skipped: Vec::new(),
        failed: Vec::new(),
    };

    for pid in pids {
        if is_untouchable(pid) {
            summary.skipped.push(pid);
            continue;
        }
        match kill_process(pid) {
            Ok(()) => summary.killed.push(pid),
            Err(reason) => summary.failed.push(KillFailure { pid, reason }),
        }
    }

    summary
}
