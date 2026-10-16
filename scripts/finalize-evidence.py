"""Finalize source identities and copy build proofs into the handoff evidence folder."""
from pathlib import Path
import hashlib
import json
import re
import shutil
import time

ROOT=Path(__file__).resolve().parents[1]
folder=ROOT/'output/verification'
receipt_path=folder/'verification.json'
receipt=json.loads(receipt_path.read_text(encoding='utf-8-sig'))
original=folder/'python-test-run.json'
if not original.exists():shutil.copy2(receipt_path,original)
python_run=json.loads(original.read_text(encoding='utf-8-sig'))
for relative,expected in python_run['source_sha256'].items():
    if relative.startswith(('backend/','tests/')):
        actual=hashlib.sha256((ROOT/relative).read_bytes()).hexdigest()
        if actual!=expected:raise SystemExit('Backend or tests changed after verification: '+relative)
current={}
for name in ('backend','src','tests'):
    for path in sorted((ROOT/name).rglob('*')):
        if path.is_file() and path.suffix in ('.py','.ts','.tsx','.css'):
            current[path.relative_to(ROOT).as_posix()]=hashlib.sha256(path.read_bytes()).hexdigest()
receipt['source_sha256']=current
test_count = re.search(r'Ran (\d+) tests? in ', (folder/'tests.txt').read_text(encoding='utf-8-sig'))
if not test_count:raise SystemExit('Missing unittest execution count')
receipt['unittest_count']=int(test_count.group(1))
receipt['python_test_source_sha256']={k:v for k,v in python_run['source_sha256'].items() if k.startswith(('backend/','tests/'))}
receipt['source_identity_refreshed_at']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
receipt['validation_provenance']={
    'python_test_execution':'python-test-run.json and tests.txt; backend/test identities unchanged',
    'frontend_build_and_browser_interactions':'frontend-qa.json; its limitations distinguish observed checks from source-only fixes',
    'native_app_and_installer':'desktop-native-smoke.json, desktop-install-smoke.json and desktop-installed-native-smoke.json identify the final bundled frontend separately from historical browser QA',
    'identity_note':'Refreshing the frontend identity is not an additional claim of test execution.'}
receipt_path.write_text(json.dumps(receipt,indent=2),encoding='utf-8')
for name in ('desktop-sidecar-smoke.json',):
    source=ROOT/'output'/name
    if source.exists():shutil.copy2(source,folder/name)
build=ROOT/'output/release/build-receipt.json'
desktop_proof=folder/'desktop-build.json'
if build.exists():
    if not desktop_proof.exists():shutil.copy2(build,desktop_proof)
    else:
        packaged=json.loads(build.read_text(encoding='utf-8-sig'))
        retained=json.loads(desktop_proof.read_text(encoding='utf-8-sig'))
        if retained['artifacts']!=packaged['artifacts']:raise SystemExit('Desktop proof identifies a different release')
# Full original-source/configuration identity, separate from dynamic experiment files.
manifest={}
for name in ('src','backend','tests','scripts','docs','public','src-tauri/src','.github'):
    for path in sorted((ROOT/name).rglob('*')):
        if path.is_file() and '__pycache__' not in path.parts:
            manifest[path.relative_to(ROOT).as_posix()]=hashlib.sha256(path.read_bytes()).hexdigest()
for name in ('README.md','LICENSE','package.json','package-lock.json','vite.config.ts','tsconfig.json','tsconfig.app.json','tsconfig.node.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json','src-tauri/PACKAGING.md'):
    path=ROOT/name
    if path.exists():manifest[name]=hashlib.sha256(path.read_bytes()).hexdigest()
(folder/'source-manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print(json.dumps({'source_files':len(manifest),'backend_test_source_identity':'unchanged','frontend_final_identity':'captured'},indent=2))
