"""Collect a built NSIS installer and complete portable application with receipts."""
import argparse, datetime, hashlib, importlib.metadata, json, platform, shutil, subprocess, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def main():
    parser=argparse.ArgumentParser();parser.add_argument("--target",default="x86_64-pc-windows-msvc");args=parser.parse_args()
    target=ROOT/"src-tauri"/"target"/args.target/"release"
    installers=list((target/"bundle"/"nsis").glob("*-setup.exe"))
    if not installers:raise SystemExit("No built NSIS installer exists.")
    output=ROOT/"output"/"release";output.mkdir(parents=True,exist_ok=True)
    portable=output/"portable";portable.mkdir(exist_ok=True)
    shutil.copy2(target/"ghostwheel.exe",portable/"ghostwheel.exe")
    shutil.copy2(ROOT/"src-tauri"/"binaries"/f"ghostwheel-backend-{args.target}.exe",portable/"ghostwheel-backend.exe")
    if args.target.endswith("-gnu"):shutil.copy2(ROOT/"src-tauri"/"resources"/"WebView2Loader.dll",portable/"WebView2Loader.dll")
    for installer in installers:shutil.copy2(installer,output/installer.name)
    archive=Path(shutil.make_archive(str(output/"GHOSTWHEEL_0.1.0_x64-portable"),"zip",portable))
    files=[output/p.name for p in installers]+[archive]+list(portable.iterdir())
    artifacts=[{"file":p.relative_to(output).as_posix(),"bytes":p.stat().st_size,"sha256":digest(p)} for p in files if p.is_file()]
    sources=[*sorted((ROOT/"backend"/"ghostwheel").glob("*.py")),ROOT/"src-tauri"/"src"/"main.rs",ROOT/"src-tauri"/"Cargo.lock",ROOT/"src-tauri"/"tauri.conf.json",ROOT/"package-lock.json",*sorted(p for p in (ROOT/"src").rglob("*") if p.is_file()),*sorted(p for p in (ROOT/"dist").rglob("*") if p.is_file())]
    receipt={"status":"built","built_at_utc":datetime.datetime.now(datetime.timezone.utc).isoformat(),"tool_versions":{"rust":subprocess.check_output([str(Path.home()/".cargo"/"bin"/"rustc.exe"),"--version"],text=True).strip(),"node":subprocess.check_output(["node","--version"],text=True).strip(),"pyinstaller":importlib.metadata.version("pyinstaller"),"carla_python_client":importlib.metadata.version("carla")},"version":"0.1.0","target":args.target,"signed":False,"officially_supported_target":"x86_64-pc-windows-msvc","gnu_compatibility_build":args.target.endswith("-gnu"),"python":sys.version,"os":platform.platform(),"artifacts":artifacts,"sources":{p.relative_to(ROOT).as_posix():digest(p) for p in sources},"limitations":["Unsigned research application","CARLA client bundled; simulator server separately installed and not exercised on this host","GNU target is a local compatibility build; supported MSVC release recipe is in Windows CI" if args.target.endswith("-gnu") else "MSVC build"]}
    (output/"SHA256SUMS").write_text("".join(f"{a['sha256']}  {a['file']}\n" for a in artifacts),encoding="utf-8")
    (output/"build-receipt.json").write_text(json.dumps(receipt,indent=2),encoding="utf-8")
    verification=ROOT/"output"/"verification";verification.mkdir(exist_ok=True)
    (verification/"desktop-build.json").write_text(json.dumps(receipt,indent=2),encoding="utf-8")
    print(json.dumps({"status":"built","folder":str(output),"artifacts":artifacts},indent=2))
if __name__ == "__main__":main()
