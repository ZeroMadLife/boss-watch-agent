import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'

const repositoryDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const rc2SourceDir = join(repositoryDir, '..', 'deepseek-harness-rc2')
const legacyRc8SourceDir = join(repositoryDir, '..', 'deepseek-harness-rc8')
const sourceDir = resolve(
  process.env.DSH_SOURCE_DIR
    ?? (existsSync(rc2SourceDir)
      ? rc2SourceDir
      : existsSync(legacyRc8SourceDir)
        ? legacyRc8SourceDir
        : join(repositoryDir, '..', 'deepseek-harness')),
)
const profile = process.env.DSH_PROFILE ?? 'web'
const port = process.env.DSH_WEB_PORT ?? '3080'
const openBrowser = process.env.DSH_OPEN_BROWSER === '1'
const defaultDshHome = sourceDir === resolve(rc2SourceDir)
  ? 'dsh-rc2-compat'
  : sourceDir === resolve(legacyRc8SourceDir)
    ? 'dsh-legacy-rc8-compat'
    : 'dsh'
const dshHome = process.env.DSH_HOME
  ?? join(homedir(), 'Library', 'Application Support', 'BossWatchAgent', defaultDshHome)
const visionPatch = process.env.DSH_VISION_PATCH === undefined
  ? undefined
  : resolve(process.env.DSH_VISION_PATCH || fileURLToPath(new URL('./dsh-vision-default.patch.yml', import.meta.url)))

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
console.log(`[dsh-dev] vision patch=${visionPatch ?? 'DSH profile default'}`)

const gankInterviewApiKey = process.env.GANKINTERVIEW_API_KEY ?? readGankInterviewApiKey()
const childEnv = { ...process.env, DSH_HOME: dshHome }
if (gankInterviewApiKey !== undefined) childEnv.GANKINTERVIEW_API_KEY = gankInterviewApiKey

const dshArgs = ['--import', 'tsx/esm', 'apps/cli/src/bin.ts']
if (visionPatch !== undefined) dshArgs.push('--patch', visionPatch)
dshArgs.push('--profile', profile, '--port', port)
if (!openBrowser) dshArgs.push('--no-open')

const child = spawn(
  process.execPath,
  dshArgs,
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
