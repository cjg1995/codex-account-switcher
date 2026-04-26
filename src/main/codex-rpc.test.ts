import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexRpcClient } from './codex-rpc'

describe('CodexRpcClient', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('对挂起的 RPC 请求执行超时兜底', async () => {
    vi.useFakeTimers()
    const client = new CodexRpcClient('codex', 'home') as any
    client.proc = {
      stdin: { write: vi.fn() },
      kill: vi.fn()
    }

    const pending = client.request('account/read', { refreshToken: true }, 1234)
    const assertion = expect(pending).rejects.toThrow('RPC account/read 超时（1234ms）')
    await vi.advanceTimersByTimeAsync(1234)
    await assertion
  })

  it('dispose 会拒绝所有未完成请求', async () => {
    const client = new CodexRpcClient('codex', 'home') as any
    client.proc = {
      stdin: { write: vi.fn() },
      kill: vi.fn()
    }

    const pending = client.request('account/rateLimits/read', {}, 5000)
    const assertion = expect(pending).rejects.toThrow('codex app-server 已关闭')
    client.dispose()
    await assertion
  })
})
