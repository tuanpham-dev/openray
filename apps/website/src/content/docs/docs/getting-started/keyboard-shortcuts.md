---
title: Keyboard shortcuts
description: Every key the palette handles, in root search, lists, grids and forms.
---

`⌘` below means **Command on macOS and Ctrl on Windows and Linux**. OpenRay prints the macOS
glyphs everywhere, but every binding it owns accepts either key.

The exception is a shortcut an extension declares for itself. If it asks for Command *and*
Control together, both really are required, on every platform.

## Root search

| Key | Action |
| --- | --- |
| ↑ ↓ | Move the selection, wrapping at the ends |
| ↵ | Run the selected row |
| ⌘↵ | Run its second action. On an inline row, copy the raw value |
| ⌘⇧↵ | On an inline row, copy the whole `question = answer` line |
| ⌘K | Open or close the Actions panel |
| ⌘, | Open Settings and hide the palette |
| Tab | Jump into the selected command's first argument field, or send the query to Quick AI if it has none. Does nothing until you have typed something |
| Esc | Close an open panel, go back a view, or hide the palette |

After you reopen the palette, the previous query is selected. The first character you type
replaces it, and Backspace clears it.

## Actions panel

| Key | Action |
| --- | --- |
| ⌘K | Open or close |
| type | Filter the actions |
| ↑ ↓ | Move the highlight |
| ↵ | Run the highlighted action |
| Esc | Clear the filter, then close |

## Argument fields

| Key | Action |
| --- | --- |
| ↵ | Run the command with what you have typed |
| Tab / ⇧Tab | Next / previous field |
| ← at the start | Previous field, or back to the query |
| → at the end | Next field |
| ↑ ↓ | Still move the selection in the list below |

Pressing ↵ with a required field empty runs nothing and puts the caret in that field.

## Lists

| Key | Action |
| --- | --- |
| ↑ ↓ | Move the selection |
| ↵ / ⌘↵ | First / second action |
| ⌘K | Actions panel |
| ⌘P | Open the filter dropdown, when the list has one |
| Esc | Back |

Inside an open dropdown: ↑ ↓ move, Home and End jump to the ends, ↵ or Tab picks, Esc
closes without changing anything.

## Grids

| Key | Action |
| --- | --- |
| ← → | One cell |
| ↑ ↓ | One row |
| ↵ / ⌘↵ | First / second action |
| ⌘K | Actions panel |

Grid movement clamps rather than wraps, so a short last row stays reachable.

## Forms

| Key | Action |
| --- | --- |
| ⌘↵ | Submit |
| Tab | Next field |
| ⌘K | Actions panel |
| Esc | Back |

Plain ↵ does **not** submit a form — it stays free for typing.

## Vim-style navigation

Turn on **Vim Style Navigation** in [Settings → General](/docs/settings/general) and:

| Key | Action |
| --- | --- |
| Alt+J / Alt+K | Down / up in any list |
| Alt+H / Alt+L | Left / right in a grid |

These match the physical key, so they keep working on a macOS layout where Option composes
a different character.

## Global

| Key | Action |
| --- | --- |
| ⌘ Space (macOS) or Alt Space | Show or hide the palette |

Rebind it, or give any single command its own global hotkey, in
[Settings](/docs/settings/extensions-and-commands).
