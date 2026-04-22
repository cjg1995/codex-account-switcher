import { execFileSync } from 'child_process'
import { app } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'

const CODEX_NAMES = ['codex.exe', 'codex.cmd', 'codex'] as const

function firstExistingInDir(dir: string): string | null {
  for (const name of CODEX_NAMES) {
    const p = path.join(dir, name)
    if (fs.existsSync(p)) return p
  }
  return null
}

function resolveCodexViaWhere(): string | null {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync('where.exe', ['codex'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    const lines = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    const lower = (s: string) => s.toLowerCase()
    const pick =
      lines.find((l) => lower(l).endsWith('codex.exe')) ??
      lines.find((l) => lower(l).endsWith('codex.cmd')) ??
      lines.find((l) => lower(l).endsWith('codex.bat')) ??
      lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) ??
      lines[0]
    if (!pick) return null
    return fs.existsSync(pick) ? pick : null
  } catch {
    return null
  }
}

export function getLiveAuthPath(): string {
  return path.join(os.homedir(), '.codex', 'auth.json')
}

export function getCodexDir(): string {
  return path.join(os.homedir(), '.codex')
}

export function resolveBundledCodexExe(): string | null {
  if (app.isPackaged) {
    const dir = path.join(process.resourcesPath, 'resources')
    return firstExistingInDir(dir)
  }
  const dirs = [
    path.join(process.cwd(), 'resources'),
    path.join(app.getAppPath(), 'resources')
  ]
  for (const dir of dirs) {
    const hit = firstExistingInDir(dir)
    if (hit) return hit
  }
  return null
}

export function resolveSystemCodexExe(): string | null {
  const viaWhere = resolveCodexViaWhere()
  if (viaWhere) return viaWhere

  const pathEnv = process.env.PATH ?? ''
  const parts = pathEnv.split(path.delimiter)
  for (const dir of parts) {
    if (!dir) continue
    const hit = firstExistingInDir(dir)
    if (hit) return hit
  }

  const npmGlobalCmd = path.join(process.env.APPDATA ?? '', 'npm', 'codex.cmd')
  if (fs.existsSync(npmGlobalCmd)) return npmGlobalCmd

  const nodeDir = path.dirname(process.execPath)
  const nodeCodex = firstExistingInDir(nodeDir)
  if (nodeCodex) return nodeCodex

  const local = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'codex', 'codex.exe')
  if (fs.existsSync(local)) return local
  return null
}

export function resolveCodexExecutable(): string | null {
  return resolveBundledCodexExe() ?? resolveSystemCodexExe()
}

export function getUserDataAccountsDir(): string {
  const d = path.join(app.getPath('userData'), 'data')
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
  return d
}

export function getAccountsJsonPath(): string {
  return path.join(getUserDataAccountsDir(), 'accounts.json')
}

export function blobPathForRef(ref: string): string {
  return path.join(getUserDataAccountsDir(), ref)
}
