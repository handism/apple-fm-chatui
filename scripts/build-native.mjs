import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Apple Silicon Macでビルドしてください。');
mkdirSync('bin', { recursive: true });
mkdirSync('.build/module-cache', { recursive: true });
// Prefer the independently installed Command Line Tools; never change xcode-select globally.
const env = { ...process.env };
if (!env.DEVELOPER_DIR && existsSync('/Library/Developer/CommandLineTools')) env.DEVELOPER_DIR = '/Library/Developer/CommandLineTools';
const sdk = spawnSync('/usr/bin/xcrun', ['--show-sdk-path'], { env, encoding: 'utf8' });
if (sdk.status !== 0) throw new Error(sdk.stderr);
const sdkVersion = spawnSync('/usr/bin/xcrun', ['--show-sdk-version'], { env, encoding: 'utf8' });
const imageFlags = Number(sdkVersion.stdout.trim().split('.')[0]) >= 27 ? ['-D', 'IMAGE_INPUT'] : [];
console.log(imageFlags.length ? '画像入力対応ビルド (SDK 27+)' : 'テキスト専用ビルド (画像入力にはSDK 27+が必要)');
const result = spawnSync('/usr/bin/xcrun', ['swiftc', ...imageFlags, '-module-cache-path', '.build/module-cache', '-parse-as-library', '-O', '-target', 'arm64-apple-macosx26.0', '-sdk', sdk.stdout.trim(), 'native/LocalFM.swift', '-o', 'bin/local-fm'], { env, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
const sign = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', 'bin/local-fm'], { stdio: 'inherit' });
if (sign.status !== 0) process.exit(sign.status || 1);
