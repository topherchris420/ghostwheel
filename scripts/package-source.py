"""Create a bounded source/evidence handoff; omit third-party binaries and build caches."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'output/release'
OUT.mkdir(parents=True,exist_ok=True)
DEST=OUT/'GHOSTWHEEL-GW01-Source-and-Evidence.zip'
roots=['README.md','LICENSE','.gitignore','package.json','package-lock.json','index.html',
       'tsconfig.json','tsconfig.app.json','tsconfig.node.json','vite.config.ts',
       'src','public','backend','tests','scripts','docs','src-tauri','.github',
       'evidence/source-ledger.json','evidence/rea-summary.json','evidence/rea-ovms-package.json',
       'evidence/README.md','evidence/source-snapshots','output/pdf','output/verification']
excluded={'node_modules','.build','target','gen','__pycache__','.git'}
files=set()
for name in roots:
    path=ROOT/name
    if path.is_file():files.add(path)
    elif path.is_dir():
        for item in path.rglob('*'):
            rel=item.relative_to(ROOT)
            if item.is_file() and not any(part in excluded for part in rel.parts) and item.suffix not in ('.exe','.pyc','.dll'):
                files.add(item)
for folder in (ROOT/'output/experiments').glob('seed-*'):
    for name in ('results.json','experiments.sqlite3'):
        path=folder/name
        if path.is_file():files.add(path)
manifest={p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}
with zipfile.ZipFile(DEST,'w',zipfile.ZIP_DEFLATED,compresslevel=8) as bundle:
    for p in sorted(files):bundle.write(p,'GHOSTWHEEL-GW01/'+p.relative_to(ROOT).as_posix())
    bundle.writestr('GHOSTWHEEL-GW01/HANDOFF-MANIFEST.json',json.dumps(manifest,indent=2))
print(json.dumps({'path':str(DEST),'files':len(files),'bytes':DEST.stat().st_size,'sha256':hashlib.sha256(DEST.read_bytes()).hexdigest()},indent=2))
