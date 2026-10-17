# Windows desktop packaging

**Release candidate gate:** [docs/release-checklist.md](../docs/release-checklist.md) requires source preflight, frozen-sidecar smoke, portable native UI smoke, silent installer identity checks, installed native UI smoke, final verification, and SHA-256/ZIP receipt validation **before** artifact upload. Run `python scripts/release_gate.py` before building and `python scripts/release_gate.py --artifacts` after all QA steps. These are unsigned candidates, not automatically published releases.

`npm run desktop:build` builds the Python sidecar, React distribution, Rust desktop shell, and a per-user NSIS installer. Artifacts and SHA-256 receipts appear in `output/release/`. The supported release environment is Windows x64, Python 3.11 x64, Node 22, Rust stable MSVC, Microsoft C++ Build Tools (Desktop development with C++), and Windows SDK. Install Python build dependencies with `python -m pip install -r scripts/build-requirements.txt`; run `npm ci` for locked JavaScript dependencies. The CI workflow uses this environment. The CARLA 0.9.16 Python client is bundled. A CARLA 0.9.16 simulator server is optional, separately installed, and is not included in the installer.

The app starts only the bundled `ghostwheel-backend.exe`, with a fresh 256-bit OS-generated token and an ephemeral IPv4 loopback port. The database and backend startup log live in the app's local data directory, resolved by Tauri's path API. A Windows job owns the backend process tree and terminates it when the desktop application closes. JavaScript receives `{base_url, token}` through the single `backend_info` command. No shell plugin or filesystem plugin is exposed to the webview. The static CSP permits API connections only to loopback. The simulator itself enforces authorization and command validity.

The first startup can take longer while the one-file sidecar extracts. Desktop startup waits up to 40 seconds for the child's private readiness pipe to provide the OS-assigned loopback port, then up to 5 seconds for a health response. It fails if the child exits or the readiness contract is invalid. The installer can fetch Microsoft WebView2 when it is missing. This release is unsigned; no publisher identity or production automotive certification is claimed.

Sources checked 2026-10-16: [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), [sidecar naming and bundling](https://v2.tauri.app/develop/sidecar/), [Windows NSIS distribution](https://v2.tauri.app/distribute/windows-installer/), [NSIS configuration](https://v2.tauri.app/reference/config/#nsisconfig). Tauri officially supports the Windows MSVC target. A GNU local build is an engineering compatibility experiment and is recorded separately if produced.


For the local GNU compatibility build on this host, use:

```powershell
python -m venv .build/pyenv
.build/pyenv/Scripts/python.exe -m pip install -r scripts/build-requirements.txt
.build/pyenv/Scripts/python.exe -m pip install zstandard==0.25.0
.build/pyenv/Scripts/python.exe scripts/build-gnu-tools.py
npm run desktop:build -- --target x86_64-pc-windows-gnu
```

`build-gnu-tools.py` downloads fixed MSYS2 packages, verifies their published SHA-256 values, and extracts them into `.build/binutils/`; it does not install system packages or modify global PATH. Rust's installed self-contained GNU linker links the application; the local GCC preprocesses the resource file. The GNU release includes Microsoft's dynamic WebView2 loader, identified from the Cargo-locked `webview2-com-sys` crate. `output/release/portable/` must stay together; its ZIP includes all three required files. MSVC releases do not need the separate loader DLL.

`python scripts/desktop-smoke.py --backend <sidecar.exe>` verifies the frozen service and its bundled CARLA client. `node scripts/desktop-native-smoke.mjs <ghostwheel.exe>` launches the actual desktop app with a temporary loopback CDP flag in only that test child's environment, tests native React/API connectivity, keyboard steering and safe stop, captures a screenshot, and checks service shutdown after the host exits. The default application contains no remote debugging startup flag. Native test receipts are placed in `output/verification/`; test images are in `output/screenshots/`. CARLA server integration remains unvalidated until a separate CARLA 0.9.16 server is supplied.


NSIS identity verification: the Tauri bundler changes the unique `__TAURI_BUNDLE_TYPE_VAR_UNK` marker to `__TAURI_BUNDLE_TYPE_VAR_NSS` in its installer copy and restores the portable executable afterward. This is defined in the Cargo-locked `tauri-utils` 2.10.2 `src/platform.rs` (`NSS` maps to `BundleType::Nsis`). Therefore the installed shell and portable shell have different raw SHA-256 values. `desktop-install-smoke.ps1` derives the expected installed hash using only that single three-byte substitution and rejects any other difference. Sidecar and loader files must match exactly. The actual portable and installed hashes remain recorded separately.
