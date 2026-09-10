---
title: Script Commands
description: Turn any shell, Python or Node script into a launcher command with a comment header.
---

![Script Commands](/openray/screenshots/script-commands.svg)

Any script with the right comment header becomes a command in root search. The header format
is Raycast's, so scripts written for Raycast work unchanged.

## Point OpenRay at a folder

Settings → Script Commands → **Script Directories**. There is no default, so nothing is
discovered until you add a folder.

Folders are scanned three levels deep. Hidden files and `node_modules` are skipped.

## The header

```bash
#!/bin/bash

# @raycast.schemaVersion 1
# @raycast.title Current IP Address
# @raycast.mode compact
# @raycast.packageName Network
# @raycast.icon 🌐
```

`@openray.` is accepted everywhere `@raycast.` is, with identical meaning. Headers must be
inside a comment and appear in the first 200 lines.

### Required

| Field | Value |
| --- | --- |
| `schemaVersion` | Must be `1` |
| `title` | What you search for |
| `mode` | `fullOutput`, `compact`, `silent` or `inline` |

A script missing any of these is invisible.

### Optional

| Field | What it does |
| --- | --- |
| `packageName` | Row subtitle, and a search keyword |
| `description` | Row subtitle when there is no `packageName` |
| `icon` | An emoji, an absolute path, or a path relative to the script |
| `currentDirectoryPath` | Working directory. Defaults to the script's own folder |
| `needsConfirmation` | `true` shows a confirmation step before running |
| `argument1` | A JSON object describing a value to prompt for |

### Modes

| Mode | What happens |
| --- | --- |
| `fullOutput` | Opens a detail view and streams stdout and stderr into it live |
| `compact` | Runs headless, shows the last line of output in a toast |
| `inline` | Same as `compact` |
| `silent` | Closes the palette and runs in the background |

## How a script is run

If the file is executable, it runs directly and its own shebang applies. Otherwise a `#!`
line is honoured if present, and failing that the interpreter comes from the extension:

| Extension | Interpreter |
| --- | --- |
| `.py` | `python3` |
| `.js`, `.mjs` | `node` |
| `.rb` | `ruby` |
| `.pl` | `perl` |
| `.php` | `php` |
| `.fish` | `fish` |
| `.zsh` | `zsh` |
| `.applescript`, `.scpt` | `osascript` |
| `.swift` | `swift` |
| anything else | `bash` |

## Limitations

- **Windows is not really supported.** Nothing blocks the extension there, but the interpreter
  table above is the Unix one: a script with no shebang and an unrecognised extension is handed
  to `bash`, and PowerShell and batch files have no interpreter of their own. Expect scripts to
  fail unless the interpreter they name is on your PATH.
- `argument2` and `argument3` are parsed but only the **first** argument's value is passed to
  the script.
- `@raycast.refreshTime` is not supported. There is no menu-bar refresh mode.

## Related

- [System Commands](/docs/features/system-commands)
- [Writing an extension](/docs/developers/writing-extensions) — for anything more than a script
