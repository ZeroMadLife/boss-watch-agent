import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'

const repositoryDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceDir = resolve(process.env.DSH_SOURCE_DIR ?? join(repositoryDir, '..', 'deepseek-harness'))
const profile = process.env.DSH_PROFILE ?? 'web'
const port = process.env.DSH_WEB_PORT ?? '3080'
const dshHome = process.env.DSH_HOME ?? join(homedir(), 'Library', 'Application Support', 'BossWatchAgent', 'dsh')
const visionPatch = fileURLToPath(new URL('./dsh-vision-default.patch.yml', import.meta.url))

if (!existsSync(join(sourceDir, 'apps', 'cli', 'src', 'bin.ts'))) {
  console.error(`DSH source checkout not found: ${sourceDir}`)
  console.error('Set DSH_SOURCE_DIR to the local deepseek-harness checkout.')
  process.exit(1)
}

if (!existsSync(join(sourceDir, 'node_modules'))) {
  console.error(`DSH dependencies are missing: ${join(sourceDir, 'node_modules')}`)
  console.error(`Run pnpm install in ${sourceDir} first.`)
  process.exit(1)
}

console.log(`[dsh-dev] source=${sourceDir}`)
console.log(`[dsh-dev] profile=${profile} port=${port}`)
console.log(`[dsh-dev] DSH_HOME=${dshHome}`)
console.log(`[dsh-dev] vision patch=${visionPatch}`)

const gankInterviewApiKey = process.env.GANKINTERVIEW_API_KEY ?? readGankInterviewApiKey()
const childEnv = { ...process.env, DSH_HOME: dshHome }
if (gankInterviewApiKey !== undefined) childEnv.GANKINTERVIEW_API_KEY = gankInterviewApiKey

const child = spawn(
  process.execPath,
  ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--patch', visionPatch, '--profile', profile, '--port', port],
  {
    cwd: sourceDir,
    env: childEnv,
    stdio: 'inherit',
  },
)

const forwardSignal = (signal) => {
  if (!child.killed) child.kill(signal)
}

process.on('SIGINT', () => forwardSignal('SIGINT'))
process.on('SIGTERM', () => forwardSignal('SIGTERM'))

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})

function readGankInterviewApiKey() {
  if (process.platform !== 'darwin') return undefined
  try {
    const key = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-a', process.env.USER ?? '', '-s', 'gankinterview-api-key', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    return key.length > 0 ? key : undefined
  } catch {
    return undefined
  }
}
