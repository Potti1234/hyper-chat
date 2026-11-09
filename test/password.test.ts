import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'

import { hashPassword, verifyPassword } from '@/app/password'

describe('password verification across runtimes', () => {
  it.live('accepts the correct password and rejects incorrect or unknown credentials', () =>
    Effect.gen(function* () {
      const hash = yield* hashPassword('demo-password')
      assert.isTrue(yield* verifyPassword('demo-password', hash))
      assert.isFalse(yield* verifyPassword('different-password', hash))
      assert.isFalse(yield* verifyPassword('demo-password', undefined))
    }),
  )

  it.live('normalizes equivalent Unicode passwords when hashing and verifying', () =>
    Effect.gen(function* () {
      const hash = yield* hashPassword('caf\u00e9-demo')
      assert.isTrue(yield* verifyPassword('cafe\u0301-demo', hash))
    }),
  )
})
