# Reproduction scripts

These scripts drive the **shipped** sandbox code, so they need the Harness's sandbox runner and its
dependencies as real files. The packaged app keeps them inside `app.asar`, which plain `node` cannot
import — extract them first. Nothing here modifies a system setting, ACL or Harness configuration.

> **Run these from an unconfined shell.** Inside a `workspace-write` or `read-only` shell the sandbox
> blocks piped stdio between programs, so a Node script that spawns with `stdio: 'pipe'` — these scripts,
> and anything else that captures another program's output — fails with `EPERM`. Use a normal terminal,
> or a `danger-full-access` session, for the reproductions below.
## 1. Extract the shipped runner

```powershell
$app = 'C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness'

node extract-asar.cjs "$app\resources\app.asar" .\vendor `
  "dsh-(sandbox-windows-acl|subprocess-local|win32-process|lazy-require|skill|subprocess)/|/yaml/|/koffi/"

# native modules live outside the archive
robocopy "$app\resources\app.asar.unpacked" .\vendor /E | Out-Null
```

Result:

```
vendor/dsh/node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js
vendor/dsh/node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner.js
vendor/dsh/node_modules/@deepseek-ai/dsh-win32-process/lib/index.js
vendor/dsh/node_modules/koffi/…
```

(Alternatively, run the package that ships this repo's sibling project; the extractor here is a
30-line asar reader with no dependencies.)

## 2. Isolate the cause: console ownership

```powershell
node console-probe.cjs --koffi .\vendor\dsh\node_modules\koffi
node console-probe.cjs --koffi .\vendor\dsh\node_modules\koffi --host electron --electron "$app\DeepSeek Harness.exe"
```

Expected, from the same parent process:

| host | output |
|---|---|
| `node.exe` | `"hasConsole": true`, non-zero `consoleHwnd` |
| `DeepSeek Harness.exe` | `"hasConsole": false`, `"consoleHwnd": "0"` |

## 3. Reproduce the failure end to end

```powershell
$sub  = '.\vendor\dsh\node_modules\@deepseek-ai\dsh-subprocess-local\lib\runner.js'
$acl  = '.\vendor\dsh\node_modules\@deepseek-ai\dsh-sandbox-windows-acl\lib\runner.js'
$pwsh = 'C:\Program Files\PowerShell\7\pwsh.exe'
New-Item -ItemType Directory -Force .\work, .\work-tmp | Out-Null

# a) node host, workspace-write -> succeeds
node full-chain-repro.js --sub-runner $sub --acl-runner $acl --workspace .\work --temp .\work-tmp `
  --mode workspace-write --host node -- $pwsh -NoLogo -NoProfile -Command "exit 7"
#    "childExit": 7

# b) Electron host, read-only -> also fine (nothing to reproduce here)
node full-chain-repro.js --sub-runner $sub --acl-runner $acl --workspace .\work --temp .\work-tmp `
  --mode read-only --host electron --electron "$app\DeepSeek Harness.exe" `
  -- $pwsh -NoLogo -NoProfile -Command "exit 7"
#    "childExit": 7

# c) Electron host, workspace-write -> the bug
node full-chain-repro.js --sub-runner $sub --acl-runner $acl --workspace .\work --temp .\work-tmp `
  --mode workspace-write --host electron --electron "$app\DeepSeek Harness.exe" `
  -- $pwsh -NoLogo -NoProfile -Command "exit 7"
#    "childExit": 3221225794      <- 0xC0000142

# d) Electron host, workspace-write + a console shim -> fixed (proves the diagnosis)
node full-chain-repro.js --sub-runner $sub --acl-runner $acl --workspace .\work --temp .\work-tmp `
  --mode workspace-write --host electron --electron "$app\DeepSeek Harness.exe" `
  --import-shim "file:///<abs path>/console-shim.mjs" `
  -- $pwsh -NoLogo -NoProfile -Command "exit 7"
#    "childExit": 7
```

The same thing without the chain — this is the shortest reproduction:

```powershell
$env:ELECTRON_RUN_AS_NODE = 1
& "$app\DeepSeek Harness.exe" $acl --workspace $PWD\work --temp $PWD\work-tmp --mode workspace-write `
  -- $pwsh -NoLogo -NoProfile -Command "exit 7"
#    3221225794        (--mode read-only -> 7)
```

`console-shim.mjs` (used only in step c) is three lines of intent: `AllocConsole()` when
`GetConsoleWindow()` is null. It is included so the diagnosis can be confirmed without patching the
app. It is not part of the bug report's suggested upstream fix beyond *"give the runner a console"*.

## 4. Confirm the confinement itself still holds

```powershell
node full-chain-repro.js --sub-runner $sub --acl-runner $acl --workspace "$PWD\work" --temp "$PWD\work-tmp" `
  --mode workspace-write --host electron --electron "$app\DeepSeek Harness.exe" `
  --import-shim "file:///<abs path>/console-shim.mjs" `
  -- pwsh -NoLogo -NoProfile -File "$PWD\escape-test.ps1" -Workspace "$PWD\work"

Get-Content .\work\escape-report.txt                  # DENIED for all outside targets, ALLOWED inside
Test-Path "$env:USERPROFILE\dsh-escape-probe.txt"     # must be False
```

## Notes

* `--mode workspace-write` without `--write-sid` / `--temp-write-sid` uses the runner's *agentless*
  path: it creates and grants its own private temp directory, exactly as the seam does. Passing both
  SIDs reproduces the seam-managed path.
* `full-chain-repro.js` mirrors the Harness's isolated runner layout: `fd 3` IPC, `fd 4` stdin carrier,
  `fd 5/6` target stdout/stderr, `fd 7` control (`overlapped`).

