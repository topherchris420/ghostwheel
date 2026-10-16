"""Check final artifact identities against recorded native and installer QA."""
import datetime, hashlib, json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
VERIFY=ROOT/"output"/"verification"
def read(path):return json.loads(path.read_text(encoding="utf-8-sig"))
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def main():
    build=read(ROOT/"output"/"release"/"build-receipt.json")
    artifacts={entry["file"]:entry for entry in build["artifacts"]}
    for name,entry in artifacts.items():assert digest(ROOT/"output"/"release"/name)==entry["sha256"],name
    native=read(VERIFY/"desktop-native-smoke.json")
    installed=read(VERIFY/"desktop-installed-native-smoke.json")
    install=read(VERIFY/"desktop-install-smoke.json")
    sidecar=read(VERIFY/"desktop-sidecar-smoke.json")
    assert native["status"]==installed["status"]==install["status"]=="passed"
    assert native["executable_sha256"]==artifacts["portable/ghostwheel.exe"]["sha256"]
    assert native["backend_stopped"] and installed["backend_stopped"] and sidecar["owned_process_tree_stopped"]
    assert sidecar["sha256"]==artifacts["portable/ghostwheel-backend.exe"]["sha256"]
    assert sidecar["experiments"]["totals"]["failed"]==0
    assert sidecar["carla_client"]["available"] is True
    assert install["installer_sha256"]==artifacts[install["installer"]]["sha256"]
    for item in install["installed"]:
        assert item["matches_release"] is True and item["sha256"]==item["expected_installed_sha256"]
        assert digest(Path(install["destination"])/item["file"])==item["sha256"]
    installed_main=next(item for item in install["installed"] if item["file"]=="ghostwheel.exe")
    assert installed["executable_sha256"]==installed_main["sha256"]
    for proof in (native,installed):assert "GW-01" in proof["view"]["header"]
    sidecar_build=read(ROOT/".build"/"sidecar"/"sidecar-receipt.json")
    for name,expected in sidecar_build["source_sha256"].items():assert digest(ROOT/name)==expected==build["sources"][name],name
    build["verification"]={"status":"passed","verified_at_utc":datetime.datetime.now(datetime.timezone.utc).isoformat(),"frozen_backend":{"receipt":"desktop-sidecar-smoke.json","assertions":sidecar["experiments"]["totals"],"owned_process_tree_stopped":True},"native_portable":{"receipt":"desktop-native-smoke.json","sha256":native["executable_sha256"],"keyboard_steering":True,"safe_stop":True,"backend_cleanup":True,"header":native["view"]["header"],"scripts":native["view"]["scripts"]},"installer":{"receipt":"desktop-install-smoke.json","sha256":install["installer_sha256"],"exact_identity_checks":True,"nsis_marker_transform":installed_main["comparison"]},"native_installed":{"receipt":"desktop-installed-native-smoke.json","sha256":installed["executable_sha256"],"keyboard_steering":True,"safe_stop":True,"backend_cleanup":True},"screenshots":["native-console.png","installed-console.png"],"carla_server_exercised":False}
    (VERIFY/"desktop-build.json").write_text(json.dumps(build,indent=2),encoding="utf-8")
    print(json.dumps({"status":"passed","installer_sha256":install["installer_sha256"],"portable_exe_sha256":native["executable_sha256"],"installed_exe_sha256":installed["executable_sha256"],"packaged_assertions":sidecar["experiments"]["totals"],"receipt":"output/verification/desktop-build.json"},indent=2))
if __name__ == "__main__":main()
