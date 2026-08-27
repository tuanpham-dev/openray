import { describe, expect, it } from 'vitest'
import { isValidSkillName, parseFrontmatter } from '../src/skills'

describe('isValidSkillName', () => {
  it('rejects invalid names', () => {
    expect(isValidSkillName('')).toBe(false)
    expect(isValidSkillName('-leading')).toBe(false)
    expect(isValidSkillName('trailing-')).toBe(false)
    expect(isValidSkillName('double--hyphen')).toBe(false)
    expect(isValidSkillName('Has Spaces')).toBe(false)
  })

  it('accepts a valid name', () => {
    expect(isValidSkillName('valid-name-123')).toBe(true)
  })
})

describe('parseFrontmatter', () => {
  it('discovers a valid skill with its body', () => {
    const content = '---\nname: reviewer\ndescription: Reviews code for bugs.\n---\nFocus on correctness.'
    const skill = parseFrontmatter(content)
    expect(skill).not.toBeNull()
    expect(skill?.name).toBe('reviewer')
    expect(skill?.description).toBe('Reviews code for bugs.')
    expect(skill?.body.trim()).toBe('Focus on correctness.')
  })

  it('returns null without both fields', () => {
    expect(parseFrontmatter('---\nname: only-name\n---\nbody')).toBeNull()
    expect(parseFrontmatter('no frontmatter here')).toBeNull()
  })

  it('rejects an invalid name even with both fields present', () => {
    expect(parseFrontmatter('---\nname: Bad Name\ndescription: x\n---\nbody')).toBeNull()
  })

  it('strips surrounding quotes from values', () => {
    const skill = parseFrontmatter('---\nname: "quoted-name"\ndescription: \'Quoted description.\'\n---\nbody')
    expect(skill?.name).toBe('quoted-name')
    expect(skill?.description).toBe('Quoted description.')
  })
})
