import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assert, describe, it } from '@effect/vitest'
import type { HtmlBuilder } from 'foldkit/html'

import { TEXT_INPUT_TYPES } from '@/lib/input'
import { input } from '@/ui/input'

/* A lint rule for form controls: pages use crease/ui components, never the
   browser's unstyled native controls, which look different in every browser
   and ignore the theme (dark mode, sizes, focus rings).

   - Dates and times: src/ui/date-picker.ts and src/ui/time-picker.ts, not
     <input type="date|time|datetime-local|month|week">.
   - Text: `input` (src/ui/input.ts) and `textarea`/`renderTextarea`, not
     h.input / h.textarea. Only src/ui and src/lib (the crease components
     themselves) build those elements.
   - No <select>, number, range, colour, checkbox, radio or file inputs
     either: copy the crease component (select, number-input, slider,
     color-picker, checkbox, radio-group, file-input) from crease/ui
     (../crease/src/ui) into src/ui first.

   The crease `input` only takes text-like types (TextInputType), so the
   compiler refuses the rest as well. An exception needs a comment on the
   line or the line before: `// native-control: <why>`. */

const root = fileURLToPath(new URL('..', import.meta.url))

const sources = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : /\.ts$/.test(name) ? [path] : []
  })

const NATIVE_TYPES = 'date|time|datetime-local|month|week|number|range|color|checkbox|radio|file'

type Rule = Readonly<{ pattern: RegExp; message: string; inComponents: boolean }>

const RULES: ReadonlyArray<Rule> = [
  {
    pattern: new RegExp(`\\b(h|hd)\\.Type\\(\\s*['"\`](${NATIVE_TYPES})['"\`]`),
    message: 'a native date/time/number/checkbox/file control: use the crease component (src/ui)',
    inComponents: true,
  },
  {
    pattern: new RegExp(`\\btype:\\s*['"\`](${NATIVE_TYPES})['"\`]`),
    message: 'a native date/time/number/checkbox/file control: use the crease component (src/ui)',
    inComponents: true,
  },
  {
    pattern: new RegExp(`<input\\b[^>]*\\btype=["'](${NATIVE_TYPES})["']`),
    message: 'a native control in HTML: use the crease component (src/ui)',
    inComponents: true,
  },
  { pattern: /\b(h|hd)\.select\(|<select\b/, message: 'a native <select>: copy crease/ui select into src/ui and use it', inComponents: false },
  { pattern: /\b(h|hd)\.input\(/, message: 'a bare <input>: use `input` from src/ui/input.ts', inComponents: false },
  { pattern: /\b(h|hd)\.textarea\(|<textarea\b/, message: 'a bare <textarea>: use `textarea`/`renderTextarea` from src/ui, src/lib', inComponents: false },
  {
    // Server-rendered HTML (the sign-in page): an input needs crease's classes.
    pattern: /<input\b(?![^>]*\btype=["']hidden["'])(?![^>]*\bclass=)[^>]*>/,
    message: 'an <input> without crease classes',
    inComponents: false,
  },
]

const COMPONENTS = [join('src', 'ui') + sep, join('src', 'lib') + sep]
const isComment = (line: string) => /^\s*\/\//.test(line)
/** The text with block comments blanked out, lines kept in place. */
const withoutBlockComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '))
const isAllowed = (lines: ReadonlyArray<string>, index: number) => /native-control:/.test(`${lines[index - 1] ?? ''}\n${lines[index] ?? ''}`)

/** Every place a rule finds, as `file:line: message`. */
export const offenders = (files: ReadonlyArray<Readonly<{ path: string; text: string }>>): ReadonlyArray<string> =>
  files.flatMap(({ path, text }) => {
    const isComponent = COMPONENTS.some(prefix => path.startsWith(prefix))
    const lines = withoutBlockComments(text).split('\n')
    return lines.flatMap((line, index) =>
      isComment(line) || isAllowed(lines, index)
        ? []
        : RULES.filter(rule => (rule.inComponents || !isComponent) && rule.pattern.test(line)).map(rule => `${path}:${index + 1}: ${rule.message}\n    ${line.trim().slice(0, 160)}`),
    )
  })

describe('native form controls (lint)', () => {
  it('are not used: pages use the crease/ui components', () => {
    const files = sources(join(root, 'src')).map(path => ({ path: relative(root, path), text: readFileSync(path, 'utf8') }))
    const found = offenders(files)
    assert.deepStrictEqual(found, [], `Use crease/ui components instead of native controls:\n${found.join('\n')}`)
  })

  it('finds each kind of native control, and allows marked exceptions', () => {
    const page = (text: string) => offenders([{ path: join('src', 'app', 'x', 'page.ts'), text }])
    assert.lengthOf(page("input({ id: 'd', value: '', type: 'date' }, h)"), 1)
    assert.lengthOf(page("h.input([h.Type('time'), h.Value(v)])"), 2)
    assert.lengthOf(page("h.select([], [h.option([], ['a'])])"), 1)
    assert.lengthOf(page("h.textarea([h.Value(v)])"), 1)
    assert.lengthOf(page('`<input type="checkbox" class="x">`'), 1)
    assert.lengthOf(page('`<input id="email" type="text">`'), 1)
    assert.lengthOf(page('`<input type="hidden" name="next">`'), 0)
    assert.lengthOf(page('`<input id="email" type="text" class="${FIELD}">`'), 0)
    assert.lengthOf(page("// native-control: the browser's colour well is wanted here\nh.input([h.Type('color')])"), 0)
    assert.lengthOf(page("// h.select( in a comment"), 0)
    assert.lengthOf(page('/* Not <input type="date">,\n   nor h.select( */ const x = 1'), 0)
    // The crease components themselves build <input> and <textarea>, but no date inputs.
    assert.lengthOf(offenders([{ path: join('src', 'ui', 'x.ts'), text: 'const control = h.input([' }]), 0)
    assert.lengthOf(offenders([{ path: join('src', 'ui', 'x.ts'), text: "h.input([h.Type('date')])" }]), 1)
  })

  it('the crease input takes text-like types only', () => {
    assert.deepStrictEqual([...TEXT_INPUT_TYPES], ['text', 'search', 'email', 'password', 'url', 'tel'])
    // Never called: the compiler checks it (npm run typecheck).
    const refused = (h: HtmlBuilder<never>) =>
      // @ts-expect-error a date input is refused
      input({ id: 'when', value: '', type: 'date' }, h)
    assert.isFunction(refused)
  })
})
