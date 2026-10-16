"""Build the Python simulation service as a Tauri sidecar (Windows host only)."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", default="x86_64-pc-windows-msvc")
    options = parser.parse_args()
    if sys.platform != "win32" or "windows" not in options.target:
        raise SystemExit("Build Windows sidecars on Windows with a matching Python architecture.")
    machine = platform.machine().lower()
    if options.target.startswith("x86_64") and machine not in {"amd64", "x86_64"}:
        raise SystemExit("x86_64 sidecar requires x86_64 Python; do not relabel ARM executables.")
    build = ROOT / ".build" / "sidecar"
    destination = ROOT / "src-tauri" / "binaries"
    destination.mkdir(parents=True, exist_ok=True)
    subprocess.run([
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
        "--name", "ghostwheel-backend", "--paths", str(ROOT / "backend"),
        "--collect-submodules", "ghostwheel", "--collect-all", "carla", "--hidden-import", "sqlite3",
        "--distpath", str(build / "dist"), "--workpath", str(build / "work"),
        "--specpath", str(build), str(ROOT / "scripts" / "sidecar-entry.py"),
    ], cwd=ROOT, check=True)
    executable = destination / f"ghostwheel-backend-{options.target}.exe"
    shutil.copy2(build / "dist" / "ghostwheel-backend.exe", executable)
    receipt = {
        "artifact": executable.name, "target": options.target,
        "python": sys.version, "bytes": executable.stat().st_size,
        "sha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
        "source_sha256": {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((ROOT / "backend" / "ghostwheel").glob("*.py"))},
        "scope": "Simulator-only Python service. CARLA 0.9.16 Python client bundled; CARLA server and vehicle drivers not bundled.",
    }
    (build / "sidecar-receipt.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
