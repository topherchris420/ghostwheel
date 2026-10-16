"""Optional task-local GNU resource tools. Supported releases use MSVC instead."""
from pathlib import Path
import hashlib, io, json, tarfile, urllib.request, shutil, subprocess
import zstandard
ROOT = Path(__file__).resolve().parents[1]
PACKAGES = [
("libwinpthread-14.0.0.r426.g4564ee4b5-2", "ac791deaf730ef7aa6fa66f31ce6ec53a02c43fa85562233a981c84c93456760"),
("gcc-16.2.0-6", "f9a78b7f257984bc8a2b62d5f93f1af45b03d4b84afaf2eafc7d90c9b8c4568e"),
("gmp-6.3.0-2", "8924433974c4add46cb46ea4f6ef283b5c5139d3f552375115b5580f855015cc"),
("isl-0.28-1", "03ed191718a89edc46e783deed46b8fd20ec47a09fcdefb37c6c4169b6188b08"),
("mpc-1.4.1-1", "ce024a90d59c8a591d2c88ef94a386c6367750bf9edc6a944e80815ec5d93344"),
("mpfr-4.2.2-3", "9ecbc05f1f855bc656a8f111d367f61fbd90dbbfcf469ba74d6d5dd1ec07a542"),
("libgcc-16.2.0-6", "e0815432c4225892b0eef57055fe507fa0b9a036436f046605f6629696bd1b88"),
("libstdc++-16.2.0-6", "924b47e8c3e20b6448e29d3333acc638a4f4783c1c45230e09673532f9c4f198"),
("binutils-2.47-3", "827363748ce3320683319d860ee4fcfcdbb36baf66aac6dab0ec3822be2d4ff7"),
("gettext-runtime-1.0-1", "be68d7f260633284b910c588c6d82ee304a81c8817a686d2cd9df83f872c27af"),
("zlib-1.3.2-2", "9e75842a070ba648e986e12424e1c92c9d7d77200e85f6a34eeb600819f2e694"),
("zstd-1.5.7-2", "1add6705b344664f6aca108c85f79ab5bdd9e1162662bb06a4cf40a34f6e0907"),
("libiconv-1.19-1", "21e334d0911f25de75d3e18e0697648bcecfa9658256d600cad0827d719c2f35"),
]
folder = ROOT / ".build" / "binutils"
folder.mkdir(parents=True, exist_ok=True)
receipts = []
for name, expected in PACKAGES:
    filename = f"mingw-w64-x86_64-{name}-any.pkg.tar.zst"
    url = "https://repo.msys2.org/mingw/mingw64/" + filename
    archive = ROOT / ".build" / filename
    if name.startswith("binutils") and (ROOT / ".build" / "binutils.pkg.tar.zst").exists():
        archive = ROOT / ".build" / "binutils.pkg.tar.zst"
    if not archive.exists():
        print("Download", filename, flush=True)
        with urllib.request.urlopen(url, timeout=60) as response:
            archive.write_bytes(response.read())
    raw = archive.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != expected:
        raise SystemExit(f"Checksum mismatch for {filename}: {digest}")
    with zstandard.ZstdDecompressor().stream_reader(io.BytesIO(raw)) as decompressed:
        with tarfile.open(fileobj=io.BytesIO(decompressed.read()), mode="r:") as tar:
            tar.extractall(folder, members=[m for m in tar.getmembers() if m.isfile() or not (folder / m.name).exists()], filter="data")
    receipts.append({"url":url, "sha256":digest, "bytes":len(raw)})
(folder / "download-receipts.json").write_text(json.dumps(receipts,indent=2),encoding="utf-8")
print(folder / "mingw64" / "bin")
