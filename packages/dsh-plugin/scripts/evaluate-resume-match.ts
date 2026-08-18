import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { evaluateResumeMatchGold, type ResumeMatchGoldCase } from '../src/resume-match-eval.ts'

const fixturePath = resolve(process.argv[2] ?? 'test/fixtures/resume-match-gold-v1.json')
const cases = JSON.parse(await readFile(fixturePath, 'utf8')) as ResumeMatchGoldCase[]
const report = await evaluateResumeMatchGold(cases)

console.log(JSON.stringify(report, null, 2))
if (report.failedCaseCount > 0) process.exitCode = 1
