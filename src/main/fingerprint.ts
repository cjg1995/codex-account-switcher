import crypto from 'crypto'

function sortKeysDeep(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(sortKeysDeep)
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).sort()
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    out[k] = sortKeysDeep(o[k])
  }
  return out
}

export function normalizeAuthJsonString(raw: string): string {
  try {
    const o = JSON.parse(raw) as unknown
    return JSON.stringify(sortKeysDeep(o))
  } catch {
    return raw
  }
}

export function fingerprintFromAuthContent(content: string): string {
  const norm = normalizeAuthJsonString(content)
  return crypto.createHash('sha256').update(norm, 'utf8').digest('hex')
}

function normalizeKeyForVolatileCheck(k: string): string {
  return k.replace(/_/g, '').toLowerCase()
}

const VOLATILE_KEY_NORMALIZED = new Set([
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'expiresat',
  'expiresin',
  'lastrefresh',
  'tokentype',
  'devicetoken',
  'sessiontoken',
  'authorization'
])

function stripVolatileAuthFields(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(stripVolatileAuthFields)
  const o = v as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(o)) {
    if (VOLATILE_KEY_NORMALIZED.has(normalizeKeyForVolatileCheck(k))) continue
    out[k] = stripVolatileAuthFields(val)
  }
  return out
}

/** 忽略 access_token 等易变字段，用于判断 Live auth 与列表中哪条账号一致（token 刷新后仍能对上） */
export function stableFingerprintFromAuthContent(content: string): string | null {
  try {
    const o = JSON.parse(content) as unknown
    const authObj = o as {
      auth_mode?: unknown
      OPENAI_API_KEY?: unknown
      tokens?: { account_id?: unknown } | null
    }
    const accountId = authObj?.tokens?.account_id
    if (typeof accountId === 'string' && accountId.trim().length > 0) {
      const stableIdentity = {
        auth_mode: authObj.auth_mode ?? null,
        account_id: accountId.trim()
      }
      const norm = JSON.stringify(sortKeysDeep(stableIdentity))
      return crypto.createHash('sha256').update(norm, 'utf8').digest('hex')
    }
    if (typeof authObj?.OPENAI_API_KEY === 'string' && authObj.OPENAI_API_KEY.trim().length > 0) {
      const stableIdentity = {
        auth_mode: authObj.auth_mode ?? null,
        OPENAI_API_KEY: authObj.OPENAI_API_KEY.trim()
      }
      const norm = JSON.stringify(sortKeysDeep(stableIdentity))
      return crypto.createHash('sha256').update(norm, 'utf8').digest('hex')
    }
    const stripped = stripVolatileAuthFields(o)
    const norm = JSON.stringify(sortKeysDeep(stripped))
    return crypto.createHash('sha256').update(norm, 'utf8').digest('hex')
  } catch {
    return null
  }
}
