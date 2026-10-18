"""Adversarial tests for the offline source and Windows release gates."""
import importlib.util
import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "scripts" / "release_gate.py"
spec = importlib.util.spec_from_file_location("ghostwheel_release_gate", SOURCE)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def digest(data):
    return hashlib.sha256(data).hexdigest()


class ReleaseGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name in gate.REQUIRED:
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("GHOSTWHEEL vehicle simulation\n", encoding="utf-8")
        write_json(self.root / "package.json", {"version": "0.1.0", "private": True})
        write_json(self.root / "package-lock.json", {"version": "0.1.0", "packages": {"": {"version": "0.1.0"}}})
        write_json(self.root / "src-tauri/tauri.conf.json", {
            "version": "0.1.0", "bundle": {"targets": ["nsis"],
            "windows": {"nsis": {"installMode": "currentUser"}}}})

    def fixture(self):
        release = self.root / "output/release"
        release.mkdir(parents=True)
        files = {
            "portable/ghostwheel.exe": b"simulator.exe",
            "portable/ghostwheel-backend.exe": b"backend.exe",
            "GHOSTWHEEL_0.1.0_x64-setup.exe": b"installer.exe",
        }
        zipname = "GHOSTWHEEL_0.1.0_x64-portable.zip"
        with zipfile.ZipFile(release / zipname, "w") as zf:
            for name, data in files.items():
                if name.startswith("portable/"):
                    zf.writestr(name.removeprefix("portable/"), data)
        for name, data in files.items():
            dest = release / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
        files[zipname] = (release / zipname).read_bytes()
        entries = [{"file": name, "bytes": len(data), "sha256": digest(data)} for name, data in files.items()]
        sources = {"README.md": gate.sha256(self.root / "README.md")}
        receipt = {"status": "built", "version": "0.1.0", "target": "x86_64-pc-windows-msvc",
                   "officially_supported_target": "x86_64-pc-windows-msvc",
                   "gnu_compatibility_build": False, "signed": False,
                   "artifacts": entries, "sources": sources}
        write_json(release / "build-receipt.json", receipt)
        (release / "SHA256SUMS").write_text("".join(f"{e['sha256']}  {e['file']}\n" for e in entries), encoding="utf-8")
        proof = self.root / "output/verification"
        write_json(proof / "desktop-build.json", {**receipt, "verification": {"status": "passed"}})
        for name in ("desktop-sidecar-smoke", "desktop-native-smoke",
                     "desktop-install-smoke", "desktop-installed-native-smoke"):
            write_json(proof / f"{name}.json", {"status": "passed"})
        return receipt

    def test_clean_source_preflight(self):
        self.assertEqual(gate.source_preflight(self.root), "0.1.0")

    def test_source_preflight_does_not_require_removed_workflow(self):
        (self.root / ".github/workflows/validate.yml").unlink(missing_ok=True)
        self.assertEqual(gate.source_preflight(self.root), "0.1.0")

    def test_missing_local_verifiers_block_release(self):
        for name in ("scripts/verify.py", "scripts/verify-browser-sim.mjs",
                     "scripts/verify-workspace.mjs"):
            with self.subTest(script=name):
                path = self.root / name
                contents = path.read_bytes()
                path.unlink()
                try:
                    with self.assertRaisesRegex(gate.ReleaseGateError, "Missing release prerequisite"):
                        gate.source_preflight(self.root)
                finally:
                    path.write_bytes(contents)

    def test_mismatched_version_blocks_release(self):
        value = gate.read_json(self.root / "src-tauri/tauri.conf.json")
        value["version"] = "0.2.0"
        write_json(self.root / "src-tauri/tauri.conf.json", value)
        with self.assertRaisesRegex(gate.ReleaseGateError, "versions differ"):
            gate.source_preflight(self.root)

    def test_missing_security_policy_blocks_release(self):
        (self.root / "SECURITY.md").unlink()
        with self.assertRaisesRegex(gate.ReleaseGateError, "SECURITY.md"):
            gate.source_preflight(self.root)

    def test_clean_artifact_manifest(self):
        self.fixture()
        result = gate.artifact_gate(self.root, gate.source_preflight(self.root))
        self.assertTrue(result["checksums_verified"])
        self.assertEqual(result["artifacts"], 4)

    def test_modified_installer_is_rejected(self):
        self.fixture()
        with (self.root / "output/release/GHOSTWHEEL_0.1.0_x64-setup.exe").open("ab") as stream:
            stream.write(b"tamper")
        with self.assertRaisesRegex(gate.ReleaseGateError, "changed artifact"):
            gate.artifact_gate(self.root, "0.1.0")

    def test_manipulated_zip_payload_is_rejected(self):
        self.fixture()
        archive = self.root / "output/release/GHOSTWHEEL_0.1.0_x64-portable.zip"
        with zipfile.ZipFile(archive, "w") as zf:
            zf.writestr("ghostwheel.exe", b"evil-ship.exe")
            zf.writestr("ghostwheel-backend.exe", b"backend.exe")
        receipt = gate.read_json(self.root / "output/release/build-receipt.json")
        entry = next(e for e in receipt["artifacts"] if e["file"].endswith("-portable.zip"))
        entry.update(bytes=archive.stat().st_size, sha256=gate.sha256(archive))
        write_json(self.root / "output/release/build-receipt.json", receipt)
        sums = "".join(f"{e['sha256']}  {e['file']}\n" for e in receipt["artifacts"])
        (self.root / "output/release/SHA256SUMS").write_text(sums, encoding="utf-8")
        with self.assertRaisesRegex(gate.ReleaseGateError, "ZIP payload differs"):
            gate.artifact_gate(self.root, "0.1.0")

    def test_unverified_native_smoke_is_rejected(self):
        self.fixture()
        write_json(self.root / "output/verification/desktop-native-smoke.json", {"status": "failed"})
        with self.assertRaisesRegex(gate.ReleaseGateError, "not passed"):
            gate.artifact_gate(self.root, "0.1.0")

    def test_checksum_receipt_disagreement_is_rejected(self):
        self.fixture()
        file = self.root / "output/release/SHA256SUMS"
        file.write_text(file.read_text() + "\n", encoding="utf-8")
        with self.assertRaisesRegex(gate.ReleaseGateError, "SHA256SUMS"):
            gate.artifact_gate(self.root, "0.1.0")

    def test_gnu_build_rejected_for_public_windows_release(self):
        receipt = self.fixture()
        receipt["target"] = "x86_64-pc-windows-gnu"
        write_json(self.root / "output/release/build-receipt.json", receipt)
        with self.assertRaisesRegex(gate.ReleaseGateError, "MSVC"):
            gate.artifact_gate(self.root, "0.1.0")

    def test_traversal_path_is_rejected(self):
        for path in ("../outside.exe", "/tmp/other.exe", "C:/windows.exe"):
            with self.subTest(path=path), self.assertRaises(gate.ReleaseGateError):
                gate.safe_entry(self.root, path)


if __name__ == "__main__":
    unittest.main()
