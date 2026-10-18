#!/usr/bin/env python3
"""Fail-closed source and Windows release-candidate integrity checks.

Run `python scripts/release_gate.py` for source preflight, or add `--artifacts`
after the supported Windows/MSVC build and native/installer smoke tests.
No network access or third-party Python packages are required.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
HEX = re.compile(r"^[0-9a-f]{64}$")
REQUIRED = (
    "README.md", "LICENSE", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md",
    "docs/release-checklist.md", "package.json", "package-lock.json",
    "src-tauri/tauri.conf.json", "scripts/verify.py",
    "scripts/verify-browser-sim.mjs", "scripts/verify-workspace.mjs",
    ".github/workflows/windows.yml", "scripts/verify-evidence.py",
    "scripts/desktop-final-verify.py", "tests/test_release_gate.py",
)


class ReleaseGateError(ValueError):
    """A release candidate cannot be trusted or distributed."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ReleaseGateError(message)


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise ReleaseGateError(f"Cannot read valid JSON: {path}: {exc}") from exc
    require(isinstance(value, dict), f"Expected JSON object: {path}")
    return value


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def source_preflight(root: Path) -> str:
    for relative in REQUIRED:
        require((root / relative).is_file(), f"Missing release prerequisite: {relative}")
    pkg = read_json(root / "package.json")
    lock = read_json(root / "package-lock.json")
    tauri = read_json(root / "src-tauri/tauri.conf.json")
    version = pkg.get("version")
    require(isinstance(version, str) and re.fullmatch(r"\d+\.\d+\.\d+", version),
            "package.json version must be an explicit semantic version")
    require(version == lock.get("version") == lock.get("packages", {}).get("", {}).get("version")
            == tauri.get("version"), "npm lockfile, package.json and Tauri versions differ")
    require(pkg.get("private") is True, "The npm package must remain private (not npm-published)")
    require(tauri.get("bundle", {}).get("targets") == ["nsis"],
            "Review distribution targets before publishing a release")
    require(tauri.get("bundle", {}).get("windows", {}).get("nsis", {}).get("installMode") == "currentUser",
            "Installer must retain its per-user installation boundary")
    readme = (root / "README.md").read_text(encoding="utf-8")
    require("simulation" in readme.lower() and "vehicle" in readme.lower(),
            "README must explain the virtual-vehicle boundary")
    return version


def safe_entry(root: Path, name: str) -> Path:
    p = PurePosixPath(name)
    require(bool(name) and "\\" not in name and not p.is_absolute() and
            not any(part in ("", ".", "..") for part in p.parts) and
            not re.match(r"^[A-Za-z]:", name), f"Unsafe artifact path: {name}")
    target = (root / Path(*p.parts)).resolve()
    require(target.is_relative_to(root.resolve()), f"Artifact escapes release folder: {name}")
    return target


def artifact_gate(root: Path, expected_version: str) -> dict:
    release = root / "output/release"
    receipts = root / "output/verification"
    build = read_json(release / "build-receipt.json")
    require(build.get("status") == "built", "Release receipt does not say built")
    require(build.get("version") == expected_version, "Build version differs from source")
    require(build.get("target") == "x86_64-pc-windows-msvc" and
            build.get("officially_supported_target") == "x86_64-pc-windows-msvc" and
            build.get("gnu_compatibility_build") is False,
            "Public Windows release requires the supported x64 MSVC build")
    require(build.get("signed") is False, "Unexpected signature status: verify signing independently")
    entries = build.get("artifacts")
    require(isinstance(entries, list) and entries, "Missing release artifact manifest")
    mapped = {}
    for entry in entries:
        require(isinstance(entry, dict), "Invalid artifact manifest entry")
        name, expected_hash, size = entry.get("file"), entry.get("sha256"), entry.get("bytes")
        require(isinstance(name, str) and name not in mapped, f"Duplicate artifact name: {name}")
        require(isinstance(expected_hash, str) and HEX.fullmatch(expected_hash), f"Invalid hash: {name}")
        require(type(size) is int and size > 0, f"Invalid size: {name}")
        path = safe_entry(release, name)
        require(path.is_file() and path.stat().st_size == size, f"Missing/changed artifact: {name}")
        require(sha256(path) == expected_hash, f"SHA256 mismatch: {name}")
        mapped[name] = entry
    installers = [name for name in mapped if name.endswith("-setup.exe") and "/" not in name]
    zips = [name for name in mapped if name.endswith("-portable.zip") and "/" not in name]
    require(len(installers) == len(zips) == 1, "Expected one installer and one portable ZIP")
    expected_portable = {name.removeprefix("portable/"): name for name in mapped
                         if name.startswith("portable/")}
    require(set(expected_portable) == {"ghostwheel.exe", "ghostwheel-backend.exe"},
            "Portable MSVC release must have exactly the app and bundled backend")
    with zipfile.ZipFile(release / zips[0]) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)) and set(names) == set(expected_portable),
                "ZIP must contain exactly the listed portable executables")
        for name in names:
            require(archive.getinfo(name).file_size == mapped[expected_portable[name]]["bytes"],
                    f"Portable ZIP size mismatch: {name}")
            digest = hashlib.sha256()
            with archive.open(name) as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
            require(digest.hexdigest() == mapped[expected_portable[name]]["sha256"],
                    f"Portable ZIP payload differs: {name}")
    sums = (release / "SHA256SUMS").read_text(encoding="utf-8").splitlines()
    expected_lines = {f"{entry['sha256']}  {name}" for name, entry in mapped.items()}
    require(len(sums) == len(set(sums)) and set(sums) == expected_lines,
            "SHA256SUMS must exactly match the build manifest")
    sources = build.get("sources")
    require(isinstance(sources, dict) and sources, "Build receipt omits source hashes")
    for name, digest in sources.items():
        require(isinstance(name, str) and isinstance(digest, str) and HEX.fullmatch(digest),
                f"Invalid source receipt entry: {name}")
        path = safe_entry(root, name)
        require(path.is_file() and sha256(path) == digest, f"Source changed since build: {name}")
    final = read_json(receipts / "desktop-build.json")
    require(final.get("verification", {}).get("status") == "passed",
            "Native/installed release verification not passed")
    require(final.get("artifacts") == entries and final.get("sources") == sources,
            "Verified build receipt differs from packaged artifacts/sources")
    for name in ("desktop-sidecar-smoke", "desktop-native-smoke",
                 "desktop-install-smoke", "desktop-installed-native-smoke"):
        result = read_json(receipts / f"{name}.json")
        require(result.get("status") == "passed",
                f"QA receipt is not passed: {name}")
    return {"version": expected_version, "target": build["target"], "artifacts": len(mapped),
            "installer": installers[0], "checksums_verified": True,
            "installed_and_native_qa": "passed", "unsigned": True}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", action="store_true", help="Verify MSVC distribution and all native QA receipts")
    parser.add_argument("--root", type=Path, default=ROOT, help=argparse.SUPPRESS)
    options = parser.parse_args(argv)
    try:
        version = source_preflight(options.root)
        result = {"status": "passed", "phase": "source-preflight", "version": version}
        if options.artifacts:
            result.update(artifact_gate(options.root, version))
            result["phase"] = "windows-release-candidate"
        print(json.dumps(result, indent=2))
        return 0
    except (ReleaseGateError, OSError, zipfile.BadZipFile) as exc:
        print(f"RELEASE BLOCKED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
