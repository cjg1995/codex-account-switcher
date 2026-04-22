import fs from 'fs'
import path from 'path'

export function backupLiveAuthIfExists(livePath: string): string | null {
  const dir = path.dirname(livePath)
  if (!fs.existsSync(livePath)) return null
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const ts = Date.now()
  const backupPath = path.join(dir, `auth.json.bak.${ts}`)
  fs.copyFileSync(livePath, backupPath)
  return backupPath
}

export function atomicWriteAuthJson(livePath: string, contentUtf8: string): void {
  const dir = path.dirname(livePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.auth.json.tmp.${process.pid}.${Date.now()}`)
  fs.writeFileSync(tmp, contentUtf8, 'utf8')
  try {
    fs.renameSync(tmp, livePath)
  } catch {
    fs.copyFileSync(tmp, livePath)
    fs.unlinkSync(tmp)
  }
}
