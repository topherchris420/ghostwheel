import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cargoBin = path.join(process.env.USERPROFILE || '', '.cargo', 'bin');
const localGnu = path.join(root, '.build', 'binutils', 'mingw64', 'bin');
const env = { ...process.env, PATH: `${cargoBin}${path.delimiter}${localGnu}${path.delimiter}${process.env.PATH || ''}` };
if (process.env.GHOSTWHEEL_RUST_TOOLCHAIN) env.RUSTUP_TOOLCHAIN = process.env.GHOSTWHEEL_RUST_TOOLCHAIN;
const [mode = 'dev', ...extra] = process.argv.slice(2);
if (!['dev', 'build'].includes(mode)) throw new Error('Use desktop.mjs dev or build.');
if (process.platform !== 'win32') throw new Error('This release recipe builds the Windows application on Windows.');
function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: root, env, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
const targetAt = extra.indexOf('--target');
const target = targetAt >= 0 ? extra[targetAt + 1] : (process.env.GHOSTWHEEL_TARGET || 'x86_64-pc-windows-msvc');
if (target === 'x86_64-pc-windows-gnu') {
  const sysroot = spawnSync(path.join(cargoBin, 'rustc.exe'), ['--print', 'sysroot'], { env, encoding: 'utf8', shell: false }).stdout?.trim();
  const linker = path.join(sysroot || '', 'lib', 'rustlib', target, 'bin', 'self-contained', 'x86_64-w64-mingw32-gcc.exe');
  if (existsSync(linker)) env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = linker;
}

const python = process.env.GHOSTWHEEL_PYTHON || (existsSync(path.join(root, '.build', 'pyenv', 'Scripts', 'python.exe')) ? path.join(root, '.build', 'pyenv', 'Scripts', 'python.exe') : 'python');
if (mode === 'build') run(python, ['scripts/build-sidecar.py', '--target', target]);
// Development also uses a frozen sidecar because Tauri validates externalBin.
const sidecar = path.join(root, 'src-tauri', 'binaries', `ghostwheel-backend-${target}.exe`);
if (!existsSync(sidecar)) run(python, ['scripts/build-sidecar.py', '--target', target]);
const extraConfig = [];
if (target === 'x86_64-pc-windows-gnu') {
  // GNU links Microsoft's dynamic WebView2 loader; MSVC links it statically.
  const lock = readFileSync(path.join(root, 'src-tauri', 'Cargo.lock'), 'utf8');
  const version = lock.match(/name = "webview2-com-sys"\r?\nversion = "([^"]+)"/)?.[1];
  if (!version) throw new Error('Cargo.lock must pin webview2-com-sys before a GNU build.');
  const registry = path.join(process.env.CARGO_HOME || path.join(process.env.USERPROFILE || '', '.cargo'), 'registry', 'src');
  const loaders = readdirSync(registry).map(folder => path.join(registry, folder, `webview2-com-sys-${version}`, 'x64', 'WebView2Loader.dll')).filter(existsSync);
  if (loaders.length !== 1) throw new Error('Cannot identify the locked Microsoft WebView2 loader for GNU build.');
  const resources = path.join(root, 'src-tauri', 'resources');
  mkdirSync(resources, { recursive: true });
  copyFileSync(loaders[0], path.join(resources, 'WebView2Loader.dll'));
  const config = path.join(root, '.build', 'tauri-gnu.json');
  mkdirSync(path.dirname(config), { recursive: true });
  writeFileSync(config, JSON.stringify({bundle:{resources:{'resources/WebView2Loader.dll':'WebView2Loader.dll'}}}));
  extraConfig.push('--config', config);
}
const cli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
if (!existsSync(cli)) throw new Error('Run npm ci first to install the pinned Tauri CLI.');
run(process.execPath, [cli, mode, ...(targetAt >= 0 ? extra : ['--target', target, ...extra]), ...extraConfig]);
if (mode === 'build') run(python, ['scripts/build-release.py', '--target', target]);
