# dsh-bug-windows-sandbox-console

Bug report: **`workspace-write` shell calls die with `0xC0000142` on the DeepSeek Harness Windows
desktop app**, because the ACL sandbox runner is spawned with the Electron binary — a GUI-subsystem
image with no console — while the confined child is expected to inherit one.

> # ⚠️ NOT REVIEWED BY ANY HUMAN
>
> **AI-generated report.** This bug was found, isolated, reproduced and written up end-to-end by
> **DeepSeek V4.1-flash**, an AI agent running in DeepSeek Harness. A human directed the work and approved
> the steps, but **no human has read, reviewed, audited or approved this report, its evidence or its
> scripts**. The environment details, measurements and command output are the agent's. Verify anything
> here before you rely on it.
>
> The same warning accompanies every comment this project posts upstream.

**Reported upstream:** <https://github.com/deepseek-ai/deepseek-harness/discussions/9280> — posted
2026-10-09 in the `General` category (`deepseek-ai/deepseek-harness` keeps Issues disabled, and its
README routes bug reports to Discussions).
**Environment:** DeepSeek Harness desktop `0.2.0-rc.2` (Electron 44.0.0 / Node 24.18.1), Windows 11
22H2 build 22621 x64.

| File | What it is |
|---|---|
| [`DISCUSSION.md`](DISCUSSION.md) | **The posted report** — the text that is live as Discussion #9280. |
| [`ISSUE.md`](ISSUE.md) | The long-form version in standard issue sections (same content, issue formatting). |
| [`evidence/console-ownership.md`](evidence/console-ownership.md) | The console measurements that isolate the cause. |
| [`evidence/repair-matrix.md`](evidence/repair-matrix.md) | The full test matrix and everything that was ruled out. |
| [`repro/`](repro/README.md) | Scripts that reproduce the failure against the *shipped* sandbox code. |

## One-paragraph version

`dsh-sandbox-local` spawns the Windows ACL sandbox runner as `[process.execPath, runner.js]`. In the
packaged desktop app `process.execPath` is the **Electron binary — GUI subsystem, no console**. The
runner then spawns the confined child with no console-isolation flag on purpose (a
`CREATE_NO_WINDOW`/`CREATE_NEW_CONSOLE` child dies under the restricted token), expecting the child to
**inherit the runner's console**. Nothing to inherit means the console-subsystem child creates its own
console — which **fails in `workspace-write`** and kills the process with `STATUS_DLL_INIT_FAILED`
(`0xC0000142`); `read-only` happens to survive because the child's own console creation succeeds there.
Confinement itself is fine: supply a console (`AllocConsole()` in the runner, or `--import
<console-shim>` in the runner argv) and the confined child starts in **both** modes, while writes
outside the workspace are still denied.

## Quick reproduction

```powershell
# needs the shipped ACL runner extracted to real files — see repro/README.md
node repro/console-probe.cjs                                     # node host     -> hasConsole true
$env:ELECTRON_RUN_AS_NODE=1
& 'C:\…\DeepSeek Harness.exe' repro/console-probe.cjs            # Electron host -> hasConsole false

# the failure needs the Electron host AND workspace-write
$env:ELECTRON_RUN_AS_NODE=1
& 'C:\…\DeepSeek Harness.exe' <acl-runner.js> --workspace <ws> --temp <tmp> `
    --mode workspace-write -- pwsh -NoLogo -NoProfile -Command "exit 7"
# -> 3221225794        (--mode read-only -> 7)

# or through the real chain:
node repro/full-chain-repro.js --sub-runner <sub-runner.js> --acl-runner <acl-runner.js> `
  --workspace <ws> --temp <tmp> --mode workspace-write --host electron `
  --electron 'C:\…\DeepSeek Harness.exe' -- pwsh -NoLogo -NoProfile -Command "exit 7"
# -> "childExit": 3221225794
```

## Scope

* Windows desktop only.
* Obtained without modifying any system setting, ACL or Harness configuration.

## License

[MIT](LICENSE)




