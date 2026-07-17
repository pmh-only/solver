import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['src/test/setup.ts'],
    include: ['src/test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**']
  }
})
