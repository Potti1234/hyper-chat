import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

import { Effect } from 'effect'

/* Password hashes: scrypt with a random salt, stored as
   `scrypt$N$r$p$salt$hash` (base64url), so the cost can be raised later
   without breaking stored hashes. */

const N = 16_384
const R = 8
const P = 1
const KEY_LENGTH = 32

const derive = (password: string, salt: Buffer, n: number, r: number, p: number) =>
  Effect.callback<Buffer>(resume => {
    // Node reports success as null; Bun's compatible callback uses undefined.
    scrypt(password.normalize('NFC'), salt, KEY_LENGTH, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      resume(error === null || error === undefined ? Effect.succeed(key) : Effect.die(error)),
    )
  })

export const hashPassword = (password: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const salt = randomBytes(16)
    const key = yield* derive(password, salt, N, R, P)
    return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$')
  })

/** A hash that never matches, checked when the email is unknown, so a
 *  wrong email takes as long as a wrong password. */
const UNKNOWN = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(KEY_LENGTH).toString('base64url')}`

export const verifyPassword = (password: string, stored: string | undefined): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const [scheme, n, r, p, salt, hash] = (stored ?? UNKNOWN).split('$')
    if (scheme !== 'scrypt' || salt === undefined || hash === undefined) return false
    const expected = Buffer.from(hash, 'base64url')
    const actual = yield* derive(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p))
    return stored !== undefined && actual.length === expected.length && timingSafeEqual(actual, expected)
  })
