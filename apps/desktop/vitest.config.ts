import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Most tests here are pure functions and run fine anywhere, but the
    // palette's keyboard behaviour can only be checked against a real DOM:
    // whether a key handled inside an argument field still reaches the
    // window-level listener is exactly the kind of thing that looks right
    // in review and runs twice in practice.
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
  },
})
