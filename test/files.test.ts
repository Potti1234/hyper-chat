import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, Layer, Option } from 'effect'

import { Files, MAX_FILE_BYTES, cleanName, mayRead, memoryLayer, sniffImageType } from '@/app/files'
import { Workspace } from '@/app/store'

import { workspaceLayer } from './support'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const layer = Layer.merge(workspaceLayer(), memoryLayer)

describe('files', () => {
  it('recognises images by their bytes, not their name', () => {
    assert.strictEqual(sniffImageType(PNG), 'image/png')
    assert.strictEqual(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
    assert.strictEqual(sniffImageType(new TextEncoder().encode('GIF89a')), 'image/gif')
    assert.strictEqual(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp')
    assert.isUndefined(sniffImageType(new TextEncoder().encode('<svg onload="alert(1)"/>')))
  })

  it('keeps file names safe to show and to send in a header', () => {
    assert.strictEqual(cleanName('C:\\Users\\me\\report "final".pdf'), 'report final.pdf')
    assert.strictEqual(cleanName('../../etc/passwd'), 'passwd')
    assert.strictEqual(cleanName('a\nb\u0000.txt'), 'ab.txt')
    assert.strictEqual(cleanName(''), 'file')
  })

  it.effect('stores an upload and treats anything but a known image as a download', () =>
    Effect.gen(function* () {
      const files = yield* Files
      const image = yield* files.put(new File([PNG], 'shot.txt', { type: 'text/plain' }), 'mem_avery')
      assert.deepInclude(image, { name: 'shot.txt', type: 'image/png', size: PNG.length })
      const page = yield* files.put(new File(['<script>alert(1)</script>'], 'page.html', { type: 'text/html' }), 'mem_avery')
      assert.strictEqual(page.type, 'application/octet-stream')
      const stored = yield* files.get(page.id)
      assert.strictEqual(Option.getOrThrow(stored).uploaderId, 'mem_avery')
      const empty = yield* Effect.exit(files.put(new File([], 'empty.txt'), 'mem_avery'))
      assert.isTrue(Exit.isFailure(empty))
      const large = yield* Effect.exit(files.put(new File([new Uint8Array(MAX_FILE_BYTES + 1)], 'big.bin'), 'mem_avery'))
      assert.isTrue(Exit.isFailure(large))
    }).pipe(Effect.provide(layer)),
  )

  it.effect('posts files with or without text, and only readers of the conversation get them', () =>
    Effect.gen(function* () {
      const files = yield* Files
      const workspace = yield* Workspace
      const file = yield* files.put(new File([PNG], 'plan.png'), 'mem_avery')
      const stored = Option.getOrThrow(yield* files.get(file.id))
      // Before it is sent only the uploader may see it.
      assert.isTrue(mayRead(yield* workspace.current, file.id, 'mem_avery', stored))
      assert.isFalse(mayRead(yield* workspace.current, file.id, 'mem_devon', stored))
      const message = yield* workspace.postMessage('ch_leads', '', 'mem_avery', { files: [file] })
      assert.deepStrictEqual(message.files, [file])
      assert.strictEqual(message.text, '')
      assert.isFalse(mayRead(yield* workspace.current, file.id, 'mem_devon', stored))
      // Shared in a public channel, everyone may.
      yield* workspace.postMessage('ch_general', 'Same plan', 'mem_avery', { files: [file] })
      assert.isTrue(mayRead(yield* workspace.current, file.id, 'mem_devon', stored))
      const nothing = yield* Effect.exit(workspace.postMessage('ch_general', '  ', 'mem_avery', { files: [] }))
      assert.isTrue(Exit.isFailure(nothing))
    }).pipe(Effect.provide(layer)),
  )
})
