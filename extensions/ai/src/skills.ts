/**
 * `SKILL.md` filesystem scan — port of
 * `src-tauri/src/application/ai/skills.rs`'s `discover`. The frontmatter
 * parsing itself lives in `@openray/ai-core` (pure, testable); this is just
 * the `fs`/`path` walk, one level deep, matching Raycast's own scan
 * depth.
 */
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseFrontmatter, type SkillInfo } from '@openray/ai-core'

export interface Skill {
  info: SkillInfo
  body: string
}

function expandHome(path: string): string {
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

export async function discoverSkills(dirs: string[]): Promise<Skill[]> {
  const skills: Skill[] = []
  for (const dir of dirs) {
    const dirPath = expandHome(dir)
    let entries
    try {
      entries = await readdir(dirPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillMdPath = join(dirPath, entry.name, 'SKILL.md')
      let content: string
      try {
        content = await readFile(skillMdPath, 'utf-8')
      } catch {
        continue
      }
      const parsed = parseFrontmatter(content)
      if (!parsed) continue
      skills.push({ info: { name: parsed.name, description: parsed.description, path: skillMdPath }, body: parsed.body })
    }
  }
  return skills
}

export async function listSkillInfos(dirs: string[]): Promise<SkillInfo[]> {
  return (await discoverSkills(dirs)).map((s) => s.info)
}
