import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

if (existsSync('.env')) process.loadEnvFile('.env')

/* Runs something against a throwaway database in the compose Postgres
   (`npm run db:up` first), so tests and checks never touch your data:

     node scripts/fresh-db.mjs test     the Postgres tests (npm run test:pg)
     node scripts/fresh-db.mjs check    demo content, a server on :4200 and the
                                        browser check (npm run check:fresh)
     

   The database (hyperchat_test / hyperchat_check) is dropped and created
   first, and left behind for a look afterwards. */

const mode = process.argv[2]
const useBun = process.argv.includes('--bun')
if (mode !== 'test' && mode !== 'check') {
  console.error('Usage: node scripts/fresh-db.mjs test | check [--bun]')
  process.exit(2)
}
const database = `hyperchat_${mode}`
const url = `postgres://hyperchat:${process.env.POSTGRES_PASSWORD ?? 'hyperchat-dev'}@localhost:${process.env.DB_PORT ?? 5435}/${database}`
const shell = process.platform === 'win32'

const run = (command, args, env = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: shell && (command === 'npm' || command === 'npx'),
      env: { ...process.env, ...env },
    })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)))
  })

await run('docker', ['compose', 'exec', '-T', 'db', 'psql', '-q', '-U', 'hyperchat', '-d', 'hyperchat', '-c', `DROP DATABASE IF EXISTS ${database}`, '-c', `CREATE DATABASE ${database}`])

if (mode === 'test') {
  if (useBun) await run('bun', ['--bun', 'node_modules/vitest/vitest.mjs', 'run', 'test/postgres.test.ts'], { TEST_DATABASE_URL: url })
  else await run('npx', ['vitest', 'run', 'test/postgres.test.ts'], { TEST_DATABASE_URL: url })
  process.exit(0)
}

await run('npm', ['run', 'build'])
if (useBun) await run('bun', ['scripts/demo.ts', 'seed', '--small'], { DATABASE_URL: url })
else await run('npx', ['tsx', 'scripts/demo.ts', 'seed', '--small'], { DATABASE_URL: url })
const port = 4200
const server = spawn(useBun ? 'bun' : process.execPath, useBun ? ['src/main.ts'] : ['--import', 'tsx', 'src/main.ts'], {
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, DATABASE_URL: url, PORT: String(port), OTEL_SERVICE_NAME: 'hyperchat-check' },
})
const stop = () => server.kill()
process.on('exit', stop)
for (let attempt = 0; ; attempt += 1) {
  const ready = await fetch(`http://localhost:${port}/login`, { signal: AbortSignal.timeout(2000) }).then(response => response.ok, () => false)
  if (ready) break
  if (attempt > 60) {
    console.error('The server did not start.')
    process.exit(1)
  }
  await new Promise(resolve => setTimeout(resolve, 500))
}
const env = { ...process.env, URL: `http://localhost:${port}` }
try {
  await run(process.execPath, ['scripts/check.mjs'], env)
  await run(process.execPath, ['scripts/check-overlays.mjs'], env)
} finally {
  stop()
}
