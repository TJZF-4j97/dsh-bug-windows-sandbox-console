# Evidence — console ownership

Measured with `repro/console-probe.cjs` (koffi → `kernel32!GetConsoleWindow` +
`GetConsoleProcessList`), **from the same parent process**, same user, same elevation:

```powershell
PS> node repro/console-probe.cjs
{
  "exe": "node.exe",
  "pid": 21112,
  "consoleHwnd": "3213734",
  "hasConsole": true,
  "consolePids": [21112, 13564],
  "stdoutIsTTY": false
}
```

```powershell
PS> $env:ELECTRON_RUN_AS_NODE = 1
PS> & 'C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe' repro/console-probe.cjs
{
  "exe": "DeepSeek Harness.exe",
  "pid": 2300,
  "consoleHwnd": "0",
  "hasConsole": false,
  "consolePids": [],
  "stdoutIsTTY": false
}
```

Interpretation:

* `node.exe` is a **console-subsystem** image: it receives and shares a console
  (`consolePids` lists the parent shell as well).
* `DeepSeek Harness.exe` is a **GUI-subsystem** image: Windows gives it **no console**
  (`consoleHwnd = 0`, empty `consolePids`), even though its parent owns one.

Consequences measured separately, so that "launch the app from a terminal" is not mistaken for a
workaround:

| launch attempt | result |
|---|---|
| GUI-subsystem process spawned from a console-owning parent | no console |
| GUI-subsystem process spawned with `CREATE_NEW_CONSOLE` | no console |
| console-subsystem process spawned from a console-owning parent | console |
| console-subsystem process spawned with `CREATE_NEW_CONSOLE` | console |

So the only way for the GUI-subsystem Harness process tree to hold a console is for one of its
processes to call `AllocConsole()` itself — which is what the ACL runner needs and does not do.

## Why this is the deciding factor

`dsh-sandbox-windows-acl` spawns the confined child with `creationFlags = 0` and
`STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES`, `SW_HIDE` (`dsh-win32-process`, `spawnJobProcess` path).
Neither `CREATE_NO_WINDOW` nor `CREATE_NEW_CONSOLE` is added — per the package documentation, such
children die during DLL initialization under the restricted token — so the child depends entirely on
**inheriting the host console**. A GUI-subsystem host (`node.exe` → Electron swap in
`dsh-sandbox-local/lib/index.js`) removes exactly that, and the console-subsystem child then has to
create a console itself, which **fails in `workspace-write`** with `STATUS_DLL_INIT_FAILED`
(`0xC0000142`). `read-only` is spared because the child's own console creation happens to succeed
there; supplying a console to the runner fixes both modes
(see [`repair-matrix.md`](repair-matrix.md)).

The corresponding row in the same package's README — *"children share the host console"* — is the
premise this report shows to be false for the packaged desktop app.
