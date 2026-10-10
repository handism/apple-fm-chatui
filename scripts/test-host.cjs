const { runTests } = require('@vscode/test-electron');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const directory = mkdtempSync(path.join(tmpdir(), 'local-fm-host-'));
runTests({
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
  extensionDevelopmentPath: path.resolve(__dirname, '..'),
  extensionTestsPath: path.resolve(__dirname, '../test/host.cjs'),
  launchArgs: ['--user-data-dir', path.join(directory, 'user'), '--extensions-dir', path.join(directory, 'extensions'), '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust']
}).catch(error => { console.error(error); process.exitCode = 1; });
