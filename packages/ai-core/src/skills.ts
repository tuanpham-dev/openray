/**
 * `SKILL.md` frontmatter parsing (https://manual.raycast.com/ai/skills
 * parity) — port of `src-tauri/src/application/ai/skills.rs`'s
 * `is_valid_skill_name`/`parse_frontmatter`. The filesystem scan itself
 * (`fs.readdir`, one level deep) lives in `extensions/ai/src/skills.ts`
 * since it needs Node's `fs`/`path`; this module is the pure parsing part.
 *
 * **Simplification (disclosed, matching native):** every discovered
 * skill's full body is injected directly into the system prompt rather
 * than exposed as a lazy `load_skill` tool call — correct for a personal
 * skills folder, doesn't scale to a large shared library.
 */

export interface SkillInfo {
  name: string
  description: string
  path: string
}

export interface ParsedSkill {
  name: string
  description: string
  body: string
}

export function isValidSkillName(name: string): boolean {
  if (!name || name.length > 64 || name.startsWith('-') || name.endsWith('-') || name.includes('--')) return false
  return /^[a-z0-9-]+$/.test(name)
}

/** Minimal YAML frontmatter parse — only `name:`/`description:` matter. */
export function parseFrontmatter(content: string): ParsedSkill | null {
  const withoutBom = content.startsWith('﻿') ? content.slice(1) : content
  if (!withoutBom.startsWith('---')) return null
  const rest = withoutBom.slice(3)
  const end = rest.indexOf('\n---')
  if (end === -1) return null
  const frontmatter = rest.slice(0, end)
  const body = rest.slice(end + 4).replace(/^\n+/, '')

  let name: string | undefined
  let description: string | undefined
  for (const rawLine of frontmatter.split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('name:')) {
      name = unquote(line.slice('name:'.length).trim())
    } else if (line.startsWith('description:')) {
      description = unquote(line.slice('description:'.length).trim())
    }
  }
  if (name === undefined || description === undefined) return null
  if (!isValidSkillName(name) || description.length === 0 || description.length > 1024) return null
  return { name, description, body }
}

/** Matches Rust's `str::trim_matches` — strips every leading/trailing
 *  occurrence of the char independently, not requiring both ends to match
 *  a full quote pair. */
function unquote(value: string): string {
  return trimChar(trimChar(value, '"'), "'")
}

function trimChar(value: string, char: string): string {
  let start = 0
  let end = value.length
  while (start < end && value[start] === char) start++
  while (end > start && value[end - 1] === char) end--
  return value.slice(start, end)
}
