#!/usr/bin/env node
// Reports whether the calling process has a console.
//
// usage: node console-probe.cjs [--host node|electron] [--electron <path>] [--koffi <path>]
//
// --host electron re-executes this file with the given Electron binary and
// ELECTRON_RUN_AS_NODE=1, so both hosts can be compared from one command.
'use strict';

const { spawnSync } = require('node:child_process');

const argv = process.argv.slice(2);

function option(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const host = option('--host') || 'node';
const electronPath = option('--electron');
const koffiPath = option('--koffi');

if (host === 'electron') {
  if (!electronPath) {
    console.error('--host electron requires --electron <path to DeepSeek Harness.exe>');
    process.exit(2);
  }
  const forwarded = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host') {
      i++; // drop --host <value>
      continue;
    }
    if (argv[i] === '--electron') {
      i++; // the Electron path is implicit in the re-exec
      continue;
    }
    forwarded.push(argv[i]);
  }
  const result = spawnSync(electronPath, [__filename, ...forwarded], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  process.exit(result.status === null ? 1 : result.status);
}

function loadKoffi() {
  try {
    return require('koffi');
  } catch {
    /* fall through */
  }
  if (koffiPath) {
    try {
      return require(koffiPath);
    } catch {
      /* fall through */
    }
  }
  const resources = process.resourcesPath;
  if (resources) {
    try {
      return require(resources + '/app.asar/dsh/node_modules/koffi');
    } catch {
      /* fall through */
    }
  }
  return undefined;
}

const koffi = loadKoffi();
if (koffi === undefined) {
  console.error('koffi is not available; install it or pass --koffi <path to the koffi module>');
  process.exit(3);
}

const kernel32 = koffi.load('kernel32.dll');
const GetConsoleWindow = kernel32.func('void *GetConsoleWindow()');
const GetConsoleProcessList = kernel32.func('uint32 GetConsoleProcessList(uint32 *list, uint32 count)');

const hwnd = GetConsoleWindow();
const buffer = new Uint32Array(64);
let count = 0;
try {
  count = GetConsoleProcessList(buffer, 64);
} catch {
  count = -1;
}

console.log(
  JSON.stringify(
    {
      exe: process.execPath.split('\\').pop(),
      pid: process.pid,
      consoleHwnd: hwnd ? String(hwnd) : '0',
      hasConsole: Boolean(hwnd) && String(hwnd) !== '0',
      consolePids: Array.from(buffer.slice(0, Math.max(0, count))),
      stdoutIsTTY: Boolean(process.stdout && process.stdout.isTTY),
    },
    null,
    2,
  ),
);
