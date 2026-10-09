# Windows desktop app — `workspace-write` shell calls die with `0xC0000142` (ACL sandbox runner has no console)

**Component:** `@deepseek-ai/dsh-sandbox-local` (`windowsAclRunnerInvocation`) ·
`@deepseek-ai/dsh-sandbox-windows-acl` · `@deepseek-ai/dsh-win32-process`
**Version:** DeepSeek Harness desktop `0.2.0-rc.2`
**Severity:** the `workspace-write` sandbox is unusable on Windows desktop — sessions are pushed to `danger-full-access`
**Labels:** `bug`, `platform:windows`, `area:sandbox`, `area:shell`

> **Posted upstream as a Discussion:**
> <https://github.com/deepseek-ai/deepseek-harness/discussions/9280> — category `General`, 2026-10-09.
> `deepseek-ai/deepseek-harness` keeps Issues disabled and routes bug reports to Discussions, so this
> file is the issue-formatted twin of the posted text ([`DISCUSSION.md`](DISCUSSION.md)).
> # ⚠️ NOT REVIEWED BY ANY HUMAN
>
> **AI-generated report.** This bug was found, isolated, reproduced and written up end-to-end by
> **DeepSeek V4.1-flash**, an AI agent running in DeepSeek Harness. A human directed the work and approved
> the steps, but **no human has read, reviewed, audited or approved this report, its evidence or its
> scripts**. The environment details, measurements and command output are the agent's. Verify anything
> here before you rely on it.

---

## Summary

On the packaged Windows desktop app, every shell call under **`workspace-write`** fails immediately
with `0xC0000142` (`STATUS_DLL_INIT_FAILED`, decimal `3221225794`). `read-only` and
`danger-full-access` are unaffected, and the failure is **not shell-specific**: `pwsh`, `cmd` and
`powershell`, MSI and Store PowerShell builds, all die the same way.

Because the shipped `workspace-write` sandbox cannot run any shell command, users who want
workspace-confined writes have to drop to `danger-full-access`, which removes confinement entirely.

## Environment

| | |
|---|---|
| OS | Windows 11 22H2, build 22621, x64 |
| Harness | desktop app `0.2.0-rc.2` (`DeepSeek Harness.exe`, Electron 44.0.0 / Node 24.18.1) |
| Shells tried | `pwsh 7.6.6` (MSI at `C:\Program Files\PowerShell\7`), Store-packaged `pwsh 7.6.6`, `powershell.exe 5.1`, `cmd.exe` |
| Session | `workspace-write` (broken) vs `read-only` and `danger-full-access` (fine) |
| Workspaces tried | a workspace path containing a space and CJK characters, and plain ASCII paths under `%TEMP%` — no difference |

## Steps to reproduce

1. Start the packaged desktop app (`DeepSeek Harness.exe`) normally, from Explorer.
2. Set the session sandbox to **`workspace-write`**.
3. Run any shell command, e.g. `$PSVersionTable.PSVersion`.

Known-good controls: the same command under `read-only` and under `danger-full-access` succeeds.

Direct reproduction of the mechanism, without the Harness (this is the shortest path — the failure
does not need the subprocess-runner chain):

```powershell
# 1. extract the shipped ACL runner to real files (see repro/README.md), then:
$env:ELECTRON_RUN_AS_NODE = 1
& 'C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe' `
    '<extracted>\dsh\node_modules\@deepseek-ai\dsh-sandbox-windows-acl\lib\runner.js' `
    --workspace <workspace> --temp <temp> --mode workspace-write `
    -- 'C:\Program Files\PowerShell\7\pwsh.exe' -NoLogo -NoProfile -Command "exit 7"
# -> 3221225794        (the same command with --mode read-only -> 7)
```

## Expected behavior

The confined child starts, the command runs, and writes outside the workspace are denied by the
restricted token / ACL boundary.

## Actual behavior

The child never starts:

```
[exit code: 3221225794]        # 0xC0000142 STATUS_DLL_INIT_FAILED
```

No stderr and no `windows-acl-run:` runner-failure line, i.e. token creation and ACL provisioning
succeeded and the **child died during DLL initialization**. Through the real chain
(`dsh-subprocess-local` runner → ACL runner), the subprocess runner reports
`{"type":"target-exit","exitCode":3221225794}`.

## Root cause

`packages/sandbox/sandbox-local/src/index.ts` → `windowsAclRunnerInvocation()`
(built as `@deepseek-ai/dsh-sandbox-local/lib/index.js:539-543`):

```js
if (existsSync(builtEntry)) return [process.execPath, builtEntry];
```

* In the packaged desktop app `process.execPath` is **`DeepSeek Harness.exe`** — an **Electron binary,
  i.e. a GUI-subsystem image, which never has a console**.
* `dsh-sandbox-windows-acl` then spawns the confined child through `dsh-win32-process` with
  `STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES`, `SW_HIDE` and **`creationFlags = 0`** — deliberately
  adding neither `CREATE_NO_WINDOW` nor `CREATE_NEW_CONSOLE`, because those children die during DLL
  initialization under the restricted token. The child is expected to **inherit the runner's console**.
* With a console-less host there is nothing to inherit, so the console-subsystem child (`pwsh`, `cmd`,
  `powershell`) must create a console itself. **Under `workspace-write` that creation fails**, and the
  process exits `STATUS_DLL_INIT_FAILED` (`0xC0000142`). Under `read-only` the child's own console
  creation happens to succeed, which is why only `workspace-write` is visibly broken.

The Harness documentation already states both halves of the rule:

* `dsh-sandbox-windows-acl/README.md` — *"**Console isolation is unavailable** — children created with
  `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` die during DLL initialization with `STATUS_DLL_INIT_FAILED`
  (`0xC0000142`); children share the host console …"*
* `dsh-win32-process/README.md` — *"It preserves console inheritance and does not add
  `CREATE_NO_WINDOW` or `CREATE_NEW_CONSOLE`, which can fail DLL initialization under the restricted
  token."*

What the documentation does not cover is that **the runner host itself provides no console on the
packaged desktop app**, so the "children share the host console" premise does not hold there.

## Evidence

### Console ownership — same parent process, two hosts

```powershell
node repro/console-probe.cjs                   # node host
# {"exe":"node.exe","consoleHwnd":"3213734","hasConsole":true,"consolePids":[21112,13564], ...}

$env:ELECTRON_RUN_AS_NODE=1
& 'C:\…\DeepSeek Harness.exe' repro/console-probe.cjs    # Electron host
# {"exe":"DeepSeek Harness.exe","consoleHwnd":"0","hasConsole":false,"consolePids":[], ...}
```

`node.exe` is a console-subsystem image; `DeepSeek Harness.exe` is a GUI-subsystem image. (Also
measured: a GUI-subsystem child of a console-owning parent still has no console, and
`CREATE_NEW_CONSOLE` does not give it one — so "launch the app from a terminal" is not a workaround.)

### Failure matrix — shipped ACL runner + restricted token, child `pwsh 7.6.6`

| ACL runner host | mode | console shim | confined child exit |
|---|---|---|---|
| `node.exe` | read-only | – | `7` ✅ |
| `node.exe` | workspace-write | – | `7` ✅ |
| Electron | read-only | – | `7` ✅ |
| **Electron** | **workspace-write** | – | **`3221225794`** ❌ |
| Electron | read-only | yes | `7` ✅ |
| **Electron** | **workspace-write** | **yes** | **`7`** ✅ |
| Electron, full subprocess-runner chain | workspace-write | – | `3221225794` ❌ |
| Electron, full chain | workspace-write | yes | `7` ✅ |

Ruled out by direct test against the shipped code and token path: shell choice (`cmd`,
`powershell 5.1`, Store `pwsh`, PATH-resolved `pwsh`, MSI `pwsh`), workspace/temp location (ASCII,
spaces, CJK, `%TEMP%`, the real workspace), the runner's working directory, `TMP`/`TEMP` values
(including non-writable and missing directories), private-temp bookkeeping (agentless vs
seam-managed), the fd-7 control channel, `windowsHide`, host creation flags (`0`,
`CREATE_NO_WINDOW`, `DETACHED_PROCESS`), the `diagnose-windows-sandbox-acl` verdict for the `pwsh`
install path (`NOT_THIS_CLASS`, zero repairs), and the Windows Application / WER log (no entry).
Details: [`evidence/repair-matrix.md`](evidence/repair-matrix.md).

**Not isolated:** the precise reason the child's own console creation succeeds in `read-only` but fails
in `workspace-write`. The two modes differ only in the capability SIDs the restricted token carries
(workspace and private-temp write SIDs) and in the private-temp bookkeeping — and the latter is
excluded above. This does not affect the finding or the fix.

### The confinement itself is correct

With a console supplied, the confined child still cannot write outside the workspace:

```
DENIED   C:\Users\<user>\dsh-escape-probe.txt
DENIED   C:\dsh-escape-probe.txt
DENIED   C:\WINDOWS\Temp\dsh-escape-probe.txt
DENIED   C:\Users\<user>\AppData\Local\Temp\dsh-escape-probe.txt
ALLOWED  <workspace>\inside-ok.txt
note: TMP/TEMP inside the sandbox = <session private temp> (granted by design; not an escape target)
```

and none of the four out-of-workspace files exist afterwards. So the restricted token and ACL grading
work; only process startup is broken.

## Suggested fix

Any one of these resolves it:

1. **Give the runner process a console** — call `AllocConsole()` (best-effort) in the Windows ACL runner
   entry before it creates the restricted token, or spawn the runner with a console. Smallest change;
   keeps the `[execPath, runner.js]` contract and every confinement decision.
2. **Keep the runner on a console-subsystem host** — the ACL runner is a plain Node script; run it with a
   console-subsystem Node instead of the GUI-subsystem Electron binary. (Note: the bundled Node cannot
   read `app.asar`, so the runner entry must be reachable as a real file.)
3. **Make the requirement explicit** — if the ACL runner genuinely needs a host console, fail with
   `SANDBOX_UNAVAILABLE` / a clear diagnostic instead of letting the child die with `0xC0000142`, and
   document the supported posture for the desktop app.

A bridge bundle implementing option 1 without patching the app — a `LocalSandboxProvider` subclass that
inserts `--import <console-shim>` in front of the runner entry, the same argument shape the Harness's own
development path already uses — is verified and available separately.

## Additional context

* Windows desktop only. On Linux/macOS the runner is `bwrap` / Landlock / `sandbox-exec`, and this
  argument position is unrelated.
* Reproduction scripts and raw measurements: [`repro/`](repro/README.md),
  [`evidence/`](evidence/repair-matrix.md).
* No system setting, ACL or Harness configuration was modified to obtain this evidence; the tests drive
  an extracted copy of the shipped sandbox code with the real Electron host binary.

## Correction — original root-cause wording was too narrow

The text below blamed the console-less host as the cause. It is the **trigger**, not the structural
condition:

* `setTokenDefaultDaclGrant()` merges **one** full-access ACE for
  `tempWriteSidPtr ?? writeSidPtr ?? worldSid` into the restricted token's existing Default DACL — a
  merge, not a replacement. `worldSid` is `makeWellKnownSid(api, 1)`, so `read-only` lands `Everyone`
  on the Default DACL while `workspace-write` lands the capability write SID instead.
* On the reporting host the process token's Default DACL was
  `{BUILTIN\Administrators, NT AUTHORITY\SYSTEM, <logon SID>}` — no `Everyone`.
* Measured on that host with one runner copy: shipped `workspace-write` → child `3221225794`; the same
  runner with `Everyone` merged into that grant (one line, host and console untouched) → child `0`; the
  shipped runner with a console supplied to it instead → child `0`.

The console-less host is what makes the child create a console during DLL initialization; the missing
`Everyone` grant is what makes that creation fail. **This failure was reported before this post** — see
the routing index #9195 and the families it routes to (#8520, #8142, #8322, #8485, #8721, #8878, #9238
host/console ownership; #8534, #8599, #8775, #9038 Default DACL). This post is an independent
cross-check, not a new root cause.

## Corroboration (added after the report was posted)

A reply on the posted discussion names this shape as the `native-init` family of
`@argszero/cordis-plugin-sandbox-grant-advisor` (0.17.0) and points at two source anchors that explain
the opaque failure: `RUNNER_FAILURE_RULES['windows-acl']` accepts only exit `127` with the
`windows-acl-run: ` signature (so `3221225794` is never classified as a runner failure), and
`@deepseek-ai/dsh-win32-process/README.md` records that `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` are
omitted deliberately. The measured remedies are in discussions #8193 / #8208; the longer write-up is
#9238. Verified against the shipped code during review.


