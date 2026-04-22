import type { QuotaBucketRow, QuotaCredits, QuotaSnapshot, QuotaWindow } from '@shared/types'

interface RpcRateLimitWindow {
  usedPercent?: number | null
  windowDurationMins?: number | null
  resetsAt?: number | null
}

interface SessionRateLimitWindow {
  used_percent?: number | null
  usedPercent?: number | null
  window_minutes?: number | null
  windowDurationMins?: number | null
  resets_at?: number | null
  resetsAt?: number | null
}

interface RpcRateLimitBucket {
  limitId?: string
  limitName?: string | null
  primary?: RpcRateLimitWindow | null
  secondary?: RpcRateLimitWindow | null
  credits?: QuotaCredits | null
}

export interface RateLimitsReadResult {
  rateLimits?: RpcRateLimitBucket | null
  rateLimitsByLimitId?: Record<string, RpcRateLimitBucket> | null
}

type RawCollectItem = { mapKey: string; b: RpcRateLimitBucket }

function toNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function normalizeUsedPercent(value: unknown): number | null {
  const n = toNullableNumber(value)
  if (n == null) return null
  // 兼容 0~1 小数占比（例如 0.73 表示 73%）
  // 注意边界值 1 可能代表 1%，不能误判成 100%。
  if (n > 0 && n < 1) return Math.round(n * 10000) / 100
  return n
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  return s.length ? s : null
}

function mapWindow(w: RpcRateLimitWindow | null | undefined): QuotaWindow | null {
  if (w == null) return null
  return {
    usedPercent: normalizeUsedPercent(w.usedPercent),
    resetsAt: toNullableNumber(w.resetsAt),
    windowDurationMins: toNullableNumber(w.windowDurationMins)
  }
}

function mapSessionWindow(w: unknown): RpcRateLimitWindow | null {
  const obj = asObject(w)
  if (!obj) return null
  const usedPercent = normalizeUsedPercent(obj.used_percent ?? obj.usedPercent)
  const windowDurationMins = toNullableNumber(obj.window_minutes ?? obj.windowDurationMins)
  const resetsAt = toNullableNumber(obj.resets_at ?? obj.resetsAt)
  if (usedPercent == null && windowDurationMins == null && resetsAt == null) return null
  return {
    usedPercent,
    windowDurationMins,
    resetsAt
  }
}

function mapUsageWindow(w: unknown): RpcRateLimitWindow | null {
  const obj = asObject(w)
  if (!obj) return null
  const usedPercent = normalizeUsedPercent(obj.used_percent ?? obj.usedPercent)
  const limitWindowSeconds = toNullableNumber(obj.limit_window_seconds ?? obj.limitWindowSeconds)
  const resetsAt = toNullableNumber(obj.reset_at ?? obj.resetsAt)
  if (usedPercent == null && limitWindowSeconds == null && resetsAt == null) return null
  return {
    usedPercent,
    windowDurationMins:
      limitWindowSeconds == null ? null : Math.max(1, Math.floor((limitWindowSeconds + 59) / 60)),
    resetsAt
  }
}

function hasWindowSignal(w: QuotaWindow | null): boolean {
  return !!w && (w.usedPercent != null || w.resetsAt != null || w.windowDurationMins != null)
}

function hasBucketSignal(b: QuotaBucketRow): boolean {
  return hasWindowSignal(b.primary) || hasWindowSignal(b.secondary)
}

function windowDurationKey(w: QuotaWindow | null): number {
  const m = w?.windowDurationMins
  return m == null ? 1_000_000 : m
}

function inferDisplayLabel(limitId: string, limitName: string | null, w: QuotaWindow | null): string {
  const mins = w?.windowDurationMins
  if (mins != null) {
    if (mins >= 250 && mins <= 350) return '5 小时'
    if (mins >= 1380 && mins <= 1500) return '24 小时'
    if (mins >= 9000 && mins <= 11000) return '1 周'
    return `${limitId}（${mins} 分钟窗）`
  }
  const n = limitName?.trim()
  if (n) return n
  return limitId
}

function parseUsageCredits(creditsRaw: unknown): QuotaCredits | null {
  const c = asObject(creditsRaw)
  if (!c) return null
  const hasCreditsValue = c.hasCredits ?? c.has_credits
  const unlimitedValue = c.unlimited
  const balanceValue = c.balance
  return {
    hasCredits:
      typeof hasCreditsValue === 'boolean'
        ? hasCreditsValue
        : hasCreditsValue == null
          ? undefined
          : Boolean(hasCreditsValue),
    unlimited:
      typeof unlimitedValue === 'boolean'
        ? unlimitedValue
        : unlimitedValue == null
          ? undefined
          : Boolean(unlimitedValue),
    balance: toNullableNumber(balanceValue)
  }
}

function mapExtraWindow(
  value: unknown
): { usedPercent?: number | null; windowDurationMins?: number | null; resetsAt?: number | null } | null {
  return mapUsageWindow(value)
}

function collectExtraRateLimitBucketsFromCredits(credits: unknown): RawCollectItem[] {
  const obj = asObject(credits)
  if (!obj) return []
  const rawList = obj._codexmanager_extra_rate_limits
  if (!Array.isArray(rawList)) return []
  const out: RawCollectItem[] = []
  for (let i = 0; i < rawList.length; i++) {
    const item = asObject(rawList[i])
    if (!item) continue
    const limitId = String(item.limit_id ?? item.limitId ?? item.source_key ?? `extra_${i}`).trim()
    if (!limitId) continue
    const limitNameRaw = item.limit_name ?? item.limitName
    const limitName = limitNameRaw == null ? null : String(limitNameRaw)
    out.push({
      mapKey: limitId,
      b: {
        limitId,
        limitName,
        primary: mapExtraWindow(item.primary_window ?? item.primary),
        secondary: mapExtraWindow(item.secondary_window ?? item.secondary),
        credits: null
      }
    })
  }
  return out
}

function collectRawBuckets(raw: RateLimitsReadResult): RawCollectItem[] {
  const map = new Map<string, RpcRateLimitBucket>()
  const byId = raw.rateLimitsByLimitId
  if (byId && typeof byId === 'object') {
    for (const mapKey of Object.keys(byId)) {
      const b = byId[mapKey]
      if (b && typeof b === 'object') map.set(mapKey, b)
    }
  }
  if (map.size === 0 && raw.rateLimits && typeof raw.rateLimits === 'object') {
    map.set(raw.rateLimits.limitId ?? 'legacy', raw.rateLimits)
  }
  const creditsCandidates: unknown[] = []
  if (raw.rateLimits && typeof raw.rateLimits === 'object') creditsCandidates.push(raw.rateLimits.credits)
  if (byId && typeof byId === 'object') {
    for (const key of Object.keys(byId)) {
      creditsCandidates.push(byId[key]?.credits)
    }
  }
  for (const credits of creditsCandidates) {
    for (const item of collectExtraRateLimitBucketsFromCredits(credits)) {
      if (!map.has(item.mapKey)) map.set(item.mapKey, item.b)
    }
  }
  return Array.from(map.entries()).map(([mapKey, b]) => ({ mapKey, b }))
}

function toBucketRow(mapKey: string, b: RpcRateLimitBucket): QuotaBucketRow {
  const limitId = b.limitId ?? mapKey
  const primary = mapWindow(b.primary ?? null)
  const secondary = mapWindow(b.secondary ?? null)
  const labelWin = primary ?? secondary
  return {
    limitId,
    limitName: b.limitName ?? null,
    displayLabel: inferDisplayLabel(limitId, b.limitName ?? null, labelWin),
    primary,
    secondary
  }
}

function pickCreditsFromBuckets(items: RawCollectItem[], creditsFallback: QuotaCredits | null): QuotaCredits | null {
  for (const { b } of items) {
    if (b.credits != null) return b.credits
  }
  return creditsFallback
}

function collectUsageRateLimitEntries(raw: unknown): RawCollectItem[] {
  const root = asObject(raw)
  if (!root) return []
  const out: RawCollectItem[] = []
  const pushEntry = (value: unknown, fallbackKey: string): void => {
    const item = asObject(value)
    if (!item) return
    const limitId = asString(item.limit_id ?? item.limitId) ?? fallbackKey
    const limitName = asString(item.limit_name ?? item.limitName)
    out.push({
      mapKey: limitId,
      b: {
        limitId,
        limitName,
        primary: mapUsageWindow(item.primary_window ?? item.primaryWindow),
        secondary: mapUsageWindow(item.secondary_window ?? item.secondaryWindow),
        credits: null
      }
    })
  }

  pushEntry(root.rate_limit, 'codex')
  for (const key of Object.keys(root)) {
    if (key === 'rate_limit' || !key.endsWith('_rate_limit')) continue
    pushEntry(root[key], key)
  }

  const additional = root.additional_rate_limits
  if (Array.isArray(additional)) {
    for (let i = 0; i < additional.length; i++) {
      pushEntry(additional[i], `additional_rate_limits_${i}`)
    }
  } else {
    const additionalObj = asObject(additional)
    if (additionalObj) {
      for (const key of Object.keys(additionalObj)) {
        pushEntry(additionalObj[key], key)
      }
    }
  }
  return out
}

export function mapUsagePayloadToSnapshot(
  raw: unknown,
  planTypeFallback: string | null,
  creditsFallback: QuotaCredits | null
): QuotaSnapshot | null {
  const root = asObject(raw)
  if (!root) return null
  const items = collectUsageRateLimitEntries(root)
  if (items.length === 0) return null

  const usageCredits = parseUsageCredits(root.credits) ?? creditsFallback
  if (usageCredits) {
    const codex = items.find((i) => i.mapKey === 'codex') ?? items[0]
    codex.b.credits = usageCredits
  }

  const byId: Record<string, RpcRateLimitBucket> = {}
  for (const it of items) byId[it.mapKey] = it.b
  const head = byId.codex ?? items[0].b
  const planType = asString(root.plan_type ?? root.planType) ?? planTypeFallback

  return mapRateLimitsToSnapshot(
    {
      rateLimits: head,
      rateLimitsByLimitId: byId
    },
    planType,
    usageCredits
  )
}

export function mapTokenCountRateLimitsToSnapshot(
  raw: unknown,
  planTypeFallback: string | null,
  creditsFallback: QuotaCredits | null
): QuotaSnapshot | null {
  const root = asObject(raw)
  if (!root) return null

  const limitId = asString(root.limit_id ?? root.limitId) ?? 'codex'
  const limitName = asString(root.limit_name ?? root.limitName)
  const planType = asString(root.plan_type ?? root.planType) ?? planTypeFallback
  const credits = parseUsageCredits(root.credits) ?? creditsFallback

  return mapRateLimitsToSnapshot(
    {
      rateLimits: {
        limitId,
        limitName,
        primary: mapSessionWindow(root.primary),
        secondary: mapSessionWindow(root.secondary),
        credits
      },
      rateLimitsByLimitId: {
        [limitId]: {
          limitId,
          limitName,
          primary: mapSessionWindow(root.primary),
          secondary: mapSessionWindow(root.secondary),
          credits
        }
      }
    },
    planType,
    credits
  )
}

export function mapRateLimitsToSnapshot(
  raw: RateLimitsReadResult,
  planType: string | null,
  creditsFallback: QuotaCredits | null
): QuotaSnapshot | null {
  const items = collectRawBuckets(raw)
  if (items.length === 0) return null
  const pairs = items.map(({ mapKey, b }) => ({ mapKey, row: toBucketRow(mapKey, b) }))
  const codexPair = pairs.find((p) => p.mapKey === 'codex' && hasBucketSignal(p.row))
  const sortedByQuality = [...pairs].sort((a, b) => {
    const sa = (hasWindowSignal(a.row.primary) ? 1 : 0) + (hasWindowSignal(a.row.secondary) ? 1 : 0)
    const sb = (hasWindowSignal(b.row.primary) ? 1 : 0) + (hasWindowSignal(b.row.secondary) ? 1 : 0)
    if (sb !== sa) return sb - sa
    const da = Math.min(windowDurationKey(a.row.primary), windowDurationKey(a.row.secondary))
    const db = Math.min(windowDurationKey(b.row.primary), windowDurationKey(b.row.secondary))
    return da - db
  })
  const headPair = codexPair ?? sortedByQuality[0]
  const head = headPair.row
  const rows = sortedByQuality
    .map((p) => p.row)
    .sort((a, b) => {
      const da = Math.min(windowDurationKey(a.primary), windowDurationKey(a.secondary))
      const db = Math.min(windowDurationKey(b.primary), windowDurationKey(b.secondary))
      return da - db
    })
  const refreshedAt = new Date().toISOString()
  const credits = pickCreditsFromBuckets(items, creditsFallback)
  return {
    limitId: head.limitId,
    limitName: head.limitName,
    primary: head.primary,
    secondary: head.secondary,
    credits,
    planType,
    refreshedAt,
    buckets: rows
  }
}
