import type { QuotaBucketRow, QuotaSnapshot, QuotaWindow } from './types'

/** API 返回的 usedPercent 按「已使用占比」理解，转为剩余百分比 */
export function remainingPercentFromUsed(usedPercent: number | null | undefined): number | null {
  if (usedPercent == null || Number.isNaN(usedPercent)) return null
  const normalizedUsed =
    usedPercent > 0 && usedPercent < 1 ? Math.round(usedPercent * 10000) / 100 : usedPercent
  const r = Math.round(100 - normalizedUsed)
  return Math.max(0, Math.min(100, r))
}

export function formatReset(ts: number | null | undefined): string {
  if (ts == null) return '—'
  const d = new Date(ts * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 短日期，与参考 UI 一致：英文月缩写 + 日 */
export function formatResetShort(ts: number | null | undefined): string {
  if (ts == null) return '—'
  const d = new Date(ts * 1000)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export type QuotaWindowDisplayMode = 'unknown' | 'primary-only' | 'secondary-only' | 'dual'

export interface QuotaDisplayWindow {
  provided: boolean
  remaining: number | null
  resetsAt: number | null
}

export interface QuotaDisplayWindows {
  mode: QuotaWindowDisplayMode
  fiveHour: QuotaDisplayWindow
  sevenDay: QuotaDisplayWindow
  extras: Array<{ key: string; label: string; remaining: number | null; resetsAt: number | null }>
}

function hasWindowSignal(w: QuotaWindow | null | undefined): boolean {
  return !!w && (w.usedPercent != null || w.resetsAt != null || w.windowDurationMins != null)
}

function isLongWindow(w: QuotaWindow | null | undefined): boolean {
  const mins = w?.windowDurationMins
  if (mins == null) return false
  return mins >= 24 * 60
}

function isFreePlanType(planType: string | null | undefined): boolean {
  const t = String(planType ?? '')
    .trim()
    .toLowerCase()
  return t.includes('free')
}

export function getQuotaWindowDisplayMode(q: QuotaSnapshot | null): QuotaWindowDisplayMode {
  if (!q) return 'unknown'
  const hasPrimary = hasWindowSignal(q.primary)
  const hasSecondary = hasWindowSignal(q.secondary)
  if (!hasPrimary && !hasSecondary) return 'unknown'
  if (!hasPrimary && hasSecondary) return 'secondary-only'
  if (hasPrimary && !hasSecondary && (isLongWindow(q.primary) || isFreePlanType(q.planType))) {
    return 'secondary-only'
  }
  if (hasPrimary && !hasSecondary) return 'primary-only'
  return 'dual'
}

function displayWindowFrom(w: QuotaWindow | null): QuotaDisplayWindow {
  if (!hasWindowSignal(w)) {
    return { provided: false, remaining: null, resetsAt: null }
  }
  return {
    provided: true,
    remaining: remainingPercentFromUsed(w?.usedPercent ?? null),
    resetsAt: w?.resetsAt ?? null
  }
}

function collectExtraRows(q: QuotaSnapshot | null): QuotaDisplayWindows['extras'] {
  if (!q?.buckets?.length) return []
  const extras: QuotaDisplayWindows['extras'] = []
  for (const b of q.buckets) {
    if (b.limitId === q.limitId) continue
    const hasP = hasWindowSignal(b.primary)
    const hasS = hasWindowSignal(b.secondary)
    if (hasP) {
      extras.push({
        key: `${b.limitId}:p`,
        label: hasS ? `${b.displayLabel} · 主` : b.displayLabel,
        remaining: remainingPercentFromUsed(b.primary?.usedPercent),
        resetsAt: b.primary?.resetsAt ?? null
      })
    }
    if (hasS) {
      extras.push({
        key: `${b.limitId}:s`,
        label: hasP ? `${b.displayLabel} · 次` : b.displayLabel,
        remaining: remainingPercentFromUsed(b.secondary?.usedPercent),
        resetsAt: b.secondary?.resetsAt ?? null
      })
    }
  }
  return extras
}

export function getQuotaDisplayWindows(q: QuotaSnapshot | null): QuotaDisplayWindows {
  const mode = getQuotaWindowDisplayMode(q)
  const unknown = {
    mode,
    fiveHour: { provided: false, remaining: null, resetsAt: null },
    sevenDay: { provided: false, remaining: null, resetsAt: null },
    extras: collectExtraRows(q)
  }
  if (!q) return unknown

  if (mode === 'secondary-only') {
    const source = hasWindowSignal(q.primary) ? q.primary : q.secondary
    return {
      mode,
      fiveHour: { provided: false, remaining: null, resetsAt: null },
      sevenDay: displayWindowFrom(source),
      extras: collectExtraRows(q)
    }
  }

  if (mode === 'primary-only') {
    return {
      mode,
      fiveHour: displayWindowFrom(q.primary),
      sevenDay: { provided: false, remaining: null, resetsAt: null },
      extras: collectExtraRows(q)
    }
  }

  if (mode === 'dual') {
    return {
      mode,
      fiveHour: displayWindowFrom(q.primary),
      sevenDay: displayWindowFrom(q.secondary),
      extras: collectExtraRows(q)
    }
  }

  return unknown
}

function pushWindowParts(parts: string[], label: string, w: QuotaWindow | null): void {
  const r = remainingPercentFromUsed(w?.usedPercent ?? null)
  if (r != null) parts.push(`${label} 剩${r}%`)
}

export function quotaSummaryText(q: QuotaSnapshot | null): string {
  if (!q) return '—'
  const main = getQuotaDisplayWindows(q)
  const mainParts: string[] = []
  if (main.fiveHour.provided && main.fiveHour.remaining != null) mainParts.push(`5h 剩${main.fiveHour.remaining}%`)
  if (main.sevenDay.provided && main.sevenDay.remaining != null) mainParts.push(`7d 剩${main.sevenDay.remaining}%`)
  if (mainParts.length) {
    const extraParts = main.extras.map((e) => `${e.label} 剩${e.remaining ?? '—'}%`)
    return [...mainParts, ...extraParts].join(' · ')
  }
  if (q.buckets?.length) {
    const parts: string[] = []
    for (const b of q.buckets) {
      const hasBoth =
        (b.primary?.usedPercent != null || b.primary?.resetsAt != null) &&
        (b.secondary?.usedPercent != null || b.secondary?.resetsAt != null)
      if (hasBoth) {
        pushWindowParts(parts, `${b.displayLabel}·主`, b.primary)
        pushWindowParts(parts, `${b.displayLabel}·次`, b.secondary)
      } else {
        pushWindowParts(parts, b.displayLabel, b.primary ?? b.secondary)
      }
    }
    return parts.length ? parts.join(' · ') : '已刷新'
  }
  const parts: string[] = []
  pushWindowParts(parts, '主', q.primary)
  pushWindowParts(parts, '次', q.secondary)
  return parts.length ? parts.join(' · ') : '已刷新'
}

export type QuotaRemainRow = { key: string; label: string; remaining: number | null; resetsAt: number | null }

function pushRow(
  rows: QuotaRemainRow[],
  key: string,
  label: string,
  w: QuotaWindow | null
): void {
  if (!w || (w.usedPercent == null && w.resetsAt == null)) return
  rows.push({
    key,
    label,
    remaining: remainingPercentFromUsed(w.usedPercent),
    resetsAt: w.resetsAt ?? null
  })
}

export function quotaRemainRows(q: QuotaSnapshot | null): QuotaRemainRow[] {
  if (!q) return []
  const main = getQuotaDisplayWindows(q)
  const rows: QuotaRemainRow[] = []
  if (main.fiveHour.provided) {
    rows.push({
      key: `${q.limitId}:5h`,
      label: '5小时',
      remaining: main.fiveHour.remaining,
      resetsAt: main.fiveHour.resetsAt
    })
  }
  if (main.sevenDay.provided) {
    rows.push({
      key: `${q.limitId}:7d`,
      label: '7天',
      remaining: main.sevenDay.remaining,
      resetsAt: main.sevenDay.resetsAt
    })
  }
  for (const e of main.extras) {
    rows.push({
      key: e.key,
      label: e.label,
      remaining: e.remaining,
      resetsAt: e.resetsAt
    })
  }
  if (rows.length) return rows

  if (!q.buckets?.length) {
    pushRow(rows, `${q.limitId}:p`, '主', q.primary)
    pushRow(rows, `${q.limitId}:s`, '次', q.secondary)
    return rows
  }
  for (const b of q.buckets) {
    const hasP = b.primary && (b.primary.usedPercent != null || b.primary.resetsAt != null)
    const hasS = b.secondary && (b.secondary.usedPercent != null || b.secondary.resetsAt != null)
    if (hasP) {
      const label = hasS ? `${b.displayLabel} · 主` : b.displayLabel
      pushRow(rows, `${b.limitId}:p`, label, b.primary)
    }
    if (hasS) {
      const label = hasP ? `${b.displayLabel} · 次` : b.displayLabel
      pushRow(rows, `${b.limitId}:s`, label, b.secondary)
    }
  }
  return rows
}
