import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assert, describe, it } from '@effect/vitest'

import { ANCHOR_FALLBACKS, anchoredStyle } from '@/lib/anchored'

/* A lint rule for overlays (pickers, menus, popovers): they are placed only
   through src/lib/anchored.ts, which keeps them on screen. Code that sets
   anchor positions itself fails here, with the place to fix. Whether they
   really end up on screen is checked in a browser: scripts/check-overlays.mjs
   (part of npm run check:fresh). */

const root = fileURLToPath(new URL('..', import.meta.url))
const HELPER = join('src', 'lib', 'anchored.ts')

const sources = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|mjs)$/.test(name) ? [path] : []
  })

/** Anchor positioning written by hand, as a style key or as CSS. */
const ANCHOR_CSS = /\b(positionAnchor|positionArea|positionTry\w*|position-anchor|position-area|position-try[\w-]*)\b|\banchor\(/

describe('overlays (lint)', () => {
  it('are placed only through src/lib/anchored.ts', () => {
    const offenders = sources(join(root, 'src'))
      .filter(path => relative(root, path) !== HELPER)
      .flatMap(path =>
        readFileSync(path, 'utf8')
          .split('\n')
          .flatMap((line, index) => (ANCHOR_CSS.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('*') ? [`${relative(root, path)}:${index + 1}: ${line.trim()}`] : [])),
      )
    assert.deepStrictEqual(offenders, [], `Place overlays with anchoredStyle (src/lib/anchored.ts), not by hand:\n${offenders.join('\n')}`)
  })

  it('flip in both directions, shrink in height only, and ignore stray classes', () => {
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      for (const align of ['start', 'center', 'end'] as const) {
        const style = anchoredStyle('--x', { side, align })
        assert.strictEqual(style['positionTryFallbacks'], ANCHOR_FALLBACKS)
        assert.include(style['positionTryFallbacks'], 'flip-block')
        assert.include(style['positionTryFallbacks'], 'flip-inline')
        assert.strictEqual(style['maxHeight'], '100%')
        // Width is not capped to the room beside the trigger: it must flip, not squeeze.
        assert.strictEqual(style['maxWidth'], 'calc(100vw - 16px)')
        // Classes on the panel cannot shift it off its place.
        assert.strictEqual(style['inset'], 'auto')
        assert.strictEqual(style['translate'], 'none')
        assert.match(style['positionTryOrder'] ?? '', /^most-(height|width)$/)
      }
    }
  })
})
