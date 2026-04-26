import { type ChildProcessWithoutNullStreams, spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import * as readline from 'readline'

type JsonRpcRequest = {
  method: string
  id?: number | string
  params?: unknown
}

type JsonRpcResponse = {
  id?: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type NotifyHandler = (params: unknown) => void

type SpawnTarget = {
  command: string
  args: string[]
}

const DEFAULT_RPC_TIMEOUT_MS = 20_000
const ACCOUNT_READ_TIMEOUT_MS = 30_000
const LOGIN_START_TIMEOUT_MS = 30_000
const CHAT_SEND_TIMEOUT_MS = 45_000

export type ChatMessageResult = {
  sessionRateLimits: unknown | null
}

export class CodexRpcClient {
  private proc: ChildProcessWithoutNullStreams | null = null
  private rl: readline.Interface | null = null
  private nextId = 1
  private stderrBuf = ''
  private lastServerRequest: { method: string; params: unknown } | null = null
  private pending = new Map<
    number | string,
    {
      method: string
      resolve: (v: unknown) => void
      reject: (e: Error) => void
      timeout: ReturnType<typeof setTimeout> | null
    }
  >()
  private notifyHandlers = new Map<string, Set<NotifyHandler>>()
  private loginWaitAbort: (() => void) | null = null

  constructor(
    private readonly codexExe: string,
    private readonly codexHome: string
  ) {}

  onNotify(method: string, fn: NotifyHandler): () => void {
    let set = this.notifyHandlers.get(method)
    if (!set) {
      set = new Set()
      this.notifyHandlers.set(method, set)
    }
    set.add(fn)
    return () => {
      set!.delete(fn)
    }
  }

  private appendStderr(chunk: Buffer | string): void {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    this.stderrBuf = (this.stderrBuf + s).slice(-6000)
  }

  private createChild(): ChildProcessWithoutNullStreams {
    const env: Record<string, string | undefined> = { ...process.env, CODEX_HOME: this.codexHome }
    delete env.ELECTRON_RUN_AS_NODE
    const cwd = this.codexHome
    const stdio = ['pipe', 'pipe', 'pipe'] as const

    const target = this.resolveSpawnTarget()
    return spawn(target.command, target.args, {
      stdio,
      env,
      cwd,
      windowsHide: true
    }) as ChildProcessWithoutNullStreams
  }

  private resolveSpawnTarget(): SpawnTarget {
    if (process.platform === 'win32' && !this.codexExe.toLowerCase().endsWith('.exe')) {
      const baseDir = path.dirname(this.codexExe)
      const jsPath = path.join(baseDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
      const nodeExe = path.join(baseDir, 'node.exe')
      if (path.basename(this.codexExe).toLowerCase().startsWith('codex') && fs.existsSync(jsPath)) {
        return {
          command: fs.existsSync(nodeExe) ? nodeExe : 'node',
          args: [jsPath, 'app-server']
        }
      }
    }

    return {
      command: this.codexExe,
      args: ['app-server']
    }
  }

  getLastStderrHint(): string {
    const t = this.stderrBuf.trim()
    return t ? t.slice(-2000) : ''
  }

  getLastServerRequest(): { method: string; params: unknown } | null {
    return this.lastServerRequest
  }

  private buildRpcTimeoutError(method: string, timeoutMs: number): Error {
    const lastServerMethod = this.lastServerRequest?.method ? `；最近服务端请求：${this.lastServerRequest.method}` : ''
    const stderrHint = this.getLastStderrHint()
    const stderrDetail = stderrHint ? `\n--- stderr ---\n${stderrHint}` : ''
    return new Error(`RPC ${method} 超时（${timeoutMs}ms）${lastServerMethod}${stderrDetail}`)
  }

  private rejectPending(id: number | string, error: Error): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (pending.timeout != null) clearTimeout(pending.timeout)
    pending.reject(error)
  }

  private rejectAllPending(error: Error): void {
    const entries = Array.from(this.pending.keys())
    for (const id of entries) {
      this.rejectPending(id, error)
    }
  }

  async start(): Promise<void> {
    if (this.proc) throw new Error('app-server 已启动')
    this.stderrBuf = ''
    this.proc = this.createChild()
    this.proc.stderr?.on('data', (c: Buffer) => this.appendStderr(c))
    this.proc.on('error', (err) => {
      this.rejectAllPending(err instanceof Error ? err : new Error(String(err)))
    })
    this.proc.on('exit', (code, signal) => {
      const hint = this.getLastStderrHint()
      const msg =
        hint.length > 0
          ? `codex app-server 退出 code=${code} signal=${signal}\n--- stderr ---\n${hint}`
          : `codex app-server 退出 code=${code} signal=${signal}`
      this.rejectAllPending(new Error(msg))
    })
    this.rl = readline.createInterface({ input: this.proc.stdout })
    this.rl.on('line', (line) => this.dispatchLine(line))
    await this.handshake()
  }

  private send(msg: JsonRpcRequest | JsonRpcResponse): void {
    if (!this.proc?.stdin) throw new Error('stdin 不可用')
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`)
  }

  private dispatchLine(line: string): void {
    const t = line.trim()
    if (!t) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(t) as Record<string, unknown>
    } catch {
      return
    }
    if (typeof msg.method === 'string' && msg.id !== undefined && msg.result === undefined && msg.error === undefined) {
      this.lastServerRequest = { method: msg.method, params: msg.params }
      this.handleServerRequest(msg as JsonRpcRequest)
      return
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const id = msg.id as number | string
      const p = this.pending.get(id)
      if (p) {
        this.pending.delete(id)
        if (p.timeout != null) clearTimeout(p.timeout)
        if (msg.error) {
          const e = msg.error as { message?: string }
          p.reject(new Error(e.message ?? 'JSON-RPC error'))
        } else {
          p.resolve(msg.result)
        }
      }
      return
    }
    if (typeof msg.method === 'string' && msg.id === undefined) {
      const method = msg.method
      const params = msg.params
      const set = this.notifyHandlers.get(method)
      if (set) {
        for (const fn of set) {
          try {
            fn(params)
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  private handleServerRequest(msg: JsonRpcRequest): void {
    const id = msg.id!
    if (msg.method === 'account/chatgptAuthTokens/refresh') {
      this.send({ id, result: {} })
      return
    }
    this.send({ id, result: {} })
  }

  private request<T>(method: string, params?: unknown, timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timeout =
        timeoutMs > 0
          ? setTimeout(() => {
              this.rejectPending(id, this.buildRpcTimeoutError(method, timeoutMs))
            }, timeoutMs)
          : null
      this.pending.set(id, {
        method,
        resolve: (v) => resolve(v as T),
        reject,
        timeout
      })
      try {
        this.send({ method, id, params })
      } catch (e) {
        this.rejectPending(id, e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  private async handshake(): Promise<void> {
    await this.request('initialize', {
      clientInfo: {
        name: 'codex-account-switcher',
        title: 'Codex Account Switcher',
        version: '1.0.0'
      },
      capabilities: {
        experimentalApi: true
      }
    })
    this.send({ method: 'initialized', params: {} })
  }

  async loginWithChatgpt(): Promise<{ loginId: string; authUrl: string }> {
    const res = (await this.request('account/login/start', {
      type: 'chatgpt'
    }, LOGIN_START_TIMEOUT_MS)) as {
      loginId?: string
      authUrl?: string
    }
    if (!res?.loginId || !res?.authUrl) {
      throw new Error('account/login/start 未返回 loginId 或 authUrl')
    }
    return { loginId: res.loginId, authUrl: res.authUrl }
  }

  async loginWithChatgptDeviceCode(): Promise<{
    loginId: string
    verificationUrl: string
    userCode: string
  }> {
    const res = (await this.request('account/login/start', {
      type: 'chatgptDeviceCode'
    }, LOGIN_START_TIMEOUT_MS)) as {
      loginId?: string
      verificationUrl?: string
      userCode?: string
    }
    if (!res?.loginId || !res?.verificationUrl || !res?.userCode) {
      throw new Error('account/login/start 未返回设备码登录所需字段')
    }
    return {
      loginId: res.loginId,
      verificationUrl: res.verificationUrl,
      userCode: res.userCode
    }
  }

  waitLoginCompleted(loginId: string, timeoutMs: number): Promise<{ success: boolean; error: string | null }> {
    return new Promise((resolve, reject) => {
      let to: ReturnType<typeof setTimeout> | undefined
      let offNotify: (() => void) | undefined
      const cleanup = (): void => {
        if (to != null) clearTimeout(to)
        offNotify?.()
        to = undefined
        offNotify = undefined
      }
      this.loginWaitAbort = () => {
        this.loginWaitAbort = null
        cleanup()
        reject(new Error('已取消登录'))
      }
      to = setTimeout(() => {
        this.loginWaitAbort = null
        cleanup()
        reject(new Error('登录超时'))
      }, timeoutMs)
      offNotify = this.onNotify('account/login/completed', (params) => {
        const p = params as { loginId?: string | null; success?: boolean; error?: string | null }
        if (p.loginId !== loginId) return
        this.loginWaitAbort = null
        cleanup()
        resolve({ success: !!p.success, error: p.error ?? null })
      })
    })
  }

  async readAccount(refreshToken: boolean): Promise<unknown> {
    return this.request('account/read', { refreshToken }, ACCOUNT_READ_TIMEOUT_MS)
  }

  async readRateLimits(): Promise<unknown> {
    return this.request('account/rateLimits/read', {})
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request('tools/call', { name: toolName, arguments: args })
  }

  async listTools(): Promise<unknown> {
    return this.request('tools/list', {})
  }

  private waitTurnCompleted(threadId: string, turnId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const off = this.onNotify('turn/completed', (params) => {
        const p = params as {
          threadId?: string
          turn?: {
            id?: string
            status?: string
            error?: { message?: string | null } | string | null
          }
        }
        if (p.threadId !== threadId || p.turn?.id !== turnId) return
        cleanup()
        const err = p.turn?.error
        if (err) {
          const msg = typeof err === 'string' ? err : (err.message ?? 'turn 执行失败')
          reject(new Error(msg))
          return
        }
        if (p.turn?.status && p.turn.status !== 'completed') {
          reject(new Error(`turn 未完成，状态=${p.turn.status}`))
          return
        }
        resolve()
      })

      const cleanup = (): void => {
        if (timer != null) clearTimeout(timer)
        off()
        timer = undefined
      }

      timer = setTimeout(() => {
        cleanup()
        reject(new Error('等待 turn/completed 超时'))
      }, timeoutMs)
    })
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private async readLatestRateLimitsFromSession(threadPath: string | null | undefined): Promise<unknown | null> {
    if (!threadPath) return null
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        if (fs.existsSync(threadPath)) {
          const raw = fs.readFileSync(threadPath, 'utf8')
          const lines = raw
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
          for (let i = lines.length - 1; i >= 0; i--) {
            let item: unknown
            try {
              item = JSON.parse(lines[i])
            } catch {
              continue
            }
            const row = item as {
              type?: string
              payload?: { type?: string; rate_limits?: unknown }
            }
            if (row.type === 'event_msg' && row.payload?.type === 'token_count' && row.payload.rate_limits != null) {
              return row.payload.rate_limits
            }
          }
        }
      } catch {
        /* session read failure should not break warmup */
      }
      await this.sleep(250)
    }
    return null
  }

  private async sendChatMessageViaTurnApi(message: string): Promise<ChatMessageResult> {
    const threadRes = (await this.request('thread/start', {}, DEFAULT_RPC_TIMEOUT_MS)) as {
      thread?: { id?: string | null; path?: string | null } | null
      threadId?: string | null
    }
    const threadId = threadRes.thread?.id ?? threadRes.threadId ?? null
    if (!threadId) throw new Error('thread/start 未返回 thread.id')
    const threadPath = threadRes.thread?.path ?? null

    const turnRes = (await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: message }]
    }, DEFAULT_RPC_TIMEOUT_MS)) as {
      turn?: { id?: string | null }
    }
    const turnId = turnRes.turn?.id ?? null
    if (!turnId) throw new Error('turn/start 未返回 turn.id')

    await this.waitTurnCompleted(threadId, turnId, 45000)
    return {
      sessionRateLimits: await this.readLatestRateLimitsFromSession(threadPath)
    }
  }

  async sendChatMessage(message: string): Promise<ChatMessageResult> {
    // 新版 app-server（0.118+）使用 thread/turn 协议
    let firstError: Error | null = null
    try {
      return await this.sendChatMessageViaTurnApi(message)
    } catch (e) {
      firstError = e instanceof Error ? e : new Error(String(e))
      // 继续尝试旧版兼容路径
    }

    // 尝试调用旧版聊天工具
    try {
      const tools = await this.listTools()
      const t = tools as { tools?: Array<{ name?: string }> }
      if (t.tools) {
        const chatTool = t.tools.find(
          (tool) =>
            tool.name?.toLowerCase().includes('chat') ||
            tool.name?.toLowerCase().includes('message') ||
            tool.name?.toLowerCase().includes('send')
        )
        if (chatTool?.name) {
          await this.callTool(chatTool.name, { message })
          return { sessionRateLimits: null }
        }
      }
    } catch {
      // 工具列表不可用，继续尝试下一个接口
    }

    // 兼容部分旧接口
    try {
      await this.request('chat/completions', {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: message }],
        max_tokens: 10
      }, CHAT_SEND_TIMEOUT_MS)
      return { sessionRateLimits: null }
    } catch {
      // 继续尝试
    }

    try {
      await this.request('chat/send', { message }, CHAT_SEND_TIMEOUT_MS)
      return { sessionRateLimits: null }
    } catch {
      const detail = firstError?.message?.trim()
      throw new Error(detail ? `发送聊天消息失败：${detail}` : '发送聊天消息失败')
    }
  }

  dispose(): void {
    if (this.loginWaitAbort) {
      const abort = this.loginWaitAbort
      this.loginWaitAbort = null
      try {
        abort()
      } catch {
        /* */
      }
    }
    try {
      this.rl?.close()
    } catch {
      /* */
    }
    this.rl = null
    try {
      this.proc?.kill()
    } catch {
      /* */
    }
    this.proc = null
    this.rejectAllPending(new Error('codex app-server 已关闭'))
    this.notifyHandlers.clear()
    this.stderrBuf = ''
    this.lastServerRequest = null
  }
}
