#!/usr/bin/env node
// Minimal Electron-asar reader: list or extract entries whose path matches a regex.
//
// The packaged Harness keeps its sandbox runner inside app.asar, which plain node
// cannot import. Extract the packages the reproduction scripts need:
//
//   node extract-asar.cjs "<…>/DeepSeek Harness/resources/app.asar" ./vendor \
//     "dsh-(sandbox-windows-acl|subprocess|subprocess-local|win32-process|lazy-require|skill|subprocess)/|/yaml/|/koffi/"
//
// usage: node extract-asar.cjs <archive.asar> <outDir> <regex|--list>
'use strict';

const { closeSync, mkdirSync, openSync, readSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const asarPath = process.argv[2];
const outDir = process.argv[3];
const arg = process.argv[4] || '--list';

if (!asarPath || !outDir) {
  console.error('usage: node extract-asar.cjs <archive.asar> <outDir> <regex|--list>');
  process.exit(2);
}

const listMode = arg === '--list';
const matcher = listMode ? null : new RegExp(arg);

const fd = openSync(asarPath, 'r');
try {
  const probe = Buffer.alloc(64);
  readSync(fd, probe, 0, probe.length, 0);
  const jsonStart = probe.indexOf(0x7b); // '{'
  if (jsonStart < 0) throw new Error('asar header not found');

  const chunk = Buffer.alloc(16 * 1024 * 1024);
  const read = readSync(fd, chunk, 0, chunk.length, jsonStart);

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = 0; i < read; i++) {
    const byte = chunk[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;
      else if (byte === 0x22) inString = false;
    } else if (byte === 0x22) inString = true;
    else if (byte === 0x7b) depth++;
    else if (byte === 0x7d) {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error('asar header parse failed');

  const header = JSON.parse(chunk.toString('utf8', 0, end));
  let dataOffset = jsonStart + end;
  if (dataOffset % 4 !== 0) dataOffset += 4 - (dataOffset % 4);

  const entries = [];
  const walk = (node, prefix) => {
    for (const [key, child] of Object.entries(node.files || {})) {
      const path = prefix + '/' + key;
      if (child.files) walk(child, path);
      else if (!child.unpacked) entries.push({ path, child });
    }
  };
  walk(header, '');

  let listed = 0;
  let extracted = 0;
  for (const { path, child } of entries) {
    if (listMode) {
      console.log(path);
      listed++;
      continue;
    }
    if (!matcher.test(path)) continue;
    const size = Number(child.size);
    const offset = Number(child.offset);
    const data = Buffer.alloc(size);
    readSync(fd, data, 0, size, dataOffset + offset);
    const destination = join(outDir, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, data);
    extracted++;
  }
  console.error(listMode ? `listed=${listed} total=${entries.length}` : `extracted=${extracted}`);

  if (!listMode) {
    console.error('');
    console.error('NOTE: native modules (e.g. koffi.node) are stored outside the archive.');
    console.error('Overlay them over the extraction from:');
    console.error('  <install>/resources/app.asar.unpacked');
  }
} finally {
  closeSync(fd);
}
