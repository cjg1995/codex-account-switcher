import { randomUUID } from 'crypto'
import { clipboard, dialog, shell } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type {
  AccountStatus,
  AccountsStoreFile,
  ExportAuthJsonSummary,
  ImportAuthJsonSummary,
  LiveSessionInfo,
  LiveSessionStatus,
  QuotaCredits,
  QuotaSnapshot,
  QuotaWindow,
  SavedAccount,
  SwitchResult
} from '@shared/types'
import { getQuotaDisplayWindows } from '@shared/quota-summary'
import { atomicWriteAuthJson, backupLiveAuthIfExists } from './auth-atomic'
import { readEncryptedBlob, writeEncryptedBlob } from './crypto-blob'
import { CodexRpcClient } from './codex-rpc'
import { fingerprintFromAuthContent, stableFingerprintFromAuthContent } from './fingerprint'
import { mapRateLimitsToSnapshot, mapTokenCountRateLimitsToSnapshot, mapUsagePayloadToSnapshot } from './quota-map'
import { blobPathForRef, getAccountsJsonPath, getCodexDir, getLiveAuthPath, resolveCodexExecutable } from './paths'

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000
const AUTH_JSON_EXPORT_TYPE = 'codex-account-switcher-export'
const AUTH_JSON_EXPORT_VERSION = 1
const IMPORTED_JSON_EMAIL_PLACEHOLDER = '（JSON 导入，刷新后显示邮箱）'
const IMPORTED_EXPORT_EMAIL_PLACEHOLDER = '（备份导入，刷新后显示邮箱）'
const REFRESH_CONCURRENCY = 3

const ACCOUNT_STATUSES: AccountStatus[] = [
  'ok',
  'unauthorized',
  'no_quota',
  'app_server_failed',
  'snapshot_corrupt',
  'idle',
  'refreshing'
]

type ImportPlainOutcome = 'imported' | 'updated' | 'skipped'

type ImportAuthMetadata = {
  email?: string
  nickname?: string
  planType?: string | null
  addedAt?: string
  lastRefreshedAt?: string | null
  lastQuotaSnapshot?: QuotaSnapshot | null
  status?: AccountStatus
}

type ImportAuthEntry = {
  content: string
  placeholderEmail: string
  metadata?: ImportAuthMetadata
}

type RefreshAccountPatch = Partial<
  Pick<
    SavedAccount,
    'email' | 'planType' | 'lastQuotaSnapshot' | 'lastRefreshedAt' | 'status' | 'stableFingerprint'
  >
>

function emptyStore(): AccountsStoreFile {
  return { version: 1, accounts: [] }
}

function loadStore(): AccountsStoreFile {
  const p = getAccountsJsonPath()
  if (!fs.existsSync(p)) return emptyStore()
  try {
    const raw = fs.readFileSync(p, 'utf8')
    const o = JSON.parse(raw) as AccountsStoreFile
    if (!o.accounts) o.accounts = []
    return o
  } catch {
    return emptyStore()
  }
}

function saveStore(store: AccountsStoreFile): void {
  const p = getAccountsJsonPath()
  fs.writeFileSync(p, JSON.stringify(store, null, 2), 'utf8')
}

function readAuthJsonFromHome(codexHome: string): string {
  const p = path.join(codexHome, 'auth.json')
  if (!fs.existsSync(p)) throw new Error('临时目录未生成 auth.json')
  return fs.readFileSync(p, 'utf8')
}

function tryParseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content)
    return asRecord(parsed)
  } catch {
    return null
  }
}

function normalizeAuthContentForRuntime(content: string): string {
  const target = tryParseJsonObject(content)
  if (!target) return content

  const livePath = getLiveAuthPath()
  const live = fs.existsSync(livePath) ? tryParseJsonObject(fs.readFileSync(livePath, 'utf8')) : null
  const merged: Record<string, unknown> = {}

  if (live) {
    for (const key of Object.keys(live)) {
      if (key === 'tokens' || key === 'meta') continue
      merged[key] = live[key]
    }
  }

  for (const key of Object.keys(target)) {
    if (key === 'tokens' || key === 'meta') continue
    merged[key] = target[key]
  }

  merged.tokens = target.tokens
  if (target.meta != null) merged.meta = target.meta
  else if (live?.meta != null) merged.meta = live.meta

  if (merged.OPENAI_API_KEY === undefined) merged.OPENAI_API_KEY = null
  if (typeof merged.last_refresh !== 'string' || merged.last_refresh.trim().length === 0) {
    merged.last_refresh = new Date().toISOString()
  }

  return JSON.stringify(merged, null, 2)
}

function writeAuthToHome(codexHome: string, content: string): void {
  if (!fs.existsSync(codexHome)) fs.mkdirSync(codexHome, { recursive: true })
  const p = path.join(codexHome, 'auth.json')
  atomicWriteAuthJson(p, normalizeAuthContentForRuntime(content))
}

function parseChatgptAccount(readRes: unknown): { email: string | null; planType: string | null } {
  const r = readRes as {
    account?: { type?: string; email?: string; planType?: string } | null
  }
  const a = r.account
  if (!a) return { email: null, planType: null }
  if (a.type === 'apiKey') return { email: null, planType: null }
  return { email: a.email ?? null, planType: a.planType ?? null }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function emptyImportAuthJsonSummary(files = 0): ImportAuthJsonSummary {
  return {
    files,
    accounts: 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    accountIds: [],
    errors: []
  }
}

function mergeImportAuthJsonSummary(target: ImportAuthJsonSummary, source: ImportAuthJsonSummary): void {
  target.files += source.files
  target.accounts += source.accounts
  target.imported += source.imported
  target.updated += source.updated
  target.skipped += source.skipped
  target.failed += source.failed
  for (const accountId of source.accountIds) {
    if (!target.accountIds.includes(accountId)) target.accountIds.push(accountId)
  }
  target.errors.push(...source.errors)
}

function countImportPlainOutcome(summary: ImportAuthJsonSummary, outcome: ImportPlainOutcome): void {
  summary.accounts += 1
  if (outcome === 'imported') summary.imported += 1
  else if (outcome === 'updated') summary.updated += 1
  else summary.skipped += 1
}

function addImportedAccountId(summary: ImportAuthJsonSummary, accountId: string): void {
  if (!summary.accountIds.includes(accountId)) summary.accountIds.push(accountId)
}

function stringFromMetadata(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function nullableStringFromMetadata(value: unknown): string | null | undefined {
  if (value === null) return null
  return stringFromMetadata(value)
}

function quotaSnapshotFromMetadata(value: unknown): QuotaSnapshot | null | undefined {
  if (value === null) return null
  if (asRecord(value)) return value as QuotaSnapshot
  return undefined
}

function accountStatusFromMetadata(value: unknown): AccountStatus | undefined {
  if (typeof value !== 'string') return undefined
  if (!ACCOUNT_STATUSES.includes(value as AccountStatus)) return undefined
  return value === 'refreshing' ? 'idle' : (value as AccountStatus)
}

function parseJsonObjectOrThrow(content: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error(`${label} JSON 解析失败`)
  }
  const obj = asRecord(parsed)
  if (!obj) throw new Error(`${label} 应为 JSON 对象`)
  return obj
}

function stringifyAuthJsonValue(value: unknown, label: string): string {
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error(`${label} 的 authJson 字符串不是有效 JSON`)
    }
  }
  if (!asRecord(parsed)) throw new Error(`${label} 的 authJson 应为 JSON 对象`)
  return JSON.stringify(parsed, null, 2)
}

function metadataFromExportedAccount(account: Record<string, unknown>): ImportAuthMetadata {
  const metadata: ImportAuthMetadata = {}
  const email = stringFromMetadata(account.email)
  const nickname = stringFromMetadata(account.nickname)
  const planType = nullableStringFromMetadata(account.planType)
  const addedAt = stringFromMetadata(account.addedAt)
  const lastRefreshedAt = nullableStringFromMetadata(account.lastRefreshedAt)
  const lastQuotaSnapshot = quotaSnapshotFromMetadata(account.lastQuotaSnapshot)
  const status = accountStatusFromMetadata(account.status)

  if (email) metadata.email = email
  if (nickname) metadata.nickname = nickname
  if (planType !== undefined) metadata.planType = planType
  if (addedAt) metadata.addedAt = addedAt
  if (lastRefreshedAt !== undefined) metadata.lastRefreshedAt = lastRefreshedAt
  if (lastQuotaSnapshot !== undefined) metadata.lastQuotaSnapshot = lastQuotaSnapshot
  if (status) metadata.status = status
  return metadata
}

function parseAuthJsonImportEntries(filePath: string, content: string): ImportAuthEntry[] {
  const parsed = parseJsonObjectOrThrow(content, path.basename(filePath))

  if (parsed.type === AUTH_JSON_EXPORT_TYPE) {
    if (parsed.version !== AUTH_JSON_EXPORT_VERSION) {
      throw new Error(`不支持的导出文件版本：${String(parsed.version)}`)
    }
    if (!Array.isArray(parsed.accounts)) {
      throw new Error('导出文件缺少 accounts 数组')
    }
    return parsed.accounts.map((item, index) => {
      const account = asRecord(item)
      if (!account) throw new Error(`导出文件第 ${index + 1} 个账号不是 JSON 对象`)
      const label = `导出文件第 ${index + 1} 个账号`
      const metadata = metadataFromExportedAccount(account)
      return {
        content: stringifyAuthJsonValue(account.authJson, label),
        placeholderEmail: metadata.email ?? IMPORTED_EXPORT_EMAIL_PLACEHOLDER,
        metadata
      }
    })
  }

  return [{ content, placeholderEmail: IMPORTED_JSON_EMAIL_PLACEHOLDER }]
}

function exportAccountLabel(account: SavedAccount): string {
  return account.nickname || account.email || account.id
}

function sanitizeExportFileName(value: string): string {
  let safe = value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')

  if (!safe) safe = 'account'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe)) safe = `_${safe}`
  return safe.length > 120 ? safe.slice(0, 120).replace(/[. ]+$/g, '') : safe
}

function exportFileBaseName(account: SavedAccount, index: number): string {
  const parts = [account.nickname, account.email]
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith('（'))
  const uniqueParts = parts.filter((part, partIndex) => parts.indexOf(part) === partIndex)
  return sanitizeExportFileName(uniqueParts.join(' - ') || `account-${index + 1}-${account.id.slice(0, 8)}`)
}

function uniqueExportFilePath(directoryPath: string, baseName: string, usedPaths: Set<string>): string {
  let suffix = 0
  while (true) {
    const name = suffix === 0 ? `${baseName}.json` : `${baseName} (${suffix + 1}).json`
    const candidate = path.join(directoryPath, name)
    const key = candidate.toLowerCase()
    if (!usedPaths.has(key) && !fs.existsSync(candidate)) {
      usedPaths.add(key)
      return candidate
    }
    suffix += 1
  }
}

function uniqueAccountIds(accountIds: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const accountId of accountIds) {
    if (seen.has(accountId)) continue
    seen.add(accountId)
    out.push(accountId)
  }
  return out
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, limit), items.length)

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex
        nextIndex += 1
        if (index >= items.length) return
        results[index] = await worker(items[index], index)
      }
    })
  )

  return results
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function hasWindowSignal(value: unknown): boolean {
  const obj = asRecord(value)
  if (!obj) return false
  return (
    toNullableNumber(obj.usedPercent) != null ||
    toNullableNumber(obj.windowDurationMins) != null ||
    toNullableNumber(obj.resetsAt) != null
  )
}

function pickBucketForCompletenessCheck(rateRaw: unknown): Record<string, unknown> | null {
  const root = asRecord(rateRaw)
  if (!root) return null

  const byId = asRecord(root.rateLimitsByLimitId)
  if (byId) {
    const codex = asRecord(byId.codex)
    if (codex) return codex
    for (const key of Object.keys(byId)) {
      const item = asRecord(byId[key])
      if (item) return item
    }
  }
  return asRecord(root.rateLimits)
}

function isRateLimitsPayloadIncomplete(rateRaw: unknown): boolean {
  const bucket = pickBucketForCompletenessCheck(rateRaw)
  if (!bucket) return true

  const primary = asRecord(bucket.primary)
  const secondary = asRecord(bucket.secondary)
  const hasPrimary = hasWindowSignal(primary)
  const hasSecondary = hasWindowSignal(secondary)
  if (!hasPrimary && !hasSecondary) return true

  const primaryDuration = toNullableNumber(primary?.windowDurationMins)
  const secondaryDuration = toNullableNumber(secondary?.windowDurationMins)
  return primaryDuration == null && secondaryDuration == null
}

function findStringByKeysDeep(value: unknown, keys: Set<string>): string | null {
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (!cur || typeof cur !== 'object') continue
    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item)
      continue
    }
    const rec = cur as Record<string, unknown>
    for (const key of Object.keys(rec)) {
      const v = rec[key]
      if (keys.has(key.toLowerCase()) && typeof v === 'string' && v.trim().length > 0) {
        return v.trim()
      }
      if (v && typeof v === 'object') stack.push(v)
    }
  }
  return null
}

function extractAccessTokenFromAuthContent(content: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  const root = asRecord(parsed)
  const direct = root?.tokens
  const directObj = asRecord(direct)
  const directToken = directObj?.access_token
  if (typeof directToken === 'string' && directToken.trim().length > 0) {
    return directToken.trim()
  }
  return findStringByKeysDeep(parsed, new Set(['access_token', 'accesstoken']))
}

function shouldUseDeviceCodeLogin(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase()
  return (
    msg.includes('failed to start login server') ||
    msg.includes('already in use') ||
    msg.includes('port 127.0.0.1:1455')
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function quotaMutationSignature(snapshot: QuotaSnapshot | null): string {
  if (!snapshot) return 'null'
  const extras = (snapshot.buckets ?? [])
    .map(
      (b) =>
        `${b.limitId}:${b.primary?.usedPercent ?? ''}:${b.primary?.resetsAt ?? ''}:${b.secondary?.usedPercent ?? ''}:${b.secondary?.resetsAt ?? ''}`
    )
    .join('|')
  return [
    snapshot.limitId,
    snapshot.primary?.usedPercent ?? '',
    snapshot.primary?.resetsAt ?? '',
    snapshot.secondary?.usedPercent ?? '',
    snapshot.secondary?.resetsAt ?? '',
    extras
  ].join('#')
}

function summarizeWindow(window: QuotaWindow | null | undefined): Record<string, number | null> | null {
  if (!window) return null
  return {
    usedPercent: window.usedPercent ?? null,
    resetsAt: window.resetsAt ?? null,
    windowDurationMins: window.windowDurationMins ?? null
  }
}

function summarizeSnapshot(snapshot: QuotaSnapshot | null): Record<string, unknown> | null {
  if (!snapshot) return null
  return {
    limitId: snapshot.limitId,
    planType: snapshot.planType ?? null,
    primary: summarizeWindow(snapshot.primary),
    secondary: summarizeWindow(snapshot.secondary),
    signature: quotaMutationSignature(snapshot)
  }
}

function summarizeAuthContent(content: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return {
      parseOk: false,
      hasAccessToken: false,
      topLevelKeys: []
    }
  }
  const root = asRecord(parsed)
  const tokens = asRecord(root?.tokens)
  const meta = asRecord(root?.meta)
  return {
    parseOk: true,
    hasAccessToken: !!extractAccessTokenFromAuthContent(content),
    hasTokensObject: !!tokens,
    topLevelKeys: root ? Object.keys(root) : [],
    tokenKeys: tokens ? Object.keys(tokens) : [],
    metaKeys: meta ? Object.keys(meta) : []
  }
}

function shouldWarmupInBatch(snapshot: QuotaSnapshot | null): boolean {
  if (!snapshot) return false
  const display = getQuotaDisplayWindows(snapshot)
  return [display.fiveHour, display.sevenDay].some((item) => item.provided && item.remaining === 100)
}

type WarmupCaptureResult = {
  email: string | null
  planType: string | null
  credits: QuotaCredits | null
  sessionRaw: unknown | null
  sessionSnapshot: QuotaSnapshot | null
  authoritativeSnapshot: QuotaSnapshot | null
  sendError: string | null
}

export type WarmupOneResult = {
  account: SavedAccount
  mode: 'warmed' | 'refreshed' | 'failed'
  message: string
}

async function fetchUsageSnapshotByAccessToken(accessToken: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      },
      signal: controller.signal
    })
    if (!res.ok) {
      throw new Error(`usage endpoint status ${res.status}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export class AccountService {
  private loginSession: { client: CodexRpcClient; home: string } | null = null

  cancelAddViaLogin(): void {
    const s = this.loginSession
    if (!s) return
    try {
      s.client.dispose()
    } catch {
      /* */
    }
  }

  private tryReadStableFromTempHome(home: string): string | undefined {
    try {
      const raw = readAuthJsonFromHome(home)
      return stableFingerprintFromAuthContent(raw) ?? undefined
    } catch {
      return undefined
    }
  }

  private patchStoredAccount(accountId: string, patch: RefreshAccountPatch): SavedAccount {
    const store = loadStore()
    const acc = store.accounts.find((a) => a.id === accountId)
    if (!acc) throw new Error('未找到账号')
    Object.assign(acc, patch)
    saveStore(store)
    return acc
  }

  private saveRefreshedAccount(accountId: string, patch: RefreshAccountPatch, dedupeEmail?: string | null): SavedAccount {
    const store = loadStore()
    const acc = store.accounts.find((a) => a.id === accountId)
    if (!acc) throw new Error('未找到账号')

    if (dedupeEmail) {
      const dupIdx = store.accounts.findIndex(
        (a) => a.id !== accountId && a.email.toLowerCase() === dedupeEmail.toLowerCase()
      )
      if (dupIdx >= 0) {
        try {
          const blobPath = blobPathForRef(store.accounts[dupIdx].encryptedAuthBlobRef)
          if (fs.existsSync(blobPath)) fs.unlinkSync(blobPath)
        } catch {
          /* */
        }
        store.accounts.splice(dupIdx, 1)
      }
    }

    Object.assign(acc, patch)
    saveStore(store)
    return acc
  }

  private async readRateLimitsWithRepair(client: CodexRpcClient): Promise<unknown> {
    let rateRaw = await client.readRateLimits()
    if (!isRateLimitsPayloadIncomplete(rateRaw)) return rateRaw

    // 配额窗口信息缺失时，发送一次最小对话触发服务端刷新，再重读。
    try {
      await client.sendChatMessage('hi')
    } catch {
      return rateRaw
    }

    try {
      rateRaw = await client.readRateLimits()
    } catch {
      // 重读失败时保留第一次结果，避免直接报错中断刷新流程。
    }
    return rateRaw
  }

  private async readUsageSnapshotFromHome(home: string): Promise<unknown> {
    const authContent = readAuthJsonFromHome(home)
    const accessToken = extractAccessTokenFromAuthContent(authContent)
    if (!accessToken) throw new Error('auth.json 缺少 access_token')
    return fetchUsageSnapshotByAccessToken(accessToken)
  }

  private async readUsageQuotaSnapshotFromHome(
    home: string,
    planTypeFallback: string | null,
    creditsFallback: QuotaCredits | null
  ): Promise<QuotaSnapshot | null> {
    const usageRaw = await this.readUsageSnapshotFromHome(home)
    return mapUsagePayloadToSnapshot(usageRaw, planTypeFallback, creditsFallback)
  }

  private async captureWarmupSnapshotFromClient(
    client: CodexRpcClient,
    home: string,
    planTypeFallback: string | null
  ): Promise<WarmupCaptureResult> {
    const readRes = await client.readAccount(true)
    const { email, planType } = parseChatgptAccount(readRes)
    const credits = extractCreditsFromAccountRead(readRes)
    const effectivePlanType = planType ?? planTypeFallback
    let baseline: QuotaSnapshot | null = null
    try {
      baseline = await this.readUsageQuotaSnapshotFromHome(home, effectivePlanType, credits)
    } catch {
      /* baseline 缺失时仍继续预热 */
    }
    const baselineSig = quotaMutationSignature(baseline)
    try {
      const sendRes = await client.sendChatMessage('hi')
      const sessionSnapshot = mapTokenCountRateLimitsToSnapshot(sendRes.sessionRateLimits, effectivePlanType, credits)
      const sessionSig = quotaMutationSignature(sessionSnapshot)
      let authoritativeSnapshot: QuotaSnapshot | null = null

      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt > 0) await sleep(1500)
        try {
          const current = await this.readUsageQuotaSnapshotFromHome(home, effectivePlanType, credits)
          const currentSig = quotaMutationSignature(current)
          if (currentSig === sessionSig || currentSig !== baselineSig) {
            authoritativeSnapshot = current
            break
          }
        } catch {
          /* usage polling failure should not break warmup */
        }
      }

      if (!authoritativeSnapshot) {
        try {
          const rateRaw = await client.readRateLimits()
          const rateSnapshot = mapRateLimitsToSnapshot(
            rateRaw as Parameters<typeof mapRateLimitsToSnapshot>[0],
            effectivePlanType,
            credits
          )
          const rateSig = quotaMutationSignature(rateSnapshot)
          if (rateSnapshot && (rateSig === sessionSig || rateSig !== baselineSig)) {
            authoritativeSnapshot = rateSnapshot
          }
        } catch {
          /* rate limit fallback should not break warmup */
        }
      }

      return {
        email,
        planType,
        credits,
        sessionRaw: sendRes.sessionRateLimits,
        sessionSnapshot,
        authoritativeSnapshot,
        sendError: null
      }
    } catch (e) {
      return {
        email,
        planType,
        credits,
        sessionRaw: null,
        sessionSnapshot: null,
        authoritativeSnapshot: null,
        sendError: e instanceof Error ? e.message : String(e)
      }
    }
  }

  private async captureWarmupSnapshotUsingTempHome(
    codex: string,
    authContent: string,
    planTypeFallback: string | null
  ): Promise<WarmupCaptureResult> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-warmup-capture-'))
    let client: CodexRpcClient | null = null
    try {
      writeAuthToHome(home, authContent)
      client = new CodexRpcClient(codex, home)
      await client.start()
      return await this.captureWarmupSnapshotFromClient(client, home, planTypeFallback)
    } finally {
      client?.dispose()
      try {
        fs.rmSync(home, { recursive: true, force: true })
      } catch {
        /* */
      }
    }
  }

  private async captureWarmupSnapshotUsingLiveHome(
    codex: string,
    authContent: string,
    planTypeFallback: string | null
  ): Promise<WarmupCaptureResult> {
    const livePath = getLiveAuthPath()
    const liveDir = getCodexDir()
    const originalLive = fs.existsSync(livePath) ? fs.readFileSync(livePath, 'utf8') : null
    let client: CodexRpcClient | null = null
    try {
      fs.mkdirSync(liveDir, { recursive: true })
      atomicWriteAuthJson(livePath, normalizeAuthContentForRuntime(authContent))
      client = new CodexRpcClient(codex, liveDir)
      await client.start()
      return await this.captureWarmupSnapshotFromClient(client, liveDir, planTypeFallback)
    } finally {
      client?.dispose()
      try {
        if (originalLive == null) {
          if (fs.existsSync(livePath)) fs.rmSync(livePath, { force: true })
        } else {
          atomicWriteAuthJson(livePath, originalLive)
        }
      } catch {
        /* */
      }
    }
  }

  private async waitForQuotaMutation(
    home: string,
    baseline: QuotaSnapshot | null,
    planTypeFallback: string | null,
    creditsFallback: QuotaCredits | null,
    timeoutMs: number
  ): Promise<boolean> {
    const startedAt = Date.now()
    const baselineSig = quotaMutationSignature(baseline)
    while (Date.now() - startedAt < timeoutMs) {
      await sleep(1200)
      try {
        const current = await this.readUsageQuotaSnapshotFromHome(home, planTypeFallback, creditsFallback)
        if (quotaMutationSignature(current) !== baselineSig) return true
      } catch {
        /* polling failure should not abort warmup */
      }
    }
    return false
  }

  listAccounts(): {
    accounts: SavedAccount[]
    activeAccountId: string | null
    liveAuthPresent: boolean
  } {
    const store = loadStore()
    const live = getLiveAuthPath()
    const liveAuthPresent = fs.existsSync(live)
    let liveFp: string | null = null
    let liveStable: string | null = null
    try {
      if (liveAuthPresent) {
        const raw = fs.readFileSync(live, 'utf8')
        liveFp = fingerprintFromAuthContent(raw)
        liveStable = stableFingerprintFromAuthContent(raw)
      }
    } catch {
      liveFp = null
      liveStable = null
    }
    let storeMutated = false
    for (const a of store.accounts) {
      try {
        const plain = readEncryptedBlob(blobPathForRef(a.encryptedAuthBlobRef))
        const s = stableFingerprintFromAuthContent(plain)
        if (s && a.stableFingerprint !== s) {
          a.stableFingerprint = s
          storeMutated = true
        }
      } catch {
        /* */
      }
    }
    let activeAccountId: string | null = null
    if (liveStable) {
      for (const a of store.accounts) {
        if (a.stableFingerprint === liveStable) {
          activeAccountId = a.id
          break
        }
      }
    }
    if (!activeAccountId && liveFp) {
      for (const a of store.accounts) {
        if (a.fingerprint === liveFp) {
          activeAccountId = a.id
          break
        }
      }
    }
    if (storeMutated) saveStore(store)
    return { accounts: store.accounts, activeAccountId, liveAuthPresent }
  }

  async addViaLogin(): Promise<SavedAccount> {
    const codex = resolveCodexExecutable()
    if (!codex) {
      throw new Error(
        '未找到 codex CLI。请安装 @openai/codex 并确保终端能执行 codex（npm 全局多为 codex.cmd），或将 codex.exe 放到项目 resources 目录。'
      )
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-login-'))
    fs.mkdirSync(home, { recursive: true })
    let client: CodexRpcClient | null = null
    try {
      client = new CodexRpcClient(codex, home)
      this.loginSession = { client, home }
      await client.start()
      let loginId: string
      try {
        const webLogin = await client.loginWithChatgpt()
        loginId = webLogin.loginId
        await shell.openExternal(webLogin.authUrl)
      } catch (e) {
        if (!shouldUseDeviceCodeLogin(e)) throw e

        const deviceLogin = await client.loginWithChatgptDeviceCode()
        loginId = deviceLogin.loginId
        clipboard.writeText(deviceLogin.userCode)
        await shell.openExternal(deviceLogin.verificationUrl)
        await dialog.showMessageBox({
          type: 'info',
          title: '切换到设备码登录',
          message: '本地登录端口被占用，已切换到设备码登录。',
          detail:
            `已自动打开登录页面，并将验证码复制到剪贴板。\n\n` +
            `验证码: ${deviceLogin.userCode}\n` +
            `登录地址: ${deviceLogin.verificationUrl}`
        })
      }
      const done = await client.waitLoginCompleted(loginId, LOGIN_TIMEOUT_MS)
      this.loginSession = null
      if (!done.success) {
        throw new Error(done.error || '登录失败')
      }
      const readRes = await client.readAccount(false)
      const { email, planType } = parseChatgptAccount(readRes)
      const authContent = readAuthJsonFromHome(home)
      const fingerprint = fingerprintFromAuthContent(authContent)
      const stableFingerprint = stableFingerprintFromAuthContent(authContent) ?? undefined
      const id = randomUUID()
      const ref = `blob.${id}.enc`
      const blobAbs = blobPathForRef(ref)
      writeEncryptedBlob(blobAbs, authContent)

      const acc: SavedAccount = {
        id,
        email: email ?? '(未知邮箱)',
        planType,
        nickname: '',
        fingerprint,
        stableFingerprint,
        encryptedAuthBlobRef: ref,
        lastQuotaSnapshot: null,
        status: 'idle',
        addedAt: new Date().toISOString(),
        lastRefreshedAt: null
      }
      const store = loadStore()
      store.accounts.push(acc)
      saveStore(store)
      return acc
    } finally {
      this.loginSession = null
      client?.dispose()
      try {
        fs.rmSync(home, { recursive: true, force: true })
      } catch {
        /* */
      }
    }
  }

  async switchAccount(accountId: string): Promise<SwitchResult> {
    const store = loadStore()
    const acc = store.accounts.find((a) => a.id === accountId)
    if (!acc) {
      return {
        success: false,
        activeAccountId: null,
        backupPath: null,
        warning: '未找到账号'
      }
    }
    let plain: string
    try {
      plain = readEncryptedBlob(blobPathForRef(acc.encryptedAuthBlobRef))
    } catch {
      return {
        success: false,
        activeAccountId: null,
        backupPath: null,
        warning: '本地快照损坏，无法解密'
      }
    }
    const live = getLiveAuthPath()
    const backupPath = backupLiveAuthIfExists(live)
    try {
      atomicWriteAuthJson(live, normalizeAuthContentForRuntime(plain))
    } catch (e) {
      return {
        success: false,
        activeAccountId: null,
        backupPath,
        warning: e instanceof Error ? e.message : String(e)
      }
    }
    const { activeAccountId } = this.listAccounts()
    return {
      success: true,
      activeAccountId,
      backupPath,
      warning: '已有 Codex / IDE 会话可能需要重开后才会使用新账号'
    }
  }

  async refreshOne(accountId: string): Promise<SavedAccount> {
    const store = loadStore()
    const acc = store.accounts.find((a) => a.id === accountId)
    if (!acc) throw new Error('未找到账号')

    let plain: string
    try {
      plain = readEncryptedBlob(blobPathForRef(acc.encryptedAuthBlobRef))
    } catch {
      return this.patchStoredAccount(accountId, { status: 'snapshot_corrupt' })
    }

    const codex = resolveCodexExecutable()
    if (!codex) {
      return this.patchStoredAccount(accountId, { status: 'app_server_failed' })
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-quota-'))
    let client: CodexRpcClient | null = null
    const initialPlanType = acc.planType
    let dedupeEmail: string | null = null
    this.patchStoredAccount(accountId, { status: 'refreshing' })

    try {
      writeAuthToHome(home, plain)
      client = new CodexRpcClient(codex, home)
      await client.start()
      let readRes: unknown
      try {
        readRes = await client.readAccount(true)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const patch: RefreshAccountPatch = {
          status: /401|unauthor|expired|token/i.test(msg) ? 'unauthorized' : 'app_server_failed',
          lastRefreshedAt: new Date().toISOString()
        }
        const stable = this.tryReadStableFromTempHome(home)
        if (stable) patch.stableFingerprint = stable
        return this.saveRefreshedAccount(accountId, patch)
      }
      const { email, planType } = parseChatgptAccount(readRes)
      dedupeEmail = email
      const effectivePlanType = planType ?? initialPlanType
      const patch: RefreshAccountPatch = {}
      if (email) {
        patch.email = email
      }
      if (planType) patch.planType = planType

      const creditsFromAccount = extractCreditsFromAccountRead(readRes)
      let snap: QuotaSnapshot | null = null

      // 优先使用实时 usage 接口，避免显示历史缓存数据。
      try {
        const usageRaw = await this.readUsageSnapshotFromHome(home)
        snap = mapUsagePayloadToSnapshot(usageRaw, effectivePlanType, creditsFromAccount)
      } catch {
        // usage 接口失败时再走 app-server 的 rateLimits/read
      }

      if (!snap) {
        let rateRaw: unknown
        try {
          rateRaw = await this.readRateLimitsWithRepair(client)
        } catch {
          patch.status = 'no_quota'
          patch.lastRefreshedAt = new Date().toISOString()
          const stable = this.tryReadStableFromTempHome(home)
          if (stable) patch.stableFingerprint = stable
          return this.saveRefreshedAccount(accountId, patch, dedupeEmail)
        }

        snap = mapRateLimitsToSnapshot(
          rateRaw as Parameters<typeof mapRateLimitsToSnapshot>[0],
          effectivePlanType,
          creditsFromAccount
        )
      }

      if (!snap) {
        patch.status = 'no_quota'
      } else {
        patch.lastQuotaSnapshot = snap
        if (snap.planType) patch.planType = snap.planType
        patch.status = 'ok'
      }
      patch.lastRefreshedAt = new Date().toISOString()
      const stable = this.tryReadStableFromTempHome(home)
      if (stable) patch.stableFingerprint = stable
      return this.saveRefreshedAccount(accountId, patch, dedupeEmail)
    } catch {
      const patch: RefreshAccountPatch = {
        status: 'app_server_failed',
        lastRefreshedAt: new Date().toISOString()
      }
      const stable = this.tryReadStableFromTempHome(home)
      if (stable) patch.stableFingerprint = stable
      return this.saveRefreshedAccount(accountId, patch, dedupeEmail)
    } finally {
      client?.dispose()
      try {
        fs.rmSync(home, { recursive: true, force: true })
      } catch {
        /* */
      }
    }
  }

  async refreshAll(): Promise<SavedAccount[]> {
    const { accounts } = this.listAccounts()
    return this.refreshMany(accounts.map((a) => a.id))
  }

  async refreshMany(accountIds: string[]): Promise<SavedAccount[]> {
    const ids = uniqueAccountIds(accountIds)
    const results = await mapWithConcurrency(ids, REFRESH_CONCURRENCY, async (accountId) => {
      try {
        return await this.refreshOne(accountId)
      } catch {
        return null
      }
    })
    return results.filter((account): account is SavedAccount => account !== null)
  }

  async warmupOne(accountId: string): Promise<WarmupOneResult> {
    const store = loadStore()
    const acc = store.accounts.find((a) => a.id === accountId)
    if (!acc) throw new Error('未找到账号')

    const codex = resolveCodexExecutable()
    if (!codex) {
      const refreshed = await this.refreshOne(accountId)
      return {
        account: refreshed,
        mode: refreshed.status === 'ok' ? 'refreshed' : 'failed',
        message: refreshed.status === 'ok' ? '未找到 app-server，已执行普通刷新' : '预热失败，且普通刷新也未成功'
      }
    }

    let plain: string
    try {
      plain = readEncryptedBlob(blobPathForRef(acc.encryptedAuthBlobRef))
    } catch {
      const refreshed = await this.refreshOne(accountId)
      return {
        account: refreshed,
        mode: refreshed.status === 'ok' ? 'refreshed' : 'failed',
        message: refreshed.status === 'ok' ? '账号快照无法发起预热，已执行普通刷新' : '账号快照损坏，预热和刷新都失败'
      }
    }

    let capturedSnapshot: QuotaSnapshot | null = null
    let authoritativeSnapshot: QuotaSnapshot | null = null
    let warmupEmail: string | null = null
    let warmupPlanType: string | null = acc.planType
    let lastSendError: string | null = null
    const baselineSig = quotaMutationSignature(acc.lastQuotaSnapshot)
    try {
      let capture = await this.captureWarmupSnapshotUsingTempHome(codex, plain, acc.planType)
      warmupEmail = capture.email
      warmupPlanType = capture.planType ?? acc.planType
      capturedSnapshot = capture.sessionSnapshot
      authoritativeSnapshot = capture.authoritativeSnapshot
      lastSendError = capture.sendError

      if (!capturedSnapshot && /token data is not available/i.test(capture.sendError ?? '')) {
        capture = await this.captureWarmupSnapshotUsingLiveHome(codex, plain, warmupPlanType)
        warmupEmail = capture.email ?? warmupEmail
        warmupPlanType = capture.planType ?? warmupPlanType
        capturedSnapshot = capture.sessionSnapshot ?? capturedSnapshot
        authoritativeSnapshot = capture.authoritativeSnapshot ?? authoritativeSnapshot
        lastSendError = capture.sendError ?? lastSendError
      }
    } catch {
      /* 预热失败时仍继续刷新额度 */
    }

    if (authoritativeSnapshot) {
      if (warmupEmail) acc.email = warmupEmail
      if (authoritativeSnapshot.planType) acc.planType = authoritativeSnapshot.planType
      else if (warmupPlanType) acc.planType = warmupPlanType
      acc.lastQuotaSnapshot = authoritativeSnapshot
      acc.status = 'ok'
      acc.lastRefreshedAt = new Date().toISOString()
      saveStore(store)
      return {
        account: acc,
        mode: 'warmed',
        message: '已发送 hi，并同步到最新额度'
      }
    }

    if (capturedSnapshot) {
      const targetSig = quotaMutationSignature(capturedSnapshot)
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await sleep(1500)
        const refreshed = await this.refreshOne(accountId)
        if (refreshed.status === 'ok' && refreshed.lastQuotaSnapshot) {
          const refreshedSig = quotaMutationSignature(refreshed.lastQuotaSnapshot)
          if (refreshedSig === targetSig || refreshedSig !== baselineSig) {
            return {
              account: refreshed,
              mode: 'warmed',
              message: '已发送 hi，并刷新最新额度'
            }
          }
        }
      }

      if (warmupEmail) acc.email = warmupEmail
      if (capturedSnapshot.planType) acc.planType = capturedSnapshot.planType
      else if (warmupPlanType) acc.planType = warmupPlanType
      acc.lastQuotaSnapshot = capturedSnapshot
      acc.status = 'ok'
      acc.lastRefreshedAt = new Date().toISOString()
      saveStore(store)
      return {
        account: acc,
        mode: 'warmed',
        message: '已发送 hi，但实时刷新失败，已回退到即时快照'
      }
    }

    const refreshed = await this.refreshOne(accountId)
    if (refreshed.status === 'ok') {
      return {
        account: refreshed,
        mode: 'refreshed',
        message: /token data is not available/i.test(lastSendError ?? '')
          ? '该账号缺少可发送消息的 token data，未能发送 hi，已执行普通刷新'
          : '未抓到即时预热快照，已执行普通刷新'
      }
    }
    return {
      account: refreshed,
      mode: 'failed',
      message: lastSendError ? `预热失败：${lastSendError}` : '预热和普通刷新都失败'
    }
  }

  async warmupNeverRefreshed(): Promise<number> {
    const { accounts } = this.listAccounts()
    const targets = accounts.filter((a) => shouldWarmupInBatch(a.lastQuotaSnapshot))

    const codex = resolveCodexExecutable()
    if (!codex) {
      // 没有 codex CLI，只做刷新
      await this.refreshMany(targets.map((a) => a.id))
      return targets.length
    }

    for (const a of targets) {
      await this.warmupOne(a.id)
    }
    return targets.length
  }

  async debugWarmup(accountId: string): Promise<Record<string, unknown>> {
    const store = loadStore()
    const acc = store.accounts.find((a) => a.id === accountId)
    if (!acc) throw new Error('未找到账号')

    const codex = resolveCodexExecutable()
    if (!codex) throw new Error('未找到 codex CLI')

    let plain: string
    try {
      plain = readEncryptedBlob(blobPathForRef(acc.encryptedAuthBlobRef))
    } catch {
      throw new Error('本地快照损坏，无法解密')
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-debug-warmup-'))
    let client: CodexRpcClient | null = null
    try {
      writeAuthToHome(home, plain)
      client = new CodexRpcClient(codex, home)
      await client.start()

      const readRes = await client.readAccount(true)
      const { email, planType } = parseChatgptAccount(readRes)
      const effectivePlanType = planType ?? acc.planType
      const creditsFromAccount = extractCreditsFromAccountRead(readRes)
      const authSummaryAfterRead = summarizeAuthContent(readAuthJsonFromHome(home))

      const beforeRateRaw = await client.readRateLimits().catch(() => null)
      const beforeRate = beforeRateRaw
        ? mapRateLimitsToSnapshot(
            beforeRateRaw as Parameters<typeof mapRateLimitsToSnapshot>[0],
            effectivePlanType,
            creditsFromAccount
          )
        : null

      const beforeUsageRaw = await this.readUsageSnapshotFromHome(home).catch(() => null)
      const beforeUsage = beforeUsageRaw
        ? mapUsagePayloadToSnapshot(beforeUsageRaw, effectivePlanType, creditsFromAccount)
        : null

      let sendError: string | null = null
      let sendServerRequest: ReturnType<CodexRpcClient['getLastServerRequest']> = null
      let sessionRaw: unknown = null
      let sessionSnapshot: QuotaSnapshot | null = null
      let liveHomeFallback: Record<string, unknown> | null = null
      try {
        const sendRes = await client.sendChatMessage('hi')
        sessionRaw = sendRes.sessionRateLimits
        sessionSnapshot = mapTokenCountRateLimitsToSnapshot(
          sendRes.sessionRateLimits,
          effectivePlanType,
          creditsFromAccount
        )
      } catch (e) {
        sendError = e instanceof Error ? e.message : String(e)
        sendServerRequest = client.getLastServerRequest()
        if (/token data is not available/i.test(sendError)) {
          const liveCapture = await this.captureWarmupSnapshotUsingLiveHome(codex, plain, effectivePlanType)
          liveHomeFallback = {
            email: liveCapture.email,
            planType: liveCapture.planType,
            sendError: liveCapture.sendError,
            sessionRaw: liveCapture.sessionRaw,
            session: summarizeSnapshot(liveCapture.sessionSnapshot)
          }
        }
      }

      await sleep(1500)

      const afterRateRaw = await client.readRateLimits().catch(() => null)
      const afterRate = afterRateRaw
        ? mapRateLimitsToSnapshot(
            afterRateRaw as Parameters<typeof mapRateLimitsToSnapshot>[0],
            effectivePlanType,
            creditsFromAccount
          )
        : null

      const afterUsageRaw = await this.readUsageSnapshotFromHome(home).catch(() => null)
      const afterUsage = afterUsageRaw
        ? mapUsagePayloadToSnapshot(afterUsageRaw, effectivePlanType, creditsFromAccount)
        : null

      return {
        accountId: acc.id,
        email: email ?? acc.email,
        planType: effectivePlanType,
        authSummaryAfterRead,
        saved: summarizeSnapshot(acc.lastQuotaSnapshot),
        beforeRate: summarizeSnapshot(beforeRate),
        beforeUsage: summarizeSnapshot(beforeUsage),
        sendError,
        sendServerRequest,
        liveHomeFallback,
        sessionRaw,
        session: summarizeSnapshot(sessionSnapshot),
        afterRate: summarizeSnapshot(afterRate),
        afterUsage: summarizeSnapshot(afterUsage)
      }
    } finally {
      client?.dispose()
      try {
        fs.rmSync(home, { recursive: true, force: true })
      } catch {
        /* */
      }
    }
  }

  async refreshLive(): Promise<LiveSessionInfo> {
    const base = (status: LiveSessionStatus, extra?: Partial<LiveSessionInfo>): LiveSessionInfo => ({
      email: null,
      planType: null,
      lastQuotaSnapshot: null,
      lastRefreshedAt: new Date().toISOString(),
      status,
      ...extra
    })

    if (!fs.existsSync(getLiveAuthPath())) {
      return base('no_live_file')
    }

    const codex = resolveCodexExecutable()
    if (!codex) {
      return base('app_server_failed', { stderrHint: '未找到 codex CLI' })
    }

    const home = getCodexDir()
    let client: CodexRpcClient | null = null
    try {
      fs.mkdirSync(home, { recursive: true })
      client = new CodexRpcClient(codex, home)
      await client.start()
      let readRes: unknown
      try {
        readRes = await client.readAccount(true)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const st: LiveSessionStatus = /401|unauthor|expired|token/i.test(msg) ? 'unauthorized' : 'app_server_failed'
        return base(st, { stderrHint: client.getLastStderrHint() || msg })
      }
      const { email, planType } = parseChatgptAccount(readRes)
      const creditsFromAccount = extractCreditsFromAccountRead(readRes)
      let snap: QuotaSnapshot | null = null
      try {
        const usageRaw = await this.readUsageSnapshotFromHome(home)
        snap = mapUsagePayloadToSnapshot(usageRaw, planType, creditsFromAccount)
      } catch {
        // usage 接口失败时回退
      }

      if (!snap) {
        let rateRaw: unknown
        try {
          rateRaw = await this.readRateLimitsWithRepair(client)
        } catch {
          return {
            email: email ?? null,
            planType,
            lastQuotaSnapshot: null,
            lastRefreshedAt: new Date().toISOString(),
            status: 'no_quota',
            stderrHint: client.getLastStderrHint() || undefined
          }
        }
        snap = mapRateLimitsToSnapshot(
          rateRaw as Parameters<typeof mapRateLimitsToSnapshot>[0],
          planType,
          creditsFromAccount
        )
      }

      return {
        email: email ?? null,
        planType,
        lastQuotaSnapshot: snap,
        lastRefreshedAt: new Date().toISOString(),
        status: snap ? 'ok' : 'no_quota',
        stderrHint: client.getLastStderrHint() || undefined
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const tail = [client?.getLastStderrHint(), msg].filter(Boolean).join('\n')
      return base('app_server_failed', { stderrHint: tail || undefined })
    } finally {
      client?.dispose()
    }
  }

  async importLive(): Promise<string> {
    const live = getLiveAuthPath()
    if (!fs.existsSync(live)) {
      throw new Error('未发现 Live auth.json，请先在 Codex / 扩展中完成登录')
    }
    const content = fs.readFileSync(live, 'utf8')
    const result = await this.importAuthPlainContent(content, '（已导入 Live，刷新后显示邮箱）')
    return result.accountId
  }

  async importAuthJsonFromPath(filePath: string): Promise<ImportAuthJsonSummary> {
    const content = fs.readFileSync(filePath, 'utf8')
    const entries = parseAuthJsonImportEntries(filePath, content)
    const summary = emptyImportAuthJsonSummary(1)
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]
      try {
        const result = await this.importAuthPlainContent(entry.content, entry.placeholderEmail, entry.metadata)
        countImportPlainOutcome(summary, result.outcome)
        addImportedAccountId(summary, result.accountId)
      } catch (e) {
        summary.accounts += 1
        summary.failed += 1
        summary.errors.push({
          filePath: entries.length > 1 ? `${filePath}#${index + 1}` : filePath,
          message: messageFromUnknown(e)
        })
      }
    }
    return summary
  }

  async importAuthJsonFromPaths(filePaths: string[]): Promise<ImportAuthJsonSummary> {
    const summary = emptyImportAuthJsonSummary()
    for (const filePath of filePaths) {
      try {
        mergeImportAuthJsonSummary(summary, await this.importAuthJsonFromPath(filePath))
      } catch (e) {
        summary.files += 1
        summary.failed += 1
        summary.errors.push({ filePath, message: messageFromUnknown(e) })
      }
    }
    if (summary.accounts === 0 && summary.failed > 0) {
      throw new Error(summary.errors[0]?.message ?? 'JSON 导入失败')
    }
    return summary
  }

  exportAuthJsonToDirectory(directoryPath: string): ExportAuthJsonSummary {
    const store = loadStore()
    if (store.accounts.length === 0) throw new Error('没有可导出的账号')

    const exports = store.accounts.map((account, index) => {
      let plain: string
      try {
        plain = readEncryptedBlob(blobPathForRef(account.encryptedAuthBlobRef))
      } catch {
        throw new Error(`账号 ${exportAccountLabel(account)} 的本地快照损坏，无法导出`)
      }
      const authJson = parseJsonObjectOrThrow(plain, `账号 ${exportAccountLabel(account)} 的 auth.json`)
      return {
        baseName: exportFileBaseName(account, index),
        authJson
      }
    })

    fs.mkdirSync(directoryPath, { recursive: true })
    const usedPaths = new Set<string>()
    const filePaths = exports.map((item) => {
      const target = uniqueExportFilePath(directoryPath, item.baseName, usedPaths)
      fs.writeFileSync(target, JSON.stringify(item.authJson, null, 2), 'utf8')
      return target
    })
    return { directoryPath, accountCount: filePaths.length, filePaths }
  }

  private async importAuthPlainContent(
    content: string,
    placeholderEmail: string,
    metadata?: ImportAuthMetadata
  ): Promise<{ accountId: string; outcome: ImportPlainOutcome }> {
    const fingerprint = fingerprintFromAuthContent(content)
    const stable = stableFingerprintFromAuthContent(content)
    const store = loadStore()
    const existing = store.accounts.find(
      (a) => a.fingerprint === fingerprint || (!!stable && a.stableFingerprint === stable)
    )
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        existing.fingerprint = fingerprint
        if (stable) existing.stableFingerprint = stable
        writeEncryptedBlob(blobPathForRef(existing.encryptedAuthBlobRef), content)
        saveStore(store)
        return { accountId: existing.id, outcome: 'updated' }
      }
      return { accountId: existing.id, outcome: 'skipped' }
    }
    const id = randomUUID()
    const ref = `blob.${id}.enc`
    writeEncryptedBlob(blobPathForRef(ref), content)
    const acc: SavedAccount = {
      id,
      email: metadata?.email ?? placeholderEmail,
      planType: metadata?.planType ?? null,
      nickname: metadata?.nickname ?? '',
      fingerprint,
      stableFingerprint: stable ?? undefined,
      encryptedAuthBlobRef: ref,
      lastQuotaSnapshot: metadata?.lastQuotaSnapshot ?? null,
      status: metadata?.status ?? 'idle',
      addedAt: metadata?.addedAt ?? new Date().toISOString(),
      lastRefreshedAt: metadata?.lastRefreshedAt ?? null
    }
    store.accounts.push(acc)
    saveStore(store)
    return { accountId: id, outcome: 'imported' }
  }

  updateNickname(accountId: string, nickname: string): SavedAccount | null {
    const store = loadStore()
    const acc = store.accounts.find((a) => a.id === accountId)
    if (!acc) return null
    acc.nickname = nickname
    saveStore(store)
    return acc
  }

  searchFilter(accounts: SavedAccount[], q: string): SavedAccount[] {
    const t = q.trim().toLowerCase()
    if (!t) return accounts
    return accounts.filter(
      (a) =>
        a.email.toLowerCase().includes(t) ||
        (a.nickname && a.nickname.toLowerCase().includes(t)) ||
        (a.planType && a.planType.toLowerCase().includes(t))
    )
  }

  reorderAccounts(accountIds: string[]): void {
    const store = loadStore()
    const byId = new Map(store.accounts.map((a) => [a.id, a]))
    const newAccounts: SavedAccount[] = []
    for (const id of accountIds) {
      const a = byId.get(id)
      if (a) newAccounts.push(a)
    }
    for (const a of store.accounts) {
      if (!byId.has(a.id) || !accountIds.includes(a.id)) newAccounts.push(a)
    }
    store.accounts = newAccounts
    saveStore(store)
  }

  deleteAccount(accountId: string): boolean {
    const store = loadStore()
    const idx = store.accounts.findIndex((a) => a.id === accountId)
    if (idx < 0) return false

    const acc = store.accounts[idx]
    // 删除加密 blob 文件
    try {
      const blobPath = blobPathForRef(acc.encryptedAuthBlobRef)
      if (fs.existsSync(blobPath)) {
        fs.unlinkSync(blobPath)
      }
    } catch {
      // blob 文件不存在也继续删除账号
    }

    store.accounts.splice(idx, 1)
    saveStore(store)
    return true
  }
}

function extractCreditsFromAccountRead(readRes: unknown): QuotaCredits | null {
  const r = readRes as { account?: { credits?: QuotaCredits } | null }
  const c = r.account?.credits
  return c ?? null
}
