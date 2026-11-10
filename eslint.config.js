import { fileURLToPath } from 'node:url'
import { creaseui } from '@creaseui/lint'

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'public/**', 'vendor/**', 'output/**'],
  },
  ...creaseui({
    rootDir: fileURLToPath(new URL('.', import.meta.url)),
    renderer: 'tailwind',
    preset: 'strict',
    files: ['src/**/*.{ts,tsx,js,jsx}'],
    tsconfig: './tsconfig.json',
    manifest: './crease.lock.json',
    policy: 'crease-default-v1',
  }),
]
