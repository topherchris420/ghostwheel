#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
#[cfg(debug_assertions)]
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

#[derive(Deserialize)]
struct Ready {
    status: String,
    port: u16,
    simulation_only: bool,
}
use tauri::{Manager, State};

#[derive(Clone, Serialize)]
struct BackendInfo {
    base_url: String,
    token: String,
}

struct Backend {
    info: BackendInfo,
    child: Mutex<Option<Child>>,
    #[cfg(windows)]
    job: Mutex<Option<WindowsJob>>,
}

// PyInstaller's one-file bootloader starts a second process. A Windows job
// owns the complete process tree, including if the desktop process crashes.
#[cfg(windows)]
struct WindowsJob(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for WindowsJob {}
#[cfg(windows)]
impl WindowsJob {
    fn attach(child: &Child) -> std::io::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const std::ffi::c_void,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle() as _) == 0
            {
                let error = std::io::Error::last_os_error();
                CloseHandle(handle);
                return Err(error);
            }
            Ok(Self(handle))
        }
    }
}
#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn resume_child(child: &Child) -> std::io::Result<()> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::*;
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut exists = Thread32First(snapshot, &mut entry) != 0;
        while exists {
            if entry.th32OwnerProcessID == child.id() {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if thread.is_null() {
                    let error = std::io::Error::last_os_error();
                    CloseHandle(snapshot);
                    return Err(error);
                }
                let result = ResumeThread(thread);
                let error = std::io::Error::last_os_error();
                CloseHandle(thread);
                CloseHandle(snapshot);
                return if result == u32::MAX {
                    Err(error)
                } else {
                    Ok(())
                };
            }
            exists = Thread32Next(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Backend primary thread unavailable",
        ))
    }
}

impl Backend {
    fn stop(&self) {
        #[cfg(windows)]
        if let Ok(mut job) = self.job.lock() {
            job.take();
        }
        if let Ok(mut state) = self.child.lock() {
            if let Some(mut child) = state.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        self.stop();
    }
}

#[tauri::command]
fn backend_info(backend: State<'_, Backend>) -> Result<BackendInfo, String> {
    let mut guard = backend
        .child
        .lock()
        .map_err(|_| "Backend state unavailable")?;
    match guard.as_mut().ok_or("Backend is stopped")?.try_wait() {
        Ok(None) => Ok(backend.info.clone()),
        Ok(Some(_)) => Err("Simulation backend exited. Restart GHOSTWHEEL.".into()),
        Err(error) => Err(format!("Backend status unavailable: {error}")),
    }
}

fn healthy(port: u16, token: &str) -> bool {
    let address = ([127, 0, 0, 1], port).into();
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(200)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(400)));
    let request = format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Ghostwheel-Token: {token}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut reply = String::new();
    if stream.read_to_string(&mut reply).is_err() {
        return false;
    }
    if !(reply.starts_with("HTTP/1.1 200") || reply.starts_with("HTTP/1.0 200")) {
        return false;
    }
    let Some((_, body)) = reply.split_once("\r\n\r\n") else {
        return false;
    };
    let Ok(health) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    health["status"] == "ok" && health["app"] == "GHOSTWHEEL" && health["simulation_only"] == true
}

fn start_backend(app: &tauri::App) -> Result<Backend, Box<dyn std::error::Error>> {
    let data = app.path().app_local_data_dir()?;
    fs::create_dir_all(&data)?;
    let mut random = [0u8; 32];
    getrandom::fill(&mut random)
        .map_err(|error| format!("OS random source unavailable: {error}"))?;
    let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let executable = std::env::current_exe()?
        .parent()
        .ok_or("No executable directory")?
        .join("ghostwheel-backend.exe");
    let mut command = if executable.is_file() {
        Command::new(executable)
    } else {
        #[cfg(not(debug_assertions))]
        return Err("Bundled simulation backend is missing. Reinstall GHOSTWHEEL.".into());
        #[cfg(debug_assertions)]
        {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .ok_or("No project directory")?
                .to_path_buf();
            let python = std::env::var_os("GHOSTWHEEL_PYTHON").unwrap_or_else(|| "python".into());
            let mut dev = Command::new(python);
            dev.args(["-m", "ghostwheel.server"])
                .env("PYTHONPATH", root.join("backend"))
                .current_dir(root);
            dev
        }
    };
    command
        .args(["--port", "0", "--db"])
        .arg(data.join("ghostwheel.sqlite3"))
        .args(["--token", &token, "--desktop"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(fs::File::create(data.join("backend.log"))?));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000004); // CREATE_NO_WINDOW | CREATE_SUSPENDED
    }
    let mut child = command.spawn()?;
    #[cfg(windows)]
    let job = match WindowsJob::attach(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.into());
        }
    };
    #[cfg(windows)]
    if let Err(error) = resume_child(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error.into());
    }
    // The child's private stdout pipe provides the OS-assigned port; no port
    // reservation is released before binding and no webview selects the port.
    let stdout = child
        .stdout
        .take()
        .ok_or("Backend readiness pipe missing")?;
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout)
            .take(4096)
            .read_line(&mut line)
            .map(|_| line);
        let _ = sender.send(result);
    });
    let ready: Ready = match receiver.recv_timeout(Duration::from_secs(40)) {
        Ok(Ok(line)) => serde_json::from_str(&line)?,
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Backend did not provide a readiness message".into());
        }
    };
    if ready.status != "ready" || !ready.simulation_only || ready.port == 0 {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Backend readiness contract failed".into());
    }
    let port = ready.port;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait()? {
            return Err(format!(
                "Simulation backend exited ({status}); see {}",
                data.join("backend.log").display()
            )
            .into());
        }
        if healthy(port, &token) {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "Simulation backend startup timed out; no control commands were enabled".into(),
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(Backend {
        info: BackendInfo {
            base_url: format!("http://127.0.0.1:{port}"),
            token,
        },
        child: Mutex::new(Some(child)),
        #[cfg(windows)]
        job: Mutex::new(Some(job)),
    })
}

fn main() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![backend_info])
        .setup(|app| {
            app.manage(start_backend(app)?);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("GHOSTWHEEL could not initialize its isolated simulation backend");
    app.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            if let Some(backend) = handle.try_state::<Backend>() {
                backend.stop();
            }
        }
    });
}
