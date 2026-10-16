import { defineConfig } from 'vitest/config'

// Records the Play cover loop with the app's own renderer on node WebGPU:
//   npx vitest run --config scripts/cover-video.vitest.config.ts
export default defineConfig({ test: { include: ['scripts/cover-video.test.ts'], testTimeout: 1800000 } })
