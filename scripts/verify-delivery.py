"""Verify the final handoff identities and write a combined delivery manifest."""
from pathlib import Path
import hashlib
import json
import os
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / 'output/release'
PROOF = ROOT / 'output/verification'

def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

build = read(RELEASE / 'build-receipt.json')
assert build['status'] == 'built'
artifacts = []
for entry in build['artifacts']:
    path = RELEASE / entry['file']
    assert path.stat().st_size == entry['bytes'], path
    assert digest(path) == entry['sha256'], path
    artifacts.append({'file': path.relative_to(ROOT).as_posix(), 'bytes': path.stat().st_size, 'sha256': digest(path)})
for name, expected in build['sources'].items():
    assert digest(ROOT/name) == expected, f'Build source changed: {name}'
for name, expected in read(PROOF/'source-manifest.json').items():
    assert digest(ROOT/name) == expected, f'Handoff source changed: {name}'

native = read(PROOF/'desktop-native-smoke.json')
installed = read(PROOF/'desktop-installed-native-smoke.json')
installation = read(PROOF/'desktop-install-smoke.json')
assert all(item['status'] == 'passed' for item in (native, installed, installation))
assert native['executable_sha256'] == digest(RELEASE/'portable/ghostwheel.exe')
assert installation['installer_sha256'] == digest(RELEASE/'GHOSTWHEEL_0.1.0_x64-setup.exe')
installed_identity = next(item for item in installation['installed'] if item['file']=='ghostwheel.exe')
assert installed['executable_sha256'] == installed_identity['sha256'] == installed_identity['expected_installed_sha256']
assert all(item['matches_release'] for item in installation['installed'])
assert native['backend_stopped'] and installed['backend_stopped']

verification = read(PROOF/'verification.json')
assert verification['test_exit_code'] == 0 and verification['unittest_count'] == 22
assert sum(item['totals']['passed'] for item in verification['experiment_suites']) == 198
assert all(item['totals']['failed'] == 0 for item in verification['experiment_suites'])

archive_path = RELEASE/'GHOSTWHEEL-GW01-Source-and-Evidence.zip'
with zipfile.ZipFile(archive_path) as archive:
    assert archive.testzip() is None
    manifest = json.loads(archive.read('GHOSTWHEEL-GW01/HANDOFF-MANIFEST.json'))
    assert len(archive.namelist()) == len(manifest)+1
    for relative, expected in manifest.items():
        path = Path(relative)
        assert not any(part in {'node_modules','.build','target','.git','__pycache__'} for part in path.parts)
        assert path.suffix.lower() not in {'.exe','.dll','.apk','.pyc'}
        assert hashlib.sha256(archive.read('GHOSTWHEEL-GW01/'+relative)).hexdigest() == expected, relative
        assert digest(ROOT/relative) == expected, f'Archive source changed: {relative}'

report_path = ROOT/'output/pdf/GHOSTWHEEL-GW01-Technical-Report.pdf'
report_proof = read(PROOF/'report-qa.json')
assert report_proof['sha256'] == digest(report_path) and report_proof['pages'] == 12
for path in (archive_path, report_path):
    artifacts.append({'file':path.relative_to(ROOT).as_posix(),'bytes':path.stat().st_size,'sha256':digest(path)})
result = {
    'status':'verified',
    'generated_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
    'artifacts':artifacts,
    'validation':{'unittest_methods':22,'seeded_experiment_assertions':198,'native_app':'passed','installed_app':'passed','source_archive_files':len(manifest),'report_pages':12},
    'limits':['Unsigned GNU compatibility build; supported MSVC CI recipe unexecuted','CARLA SDK and adapter included; full running-server driving unvalidated','REA static package inventory completed; OVMS firmware decompilation unavailable','All actuation stays in simulation; no production vehicle connector']
}
(RELEASE/'DELIVERY-MANIFEST.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
checksums = [f"{item['sha256']}  {os.path.relpath(ROOT/item['file'],RELEASE).replace(chr(92),'/')}" for item in artifacts]
(RELEASE/'SHA256SUMS').write_text('\n'.join(checksums)+'\n',encoding='utf-8')
print(json.dumps({'status':result['status'],'artifacts':len(artifacts),'archive_files':len(manifest),'validation':result['validation']},indent=2))
