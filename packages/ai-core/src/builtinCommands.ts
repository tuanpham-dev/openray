/**
 * The seeded built-in AI Commands — port of
 * `src-tauri/src/application/ai/mod.rs`'s `BUILTIN_AI_COMMANDS`. Seeded
 * once (insert-if-absent, so a user's edits survive) by
 * `extensions/ai/src/storage.ts`.
 */
export interface BuiltinAiCommand {
  slug: string
  name: string
  prompt: string
  creativity: 'none' | 'low' | 'medium' | 'high'
  outputMode: 'replace' | 'view'
}

export const BUILTIN_AI_COMMANDS: BuiltinAiCommand[] = [
  {
    slug: 'improve-writing',
    name: 'Improve Writing',
    prompt: 'Improve the writing, grammar, and clarity of the following text while preserving its meaning and tone. Reply with only the improved text:\n\n{selection}',
    creativity: 'low',
    outputMode: 'replace',
  },
  {
    slug: 'fix-spelling-grammar',
    name: 'Fix Spelling and Grammar',
    prompt: 'Fix spelling and grammar mistakes in the following text, making no other changes. Reply with only the corrected text:\n\n{selection}',
    creativity: 'none',
    outputMode: 'replace',
  },
  {
    slug: 'explain-simple-terms',
    name: 'Explain in Simple Terms',
    prompt: 'Explain the following in simple terms a beginner could understand:\n\n{selection}',
    creativity: 'medium',
    outputMode: 'view',
  },
  {
    slug: 'tone-professional',
    name: 'Change Tone to Professional',
    prompt: 'Rewrite the following text in a professional tone. Reply with only the rewritten text:\n\n{selection}',
    creativity: 'low',
    outputMode: 'replace',
  },
  {
    slug: 'tone-friendly',
    name: 'Change Tone to Friendly',
    prompt: 'Rewrite the following text in a warm, friendly tone. Reply with only the rewritten text:\n\n{selection}',
    creativity: 'low',
    outputMode: 'replace',
  },
  {
    slug: 'find-bugs',
    name: 'Find Bugs in Code',
    prompt: 'Review the following code and identify potential bugs, edge cases, and correctness issues:\n\n{selection}',
    creativity: 'medium',
    outputMode: 'view',
  },
  {
    slug: 'summarize-webpage',
    name: 'Summarize Webpage',
    prompt: 'Summarize the following webpage content:\n\n{webpage}',
    creativity: 'medium',
    outputMode: 'view',
  },
  {
    slug: 'ask-about-webpage',
    name: 'Ask About Webpage',
    prompt: 'Given the following webpage content, answer the user\'s question: {argument name="question"}\n\nWebpage content:\n{webpage}',
    creativity: 'medium',
    outputMode: 'view',
  },
]
