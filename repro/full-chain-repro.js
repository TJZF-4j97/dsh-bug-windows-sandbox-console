#!/usr/bin/env node
// Drives the shipped Windows sandbox chain exactly as the Harness does:
//
//   harness -> dsh-subprocess-local runner (isolated stdio: fd 3 ipc, fd 4 stdin
//              carrier, fd 5/6 target stdio, fd 7 control) -> ACL sandbox runner
//              -> confined child
//
// and reports the confined child's exit code.
//
// usage:
//   node full-chain-repro.js \
//     --sub-runner <dsh-subprocess-local/lib/runner.js> \
//     --acl-runner <dsh-sandbox-windows-acl/lib/runner.js> \
//     --workspace  <dir> --temp <dir> \
//     [--mode read-only|workspace-write] \
//     [--host node|electron] [--electron <DeepSeek Harness.exe>] \
//     [--import-shim <url-or-path>] \
//     [--control 0|1] [--env full|minimal] [--write-sid <S-1-4-…>] [--temp-write-sid <S-1-4-…>] \
//     -- <child.exe> [args...]
//
// Exit codes: the process exits with the confined child's exit code when the
// chain reports one, otherwise 1. 3221225794 = 0xC0000142 STATUS_DLL_INIT_FAILED.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require_ = createRequire(import.meta.url);
const argv = process.argv.slice(2);

function option(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (argv.includes('--help') || argv.length === 0) {
  console.log(require_('node:fs').readFileSync(process.argv[1], 'utf8').split('\n').slice(1, 21).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(0);
}

const sep = argv.indexOf('--');
if (sep < 0) {
  console.error('missing "--" before the child command');
  process.exit(2);
}
const childArgv = argv.slice(sep + 1);
if (childArgv.length === 0) {
  console.error('missing child command after "--"');
  process.exit(2);
}

const subRunner = option('--sub-runner');
const aclRunner = option('--acl-runner');
const workspace = option('--workspace');
const temp = option('--temp');
const mode = option('--mode') ?? 'read-only';
const host = option('--host') ?? 'node';
const electronPath = option('--electron');
const importShim = option('--import-shim');
const control = (option('--control') ?? '1') !== '0';
const envMode = option('--env') ?? 'full';
const writeSid = option('--write-sid');
const tempWriteSid = option('--temp-write-sid');

for (const [name, value] of [
  ['--sub-runner', subRunner],
  ['--acl-runner', aclRunner],
  ['--workspace', workspace],
  ['--temp', temp],
]) {
  if (!value) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  if (!existsSync(value)) {
    console.error(`${name} does not exist: ${value}`);
    process.exit(2);
  }
}
if (host === 'electron' && !electronPath) {
  console.error('--host electron requires --electron <path to DeepSeek Harness.exe>');
  process.exit(2);
}

const nodeExe = process.execPath;
const targetHost = host === 'electron' ? electronPath : nodeExe;

// The argv the sandbox seam would hand to the subprocess runner.
const targetArgv = [
  targetHost,
  ...(importShim ? ['--import', importShim] : []),
  aclRunner,
  '--workspace', workspace,
  '--temp', temp,
  '--mode', mode,
  ...(writeSid ? ['--write-sid', writeSid] : []),
  ...(tempWriteSid ? ['--temp-write-sid', tempWriteSid] : []),
  '--',
  ...childArgv,
];

// Isolated runner stdio: fd 3 ipc, fd 4 stdin carrier, fd 5/6 target stdio, [fd 7 control].
const stdio = ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe', 'pipe'];
if (control) stdio.push('overlapped');

const runnerEnv = { ...process.env, DSH_SUBPROCESS_RUNNER: 'windows' };
delete runnerEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(nodeExe, [subRunner, '--', ...targetArgv], {
  stdio,
  env: runnerEnv,
  windowsHide: true,
});

let stdout = '';
let stderr = '';
let message = null;
child.stdio[5].on('data', (d) => { stdout += d.toString(); });
child.stdio[6].on('data', (d) => { stderr += d.toString(); });
child.on('message', (m) => { message = m; });
child.on('error', (e) => { stderr += 'SPAWN_ERROR ' + e.message; });

const requestEnv = envMode === 'minimal'
  ? {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    }
  : { ...process.env };
delete requestEnv.ELECTRON_RUN_AS_NODE;
delete requestEnv.DSH_SUBPROCESS_RUNNER;
if (host === 'electron') requestEnv.ELECTRON_RUN_AS_NODE = '1';

child.send({
  type: 'start',
  cwd: process.cwd(),
  env: requestEnv,
  ...(control ? { control: 'pipe' } : {}),
});

const timer = setTimeout(() => child.kill(), 120_000);

child.on('exit', (code) => {
  clearTimeout(timer);
  const report = {
    host,
    mode,
    control,
    env: envMode,
    importShim: importShim ?? null,
    runnerExit: code,
    childExit: message && typeof message.exitCode === 'number' ? message.exitCode : null,
    childExitHex:
      message && typeof message.exitCode === 'number'
        ? '0x' + (message.exitCode >>> 0).toString(16).toUpperCase()
        : null,
    message,
    childStdout: stdout.trim(),
    childStderr: stderr.trim(),
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(typeof report.childExit === 'number' ? report.childExit : 1);
});
