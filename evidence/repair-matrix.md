# Evidence — failure matrix and ruled-out causes

Every run drives the **shipped** sandbox code (extracted `dsh-sandbox-windows-acl`,
`dsh-win32-process`, `dsh-subprocess-local`) with the real restricted token and the real Electron host
binary. Child is `pwsh.exe` 7.6.6 invoked as `-NoLogo -NoProfile -Command "exit 7"`.
`3221225794` = `0xC0000142` = `STATUS_DLL_INIT_FAILED`.

## A. The failure needs two conditions together

| ACL runner host | mode | console shim | confined child exit |
|---|---|---|---|
| `node.exe` | read-only | – | `7` ✅ |
| `node.exe` | workspace-write | – | `7` ✅ |
| Electron (`DeepSeek Harness.exe`) | read-only | – | `7` ✅ |
| **Electron** | **workspace-write** | – | **`3221225794`** ❌ |
| Electron | read-only | yes | `7` ✅ |
| **Electron** | **workspace-write** | **yes** | **`7`** ✅ |
| Electron, full subprocess-runner chain (`fd 3` IPC, `fd 4–6` carriers, `fd 7` control) | workspace-write | – | `3221225794` ❌ |
| Electron, full chain | workspace-write | yes | `7` ✅ |

So:

* the **host's console** decides whether the child can start when it has to create a console itself,
* **`workspace-write`** is the mode in which that creation fails,
* the **chain is irrelevant** — the direct spawn reproduces it, so the simplest reproduction is the
  direct one,
* a console supplied to the runner fixes **both** modes.

## B. Ruled out by direct test

| Variable tried | Result |
|---|---|
| shell: `pwsh 7.6.6` (MSI), Store-packaged `pwsh 7.6.6`, `pwsh` from `PATH`, `powershell.exe` 5.1, `cmd.exe` | all fail on the Electron host in `workspace-write`, all succeed in `read-only` and under `node.exe` |
| workspace / temp path: ASCII, spaces, CJK characters, `%TEMP%`, the real workspace path | no effect |
| runner working directory: `<session workspace>`, a neutral temp dir, `C:\Windows\Temp`, the temp root | no effect (always `0xC0000142` in `workspace-write`, always `7` in `read-only`) |
| `TMP`/`TEMP` values, including a non-writable and a missing directory | no effect |
| private temp bookkeeping: agentless (runner creates and grants its own temp) vs seam-managed (`--write-sid` + `--temp-write-sid`) | both fail identically — the temp bookkeeping is not the cause |
| fd 7 control channel on / off | no effect |
| `windowsHide: true` on the subprocess runner | no effect |
| host creation flags `0`, `CREATE_NO_WINDOW` (0x08000000), `DETACHED_PROCESS` (0x00000008) | no effect for `node.exe` (console either way); a GUI-subsystem host gets no console with any of them |
| `diagnose-windows-sandbox-acl` on the `pwsh` install path | `VERDICT=NOT_THIS_CLASS`, 0 repairs — the path's ACLs are fine (only the well-known `S-1-15-2-1` / `S-1-15-2-2` groups are present) |
| Windows Application / WER event log around the failure window | no entry for the failure (process-init failures produce none); only unrelated `AUDIODG.EXE` / `vivoSyncService.exe` `0xc0000409` records |
| GUI-subsystem child inheriting a console from a console-owning parent; `CREATE_NEW_CONSOLE` on a GUI image | both give no console → "run the app from a terminal" is not a workaround |

**Not isolated:** the precise reason the child's own console creation succeeds in `read-only` but fails
in `workspace-write`. The two modes differ only in the capability SIDs the restricted token carries
(the workspace and private-temp write SIDs) and in the private-temp bookkeeping, and the latter is
excluded above. This does not change the finding or the fix: supplying a console removes the need to
create one at all, and it fixes both modes.

## C. Confinement is correct (the failure is only process startup)

Escape probe executed **inside** the confined child with a console supplied, mode `workspace-write`:

```
DENIED   C:\Users\<user>\dsh-escape-probe.txt
DENIED   C:\dsh-escape-probe.txt
DENIED   C:\WINDOWS\Temp\dsh-escape-probe.txt
DENIED   C:\Users\<user>\AppData\Local\Temp\dsh-escape-probe.txt
ALLOWED  <workspace>\inside-ok.txt
note: TMP/TEMP inside the sandbox = <session private temp> (granted by design; not an escape target)
```

Filesystem check afterwards: all four out-of-workspace targets **absent**, the in-workspace file
**present**. So the restricted token, the write-restricted SIDs, the Low integrity label and the ACL
grading all behave as designed; the Harness just never reaches the point where the child runs.

> `TMP`/`TEMP` are deliberately not used as an escape target: in `workspace-write` the runner rewrites
> them to the session's private temp directory, which the sandbox grants — probing `$env:TEMP` would
> be a false positive. `repro/escape-test.ps1` uses the literal user temp path instead.

## D. How the numbers were produced

```powershell
# direct spawn (simplest reproduction)
$env:ELECTRON_RUN_AS_NODE = 1
& "$app\DeepSeek Harness.exe" <acl-runner.js> --workspace <ws> --temp <tmp> `
    --mode workspace-write -- pwsh -NoLogo -NoProfile -Command "exit 7"
# -> 3221225794        (read-only here -> 7)

# through the real chain
node repro/full-chain-repro.js --sub-runner <sub-runner.js> --acl-runner <acl-runner.js> `
  --workspace <ws> --temp <tmp> --mode workspace-write --host electron `
  --electron "$app\DeepSeek Harness.exe" -- pwsh -NoLogo -NoProfile -Command "exit 7"
# -> "childExit": 3221225794
```
