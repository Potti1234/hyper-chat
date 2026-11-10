import { assert, describe, it } from '@effect/vitest'

import { parse, parseInline, plainText } from '@/app/mrkdwn'

describe('mrkdwn', () => {
  it('styles text inline', () => {
    assert.deepStrictEqual(parseInline('a *bold* _it_ ~gone~ `x*y*`'), [
      { kind: 'text', text: 'a ' },
      { kind: 'bold', children: [{ kind: 'text', text: 'bold' }] },
      { kind: 'text', text: ' ' },
      { kind: 'italic', children: [{ kind: 'text', text: 'it' }] },
      { kind: 'text', text: ' ' },
      { kind: 'strike', children: [{ kind: 'text', text: 'gone' }] },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'x*y*' },
    ])
    assert.deepStrictEqual(parseInline('**two** and *_both_*'), [
      { kind: 'bold', children: [{ kind: 'text', text: 'two' }] },
      { kind: 'text', text: ' and ' },
      { kind: 'bold', children: [{ kind: 'italic', children: [{ kind: 'text', text: 'both' }] }] },
    ])
  })

  it('leaves markers inside words and unclosed ones as typed', () => {
    assert.deepStrictEqual(parseInline('snake_case_name 2*3*4 * not * a_'), [{ kind: 'text', text: 'snake_case_name 2*3*4 * not * a_' }])
  })

  it('finds links, mentions and emoji names', () => {
    assert.deepStrictEqual(parseInline('see https://example.com/a. [docs](https://d.example) <https://x.example|X> @blake :tada:'), [
      { kind: 'text', text: 'see ' },
      { kind: 'link', url: 'https://example.com/a', children: [{ kind: 'text', text: 'https://example.com/a' }] },
      { kind: 'text', text: '. ' },
      { kind: 'link', url: 'https://d.example', children: [{ kind: 'text', text: 'docs' }] },
      { kind: 'text', text: ' ' },
      { kind: 'link', url: 'https://x.example', children: [{ kind: 'text', text: 'X' }] },
      { kind: 'text', text: ' ' },
      { kind: 'mention', handle: 'blake' },
      { kind: 'text', text: ' ' },
      { kind: 'emoji', glyph: '🎉', name: 'tada' },
    ])
    assert.deepStrictEqual(parseInline('mail a@b.c :nope: [x](javascript:alert)'), [{ kind: 'text', text: 'mail a@b.c :nope: [x](javascript:alert)' }])
  })

  it('splits blocks: code, quotes, lists and paragraphs', () => {
    const blocks = parse('Hi\nthere\n> quoted *bit*\n> more\n- one\n- two\n3. three\n4. four\n```\nconst a = *b*\n```\nend')
    assert.deepStrictEqual(blocks.map(block => block.kind), ['paragraph', 'quote', 'bullets', 'numbers', 'code', 'paragraph'])
    assert.deepStrictEqual(blocks[0], { kind: 'paragraph', children: [{ kind: 'text', text: 'Hi' }, { kind: 'break' }, { kind: 'text', text: 'there' }] })
    assert.deepStrictEqual(blocks[3], { kind: 'numbers', start: 3, items: [[{ kind: 'text', text: 'three' }], [{ kind: 'text', text: 'four' }]] })
    assert.deepStrictEqual(blocks[4], { kind: 'code', text: 'const a = *b*' })
    assert.deepStrictEqual(parse('```inline```'), [{ kind: 'code', text: 'inline' }])
    assert.deepStrictEqual(parse('``` not closed').map(block => block.kind), ['paragraph'])
  })

  it('reads back as plain words', () => {
    assert.strictEqual(plainText('*Ship* it\n- `now`'), 'Ship it now')
  })
})
