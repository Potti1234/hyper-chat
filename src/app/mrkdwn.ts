import { emojiByName } from './emoji'

/* Slack's message markup ("mrkdwn"), parsed into a small tree the view
   renders (view/message.ts). Pure, so the server, tests and search agree.

   Blocks, by line: ``` fences a code block, `>` quotes, `-`/`*`/`•` start a
   bulleted item and `1.` a numbered one; other lines are paragraphs.
   Inline: `code`, *bold* (or **bold**), _italic_, ~strike~, [label](url),
   bare links, @mentions and :emoji: names. A marker opens only after a space
   or punctuation and closes only before one, so snake_case_words and 2*3*4
   stay as typed (Slack's rule). */

export type Inline =
  | Readonly<{ kind: 'text'; text: string }>
  | Readonly<{ kind: 'code'; text: string }>
  | Readonly<{ kind: 'bold' | 'italic' | 'strike'; children: ReadonlyArray<Inline> }>
  | Readonly<{ kind: 'link'; url: string; children: ReadonlyArray<Inline> }>
  | Readonly<{ kind: 'mention'; handle: string }>
  | Readonly<{ kind: 'emoji'; glyph: string; name: string }>
  | Readonly<{ kind: 'break' }>

export type Block =
  | Readonly<{ kind: 'paragraph'; children: ReadonlyArray<Inline> }>
  | Readonly<{ kind: 'quote'; children: ReadonlyArray<Inline> }>
  | Readonly<{ kind: 'code'; text: string }>
  | Readonly<{ kind: 'bullets' | 'numbers'; items: ReadonlyArray<ReadonlyArray<Inline>>; start: number }>

const FENCE = '```'
const QUOTE = /^>\s?/
const BULLET = /^\s*[-*•]\s+/
const NUMBER = /^\s*(\d{1,4})[.)]\s+/

const isUrl = (url: string) => /^https?:\/\/[^\s<>"]+$/i.test(url)

/** Characters a marker may sit next to on its outer side. */
const isBoundary = (char: string | undefined) => char === undefined || /[\s.,;:!?()[\]{}"'<>/\\-]/.test(char)

const STYLE: Readonly<Record<string, 'bold' | 'italic' | 'strike'>> = { '*': 'bold', '_': 'italic', '~': 'strike' }

const pushText = (out: Array<Inline>, text: string) => {
  if (text === '') return
  const last = out.at(-1)
  if (last?.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text + text }
  else out.push({ kind: 'text', text })
}

/** Where a styled run opened at `start` (marker `mark`, `width` long) closes, or -1. */
const closing = (text: string, start: number, mark: string, width: number): number => {
  const from = start + width
  if (from >= text.length || /\s/.test(text[from] ?? '')) return -1
  for (let index = from; index < text.length; index++) {
    if (text[index] === '\n') return -1
    if (text.startsWith(mark.repeat(width), index) && index > from && !/\s/.test(text[index - 1] ?? '') && isBoundary(text[index + width])) return index
  }
  return -1
}

export const parseInline = (text: string): ReadonlyArray<Inline> => {
  const out: Array<Inline> = []
  let index = 0
  let plain = ''
  const flush = () => {
    pushText(out, plain)
    plain = ''
  }
  while (index < text.length) {
    const char = text[index] ?? ''
    const before = index === 0 ? undefined : text[index - 1]
    const rest = text.slice(index)
    if (char === '\n') {
      flush()
      out.push({ kind: 'break' })
      index += 1
      continue
    }
    if (char === '`') {
      const end = text.indexOf('`', index + 1)
      if (end > index + 1 && !text.slice(index + 1, end).includes('\n')) {
        flush()
        out.push({ kind: 'code', text: text.slice(index + 1, end) })
        index = end + 1
        continue
      }
    }
    if (char === '[') {
      const link = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)<>"]+)\)/i.exec(rest)
      if (link !== null) {
        flush()
        out.push({ kind: 'link', url: link[2] ?? '', children: parseInline(link[1] ?? '') })
        index += link[0].length
        continue
      }
    }
    if (char === '<') {
      const link = /^<(https?:\/\/[^\s|<>"]+)(?:\|([^>\n]+))?>/i.exec(rest)
      if (link !== null) {
        flush()
        const url = link[1] ?? ''
        out.push({ kind: 'link', url, children: link[2] === undefined ? [{ kind: 'text', text: url }] : parseInline(link[2]) })
        index += link[0].length
        continue
      }
    }
    if ((char === 'h' || char === 'H') && (before === undefined || /[\s(]/.test(before))) {
      const bare = /^https?:\/\/[^\s<>"]+/i.exec(rest)
      if (bare !== null) {
        // Trailing punctuation ends the sentence, not the link.
        const url = bare[0].replace(/[.,;:!?)]+$/, '')
        if (isUrl(url)) {
          flush()
          out.push({ kind: 'link', url, children: [{ kind: 'text', text: url }] })
          index += url.length
          continue
        }
      }
    }
    if (char === '@' && (before === undefined || /[\s(]/.test(before))) {
      const mention = /^@([A-Za-z][\w.-]*[\w]|[A-Za-z])/.exec(rest)
      if (mention !== null) {
        flush()
        out.push({ kind: 'mention', handle: (mention[1] ?? '').toLowerCase() })
        index += mention[0].length
        continue
      }
    }
    if (char === ':') {
      const code = /^:([a-z0-9_+-]+):/.exec(rest)
      const glyph = code === null ? undefined : emojiByName(code[1] ?? '')
      if (code !== null && glyph !== undefined) {
        flush()
        out.push({ kind: 'emoji', glyph, name: code[1] ?? '' })
        index += code[0].length
        continue
      }
    }
    const style = STYLE[char]
    if (style !== undefined && isBoundary(before)) {
      const width = char === '*' && text[index + 1] === '*' ? 2 : 1
      const end = closing(text, index, char, width)
      const inner = end === -1 ? '' : text.slice(index + width, end)
      if (end !== -1 && inner.trim() !== '') {
        flush()
        out.push({ kind: style, children: parseInline(inner) })
        index = end + width
        continue
      }
    }
    plain += char
    index += 1
  }
  flush()
  return out
}

const joinLines = (lines: ReadonlyArray<string>) => parseInline(lines.join('\n'))

export const parse = (text: string): ReadonlyArray<Block> => {
  const lines = text.split('\n')
  const blocks: Array<Block> = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trimStart().startsWith(FENCE)) {
      const opened = line.trimStart().slice(FENCE.length)
      // ```one line``` is a code block too.
      if (opened.endsWith(FENCE) && opened.length >= FENCE.length) {
        blocks.push({ kind: 'code', text: opened.slice(0, -FENCE.length) })
        index += 1
        continue
      }
      const body: Array<string> = opened === '' ? [] : [opened]
      let end = index + 1
      while (end < lines.length && !(lines[end] ?? '').includes(FENCE)) end += 1
      if (end < lines.length) {
        const last = lines[end] ?? ''
        const tail = last.slice(0, last.indexOf(FENCE))
        blocks.push({ kind: 'code', text: [...body, ...lines.slice(index + 1, end), ...(tail === '' ? [] : [tail])].join('\n') })
        index = end + 1
        continue
      }
    }
    if (QUOTE.test(line)) {
      const quoted: Array<string> = []
      while (index < lines.length && QUOTE.test(lines[index] ?? '')) {
        quoted.push((lines[index] ?? '').replace(QUOTE, ''))
        index += 1
      }
      blocks.push({ kind: 'quote', children: joinLines(quoted) })
      continue
    }
    if (BULLET.test(line) || NUMBER.test(line)) {
      const isNumbered = !BULLET.test(line)
      const pattern = isNumbered ? NUMBER : BULLET
      const start = isNumbered ? Number(NUMBER.exec(line)?.[1] ?? 1) : 1
      const items: Array<ReadonlyArray<Inline>> = []
      while (index < lines.length && pattern.test(lines[index] ?? '')) {
        items.push(parseInline((lines[index] ?? '').replace(pattern, '')))
        index += 1
      }
      blocks.push({ kind: isNumbered ? 'numbers' : 'bullets', items, start })
      continue
    }
    const paragraph: Array<string> = []
    while (index < lines.length) {
      const next = lines[index] ?? ''
      if (paragraph.length > 0 && (next.trimStart().startsWith(FENCE) || QUOTE.test(next) || BULLET.test(next) || NUMBER.test(next))) break
      paragraph.push(next)
      index += 1
      if (paragraph.length === 1 && next.trimStart().startsWith(FENCE)) break
    }
    blocks.push({ kind: 'paragraph', children: joinLines(paragraph) })
  }
  return blocks
}

/** The words of a message without its markup, for previews and search. */
export const plainText = (text: string): string => {
  const inline = (nodes: ReadonlyArray<Inline>): string =>
    nodes
      .map(node => {
        switch (node.kind) {
          case 'text':
          case 'code':
            return node.text
          case 'bold':
          case 'italic':
          case 'strike':
          case 'link':
            return inline(node.children)
          case 'mention':
            return `@${node.handle}`
          case 'emoji':
            return node.glyph
          case 'break':
            return ' '
        }
      })
      .join('')
  return parse(text)
    .map(block => {
      switch (block.kind) {
        case 'code':
          return block.text
        case 'bullets':
        case 'numbers':
          return block.items.map(inline).join(' ')
        case 'paragraph':
        case 'quote':
          return inline(block.children)
      }
    })
    .join(' ')
}
