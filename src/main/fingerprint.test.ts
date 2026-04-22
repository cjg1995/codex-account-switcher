import { describe, expect, it } from 'vitest'
import {
  fingerprintFromAuthContent,
  normalizeAuthJsonString,
  stableFingerprintFromAuthContent
} from './fingerprint'

describe('fingerprint', () => {
  it('同内容不同键序指纹一致', () => {
    const a = JSON.stringify({ z: 1, a: 2 })
    const b = JSON.stringify({ a: 2, z: 1 })
    expect(fingerprintFromAuthContent(a)).toBe(fingerprintFromAuthContent(b))
  })

  it('normalize 非法 JSON 回退原文', () => {
    expect(normalizeAuthJsonString('not-json')).toBe('not-json')
  })

  it('稳定指纹忽略 access_token 和 last_refresh 变化', () => {
    const a = JSON.stringify({
      auth_mode: 'chatgpt',
      last_refresh: 1,
      tokens: { account_id: 'acc-1', access_token: 'aaa', refresh_token: 'r1' }
    })
    const b = JSON.stringify({
      auth_mode: 'chatgpt',
      last_refresh: 2,
      tokens: { account_id: 'acc-1', access_token: 'bbb', refresh_token: 'r2' }
    })
    expect(fingerprintFromAuthContent(a)).not.toBe(fingerprintFromAuthContent(b))
    expect(stableFingerprintFromAuthContent(a)).toBe(stableFingerprintFromAuthContent(b))
  })
})
