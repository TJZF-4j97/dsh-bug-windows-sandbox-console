// Preloaded (via --import) into the Windows ACL sandbox runner process only.
//
// The file name is historical: 0.1.x used it purely for the console remedy. Since 0.2.0 the
// primary mechanism is the Default-DACL merge below, and the console path is only a fallback.
//
// PRIMARY FIX — restore the Default DACL the runner's restricted token is derived from.
// -----------------------------------------------------------------------------------
// The restricted child dies in DLL initialization with 0xC0000142 in `workspace-write`
// when the runner owns no console, because the child must create a console of its own and
// the restricted token's Default DACL cannot authorize it. The shipped runner merges ONE
// full-access ACE into that Default DACL — `tempWriteSidPtr ?? writeSidPtr ?? worldSid` —
// so `read-only` lands `Everyone` and `workspace-write` lands the capability write SID.
// The Default DACL is inherited from THIS process's token, so merging `Everyone` here,
// before the runner derives the restricted token, restores exactly what `read-only` gets.
// Measured: the child starts (`childExit 0`), writes outside the workspace are still
// denied and absent, and the console it creates stays hidden.
//
// FALLBACK — give the runner a console.
// ------------------------------------
// If the Default-DACL merge cannot be applied, the original remedy is used instead: save
// the three standard handles, AllocConsole(), restore them and hide the window. An
// already-existing console is left untouched.
//
// It deliberately does nothing else: no file access, no process creation, no environment
// change, no restriction/token-SID work. Any failure is swallowed so the runner keeps its
// shipped behaviour.
import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';

const require_ = createRequire(import.meta.url);

const TOKEN_QUERY = 0x0008;
const TOKEN_ADJUST_DEFAULT = 0x0080;
const TOKEN_DEFAULT_DACL = 6;
const FILE_ALL_ACCESS = 0x001f01ff;
const GRANT_ACCESS = 1;
const TRUSTEE_IS_SID = 0;
const TRUSTEE_IS_WELL_KNOWN_GROUP = 5;
const EXPLICIT_ACCESS_SIZE = 48; // matches the runner's own entries.length / 48
const EVERYONE_SID = 'S-1-1-0';

const STD_INPUT_HANDLE = -10;
const STD_OUTPUT_HANDLE = -11;
const STD_ERROR_HANDLE = -12;
const STANDARD_HANDLES = [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE];
const SW_HIDE = 0;

/** koffi from the profile, else the copy bundled inside the running Harness. */
function loadKoffi() {
  try {
    return require_('koffi');
  } catch {
    /* fall through to the bundled copy */
  }
  const resources = process.resourcesPath;
  if (!resources) return undefined;
  const bundled = resources + '/app.asar/dsh/node_modules/koffi';
  try {
    return existsSync(bundled) ? require_(bundled) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merge an `Everyone` full-access ACE into this process token's Default DACL.
 * @returns true when the token now carries it.
 */
function mergeEveryoneIntoDefaultDacl(koffi) {
  const advapi = koffi.load('advapi32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const GetCurrentProcess = kernel32.func('void *GetCurrentProcess()');
  const OpenProcessToken = advapi.func('bool OpenProcessToken(void *h, uint32 acc, void *pToken)');
  const GetTokenInformation = advapi.func('bool GetTokenInformation(void *t, int cls, void *info, uint32 len, void *pRet)');
  const SetTokenInformation = advapi.func('bool SetTokenInformation(void *t, int cls, void *info, uint32 len)');
  const ConvertStringSidToSidW = advapi.func('bool ConvertStringSidToSidW(str16 s, void *pSid)');
  const SetEntriesInAclW = advapi.func('uint32 SetEntriesInAclW(uint32 n, void *entries, void *oldAcl, void *pNewAcl)');

  const tokenSlot = Buffer.alloc(8);
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, tokenSlot)) return false;
  const token = koffi.decode(tokenSlot, 'void *');
  if (!token) return false;

  const returned = Buffer.alloc(4);
  GetTokenInformation(token, TOKEN_DEFAULT_DACL, null, 0, returned);
  const needed = returned.readUInt32LE(0);
  if (!needed) return false;
  const info = Buffer.alloc(needed);
  if (!GetTokenInformation(token, TOKEN_DEFAULT_DACL, info, needed, returned)) return false;
  const currentDacl = koffi.decode(info, 'void *');
  if (!currentDacl) return false;

  const before = Buffer.from(koffi.decode(currentDacl, 'uint8', 6)).readUInt16LE(4);

  const sidSlot = Buffer.alloc(8);
  if (!ConvertStringSidToSidW(EVERYONE_SID, sidSlot)) return false;
  const sid = koffi.decode(sidSlot, 'void *');
  if (!sid) return false;

  const explicitAccess = Buffer.alloc(EXPLICIT_ACCESS_SIZE);
  explicitAccess.writeUInt32LE(FILE_ALL_ACCESS, 0);
  explicitAccess.writeInt32LE(GRANT_ACCESS, 4);
  explicitAccess.writeInt32LE(TRUSTEE_IS_SID, 28);
  explicitAccess.writeInt32LE(TRUSTEE_IS_WELL_KNOWN_GROUP, 32);
  explicitAccess.writeBigUInt64LE(BigInt(sid), 40);

  const newAclSlot = Buffer.alloc(8);
  if (SetEntriesInAclW(1, explicitAccess, currentDacl, newAclSlot) !== 0) return false;
  const newAcl = koffi.decode(newAclSlot, 'void *');
  if (!newAcl) return false;

  const writeBack = Buffer.alloc(8);
  writeBack.writeBigUInt64LE(BigInt(newAcl), 0);
  if (!SetTokenInformation(token, TOKEN_DEFAULT_DACL, writeBack, 8)) return false;

  // Sanity re-read: the merged Default DACL must not have lost entries.
  const again = Buffer.alloc(4);
  GetTokenInformation(token, TOKEN_DEFAULT_DACL, null, 0, again);
  const needed2 = again.readUInt32LE(0);
  if (!needed2) return false;
  const info2 = Buffer.alloc(needed2);
  if (!GetTokenInformation(token, TOKEN_DEFAULT_DACL, info2, needed2, again)) return false;
  const aclPtr = koffi.decode(info2, 'void *');
  if (!aclPtr) return false;
  const after = Buffer.from(koffi.decode(aclPtr, 'uint8', 6)).readUInt16LE(4);
  return after >= before;
}

/** Fallback: make sure the runner process owns a console (hidden). */
function ensureRunnerConsole(koffi) {
  const kernel32 = koffi.load('kernel32.dll');
  const user32 = koffi.load('user32.dll');
  const GetConsoleWindow = kernel32.func('void *GetConsoleWindow()');
  const AllocConsole = kernel32.func('int AllocConsole()');
  const GetStdHandle = kernel32.func('void *GetStdHandle(int n)');
  const SetStdHandle = kernel32.func('int SetStdHandle(int n, void *h)');
  const ShowWindow = user32.func('int ShowWindow(void *hWnd, int nCmdShow)');
  if (GetConsoleWindow()) return;
  const saved = STANDARD_HANDLES.map((n) => [n, GetStdHandle(n)]);
  AllocConsole();
  for (const [n, handle] of saved) {
    if (handle) SetStdHandle(n, handle);
  }
  const created = GetConsoleWindow();
  if (created) ShowWindow(created, SW_HIDE);
}

const dbg = (m) => { if (process.env.DSH_SANDBOX_CONSOLE_FIX_DEBUG) { try { writeFileSync(process.env.DSH_SANDBOX_CONSOLE_FIX_DEBUG, String(m)); } catch { /* ignore */ } } };
try {
  dbg('entered');
  const koffi = loadKoffi();
  const merged = koffi !== undefined && mergeEveryoneIntoDefaultDacl(koffi);
  if (koffi !== undefined && !merged) {
    ensureRunnerConsole(koffi);
  }
  if (process.env.DSH_SANDBOX_CONSOLE_FIX_DEBUG) {
    try {
      writeFileSync(process.env.DSH_SANDBOX_CONSOLE_FIX_DEBUG, 'path=' + (merged ? 'default-dacl' : 'console-fallback'));
    } catch {
      /* diagnostics only */
    }
  }
} catch (error) {
  dbg('exception: ' + (error && error.message ? error.message : String(error)));
  // No shim available: the runner keeps its shipped behaviour.
}



