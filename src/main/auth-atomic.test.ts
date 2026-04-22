import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { atomicWriteAuthJson, backupLiveAuthIfExists } from './auth-atomic'

describe('auth-atomic', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true })
      } catch {
        /* */
      }
    }
  })

  it('原子写入后内容正确', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-test-'))
    dirs.push(dir)
    const live = path.join(dir, 'auth.json')
    atomicWriteAuthJson(live, '{"a":1}')
    expect(fs.readFileSync(live, 'utf8')).toBe('{"a":1}')
  })

  it('备份存在文件', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-test-'))
    dirs.push(dir)
    const live = path.join(dir, 'auth.json')
    fs.writeFileSync(live, 'old', 'utf8')
    const bak = backupLiveAuthIfExists(live)
    expect(bak).toBeTruthy()
    expect(fs.existsSync(bak!)).toBe(true)
    expect(fs.readFileSync(bak!, 'utf8')).toBe('old')
  })
})
