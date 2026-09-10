---
title: CLI reference
description: The openray command — develop, pack, publish, list and run.
---

```sh
npm install --save-dev @openray/cli
# or run it without installing:
npx openray --help
```

`develop`, `list` and `run` talk to a **running** OpenRay over a local socket. `create`, `pack`
and `publish` do not, so they work offline and in CI.

The socket is **Unix only for now** — Windows needs a named pipe instead. OpenRay writes a
pointer file naming the socket, which is what the CLI reads:

| | Pointer file |
| --- | --- |
| macOS | `~/Library/Application Support/openray/control-socket` |
| Linux | `~/.config/openray/control-socket` |
| Windows | `%APPDATA%\openray\control-socket` |

The socket it points at lives in the app data directory and is readable only by you.

## Commands

| Command | What it does |
| --- | --- |
| `openray develop [dir]` | Build the extension in `[dir]` and keep rebuilding it as you save. `openray dev` is an alias |
| `openray create [dir] [tpl]` | Scaffold a new extension; prompts for a template |
| `openray pack [dir]` | Build `[dir]` and write a `.orx` archive |
| `openray publish <dir> [...]` | Pack every extension directory into a registry catalog |
| `openray list` | List command ids the running app can run |
| `openray run <id>` | Run a command in the running app |
| `openray help` | Print usage. Same as `--help` |

## Options

| Option | Applies to | Meaning |
| --- | --- | --- |
| `--out <dir>` | `pack`, `publish` | Where output is written. Defaults to `./dist` |
| `--arg <name=value>` | `run` | An argument for the command. Repeatable |
| `--json` | `run`, `list` | Machine-readable output |
| `--help`, `-h` | any | Show usage |

## Running a command from a terminal

```sh
npx openray list                        # every command id the running app can run
npx openray run <id>                    # ids look like ext:<extension>:<command>
npx openray run <id> --arg name=value   # for a command with arguments
```

`list` prints one id per line with its extension, and appends the mode only for commands that
open a view rather than running headlessly. Commands you have **disabled** in Settings are left
out entirely, so a command can exist and not be listed.

Add `--json` to get each command's title, extension, mode and declared `arguments` — the
argument names are what `--arg` expects, and they are not shown in the plain output.

A command with no UI of its own — a window preset, a snippet, a system command — runs
headlessly and `run` returns once it's done. A command that opens a view (Store, Notes,
most List/Grid/Form commands) instead brings the app forward and opens it there, the same
as a click or hotkey would. In that case `run` returns as soon as that's requested, not
once the view has actually rendered.

## Related

- [Writing an extension](/docs/developers/writing-extensions)
- [Packaging and registries](/docs/developers/packaging-and-registries)
