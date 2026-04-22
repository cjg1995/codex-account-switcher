import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ImportAuthJsonSummary, LiveSessionInfo, QuotaSnapshot, SavedAccount } from '@shared/types'
import { formatReset, getQuotaDisplayWindows, quotaSummaryText } from '@shared/quota-summary'

const AUTO_REFRESH_MS = 5 * 60 * 1000
type QuotaFilterValue = 'all' | 'available' | 'empty' | 'blocked'

function QuotaProgressBlock({
  label,
  q,
  tone
}: {
  label: string
  q: { provided: boolean; remaining: number | null; resetsAt: number | null }
  tone: 'green' | 'blue'
}) {
  const percentText = q.provided ? (q.remaining == null ? '--' : `${q.remaining}%`) : '未提供'
  const width = q.provided && q.remaining != null ? Math.max(0, Math.min(100, q.remaining)) : 0
  const resetText = q.provided ? '重置：' + formatReset(q.resetsAt) : '重置：未提供'
  const trackCls = tone === 'green' ? 'quota-track quota-track-green' : 'quota-track quota-track-blue'
  const fillCls = tone === 'green' ? 'quota-fill quota-fill-green' : 'quota-fill quota-fill-blue'

  return (
    <div className="quota-block">
      <div className="quota-block-head">
        <span>{label}</span>
        <span className="quota-value">
          <strong>{percentText}</strong>
        </span>
      </div>
      <div className={trackCls}>
        <div className={fillCls} style={{ width: `${width}%` }} />
      </div>
      <div className="quota-reset-text">{resetText}</div>
    </div>
  )
}

function planBadgeText(planType: string | null | undefined): string {
  const p = String(planType ?? '')
    .trim()
    .toUpperCase()
  return p || 'UNKNOWN'
}

function statusPill(status: SavedAccount['status']): { cls: string; text: string } {
  switch (status) {
    case 'ok':
      return { cls: 'pill pill-ok', text: '正常' }
    case 'refreshing':
      return { cls: 'pill pill-warn', text: '刷新中' }
    case 'unauthorized':
      return { cls: 'pill pill-bad', text: '未授权/过期' }
    case 'no_quota':
      return { cls: 'pill pill-warn', text: '无额度数据' }
    case 'app_server_failed':
      return { cls: 'pill pill-bad', text: 'app-server 失败' }
    case 'snapshot_corrupt':
      return { cls: 'pill pill-bad', text: '快照损坏' }
    default:
      return { cls: 'pill pill-neutral', text: '待刷新' }
  }
}

function liveStatusLabel(s: LiveSessionInfo['status']): string {
  switch (s) {
    case 'ok':
      return '正常'
    case 'no_live_file':
      return '无 auth.json'
    case 'unauthorized':
      return '未授权/过期'
    case 'no_quota':
      return '无额度数据'
    case 'app_server_failed':
      return 'app-server 失败'
    default:
      return s
  }
}

function isBlockedAccount(status: SavedAccount['status']): boolean {
  return status === 'unauthorized' || status === 'app_server_failed' || status === 'snapshot_corrupt'
}

function getWindowRemainingValues(snapshot: QuotaSnapshot | null): number[] {
  const display = getQuotaDisplayWindows(snapshot)
  return [display.fiveHour, display.sevenDay]
    .map((item) => (item.provided && item.remaining != null ? item.remaining : null))
    .filter((item): item is number => item != null)
}

function matchesQuotaFilter(account: SavedAccount, filter: QuotaFilterValue): boolean {
  if (filter === 'all') return true

  const remainingValues = getWindowRemainingValues(account.lastQuotaSnapshot)
  const quotaExhausted = remainingValues.length > 0 && remainingValues.every((value) => value <= 0)
  const blocked = isBlockedAccount(account.status)

  if (filter === 'blocked') return blocked
  if (filter === 'empty') return account.status === 'no_quota' || (!blocked && quotaExhausted)
  return !blocked && account.status !== 'no_quota' && !quotaExhausted
}

function importSummaryText(summary: ImportAuthJsonSummary): string {
  const parts: string[] = []
  if (summary.imported > 0) parts.push(`新增 ${summary.imported}`)
  if (summary.updated > 0) parts.push(`更新 ${summary.updated}`)
  if (summary.skipped > 0) parts.push(`跳过 ${summary.skipped}`)
  if (summary.failed > 0) parts.push(`失败 ${summary.failed}`)
  return parts.length > 0 ? `JSON 导入并刷新完成：${parts.join('，')}` : 'JSON 导入并刷新完成'
}

export default function App() {
  const [accounts, setAccounts] = useState<SavedAccount[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [liveAuthPresent, setLiveAuthPresent] = useState(false)
  const [liveInfo, setLiveInfo] = useState<LiveSessionInfo | null>(null)
  const [quotaFilter, setQuotaFilter] = useState<QuotaFilterValue>('all')
  const [sortConfig, setSortConfig] = useState<{ field: '5h' | '7d'; dir: 'asc' | 'desc' } | null>(null)
  const [loginInProgress, setLoginInProgress] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [deleteModal, setDeleteModal] = useState<{ id: string; email: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const initialQuotaLoadedRef = useRef(false)
  const quotaRefreshRunningRef = useRef(false)
  const [quotaRefreshUi, setQuotaRefreshUi] = useState<
    { mode: 'idle' } | { mode: 'all' } | { mode: 'warmup' } | { mode: 'row'; accountId: string }
  >({ mode: 'idle' })

  const quotaRefreshEnter = useCallback(
    (ui: { mode: 'all' } | { mode: 'warmup' } | { mode: 'row'; accountId: string }): boolean => {
      if (quotaRefreshRunningRef.current || loginInProgress) return false
      quotaRefreshRunningRef.current = true
      setQuotaRefreshUi(ui)
      return true
    },
    [loginInProgress]
  )

  const quotaRefreshExit = useCallback(() => {
    quotaRefreshRunningRef.current = false
    setQuotaRefreshUi({ mode: 'idle' })
  }, [])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 4500)
  }, [])

  const applyListState = useCallback(
    (r: { accounts: SavedAccount[]; activeAccountId: string | null; liveAuthPresent: boolean }) => {
      setAccounts(r.accounts)
      setActiveId(r.activeAccountId)
      setLiveAuthPresent(r.liveAuthPresent)
    },
    []
  )

  const reload = useCallback(async () => {
    const r = await window.codexSwitcher.listAccounts()
    applyListState(r)
    return r
  }, [applyListState])

  const runAutoRefresh = useCallback(
    async (opts: { showErrorToast: boolean; showSuccessToast: boolean }) => {
      if (!quotaRefreshEnter({ mode: 'all' })) return
      try {
        const r = await window.codexSwitcher.refreshAll()
        applyListState(r)
        setLiveInfo(null)
        if (opts.showSuccessToast) showToast('已加载并完成额度刷新')
      } catch (e) {
        if (opts.showErrorToast) showToast(e instanceof Error ? e.message : String(e))
      } finally {
        quotaRefreshExit()
      }
    },
    [applyListState, quotaRefreshEnter, quotaRefreshExit, showToast]
  )

  useEffect(() => {
    if (initialQuotaLoadedRef.current) return
    initialQuotaLoadedRef.current = true
    void (async () => {
      try {
        const r = await reload()
        if (r.accounts.length > 0) {
          await runAutoRefresh({ showErrorToast: true, showSuccessToast: true })
        } else {
          showToast('已加载列表（暂无账号）')
        }
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [reload, runAutoRefresh, showToast])

  useEffect(() => {
    if (accounts.length === 0) return
    const timer = window.setInterval(() => {
      if (loginInProgress || quotaRefreshRunningRef.current) return
      void runAutoRefresh({ showErrorToast: false, showSuccessToast: false })
    }, AUTO_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [accounts.length, loginInProgress, runAutoRefresh])

  const filtered = useMemo(() => {
    const result = accounts.filter((a) => matchesQuotaFilter(a, quotaFilter))
    if (sortConfig) {
      result.sort((a, b) => {
        const aDisplay = getQuotaDisplayWindows(a.lastQuotaSnapshot)
        const bDisplay = getQuotaDisplayWindows(b.lastQuotaSnapshot)

        let aVal = -1, bVal = -1
        if (sortConfig.field === '5h') {
           aVal = aDisplay.fiveHour.provided && aDisplay.fiveHour.remaining != null ? aDisplay.fiveHour.remaining : -1
           bVal = bDisplay.fiveHour.provided && bDisplay.fiveHour.remaining != null ? bDisplay.fiveHour.remaining : -1
        } else if (sortConfig.field === '7d') {
           aVal = aDisplay.sevenDay.provided && aDisplay.sevenDay.remaining != null ? aDisplay.sevenDay.remaining : -1
           bVal = bDisplay.sevenDay.provided && bDisplay.sevenDay.remaining != null ? bDisplay.sevenDay.remaining : -1
        }

        if (aVal < bVal) return sortConfig.dir === 'asc' ? -1 : 1
        if (aVal > bVal) return sortConfig.dir === 'asc' ? 1 : -1
        return 0
      })
    }
    return result
  }, [accounts, quotaFilter, sortConfig])
  const filterCounts = useMemo(
    () => ({
      all: accounts.length,
      available: accounts.filter((a) => matchesQuotaFilter(a, 'available')).length,
      empty: accounts.filter((a) => matchesQuotaFilter(a, 'empty')).length,
      blocked: accounts.filter((a) => matchesQuotaFilter(a, 'blocked')).length
    }),
    [accounts]
  )

  const onAdd = async () => {
    setLoginInProgress(true)
    try {
      const r = await window.codexSwitcher.addViaLogin()
      setAccounts(r.accounts)
      setActiveId(r.activeAccountId)
      setLiveAuthPresent(r.liveAuthPresent)
      showToast('账号已添加')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg === '已取消登录') showToast('已取消登录')
      else if (msg !== '已取消') showToast(msg)
    } finally {
      setLoginInProgress(false)
    }
  }

  const onCancelLogin = () => {
    void window.codexSwitcher.addViaLoginCancel()
  }

  const onImportAuthJson = async () => {
    if (!quotaRefreshEnter({ mode: 'all' })) return
    try {
      const r = await window.codexSwitcher.importAuthJsonFile()
      applyListState(r)
      setLiveInfo(null)
      showToast(importSummaryText(r.importSummary))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg !== '已取消') showToast(msg)
    } finally {
      quotaRefreshExit()
    }
  }

  const onExportAuthJson = async () => {
    try {
      const r = await window.codexSwitcher.exportAuthJsonFile()
      showToast(`已导出 ${r.accountCount} 个账号 JSON`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg !== '已取消') showToast(msg)
    }
  }

  const onImportLive = async () => {
    if (!quotaRefreshEnter({ mode: 'all' })) return
    try {
      const r = await window.codexSwitcher.importLive()
      setAccounts(r.accounts)
      setActiveId(r.activeAccountId)
      setLiveAuthPresent(r.liveAuthPresent)
      setLiveInfo(null)
      showToast('已从 Live 导入并刷新')
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      quotaRefreshExit()
    }
  }

  const onRefreshAll = async () => {
    if (!quotaRefreshEnter({ mode: 'all' })) return
    try {
      const r = await window.codexSwitcher.refreshAll()
      setAccounts(r.accounts)
      setActiveId(r.activeAccountId)
      setLiveAuthPresent(r.liveAuthPresent)
      showToast('已全部刷新')
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      quotaRefreshExit()
    }
  }

  const onWarmup = async () => {
    if (!quotaRefreshEnter({ mode: 'warmup' })) return
    try {
      const r = await window.codexSwitcher.warmupNeverRefreshed()
      applyListState(r)
      setLiveInfo(null)
      showToast(r.warmed > 0 ? `已预热 ${r.warmed} 个 100% 账号` : '没有命中 100% 额度的账号')
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      quotaRefreshExit()
    }
  }

  const onSwitch = async (id: string) => {
    try {
      const r = await window.codexSwitcher.switchAccount(id)
      setAccounts(r.accounts)
      setActiveId(r.activeAccountId)
      setLiveAuthPresent(r.liveAuthPresent)
      if (r.success) showToast(`已切换。${r.warning}`)
      else showToast(r.warning)
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const onRefreshRow = async (id: string) => {
    if (!quotaRefreshEnter({ mode: 'row', accountId: id })) return
    try {
      const r = await window.codexSwitcher.refreshOne(id)
      setAccounts(r.accounts)
      setActiveId(r.activeAccountId)
      setLiveAuthPresent(r.liveAuthPresent)
      const refreshed = r.accounts.find((a) => a.id === id)
      if (refreshed?.status === 'ok') {
        showToast('已刷新该账号额度')
      } else if (refreshed) {
        showToast(`账号状态：${statusPill(refreshed.status).text}`)
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      quotaRefreshExit()
    }
  }

  const onWarmupRow = async (id: string) => {
    if (!quotaRefreshEnter({ mode: 'row', accountId: id })) return
    try {
      const r = await window.codexSwitcher.warmupOne(id)
      setAccounts(r.accounts)
      setActiveId(r.activeAccountId)
      setLiveAuthPresent(r.liveAuthPresent)
      showToast(r.warmupMessage)
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      quotaRefreshExit()
    }
  }


  const confirmDelete = async () => {
    if (!deleteModal) return
    setDeleting(true)
    try {
      const r = await window.codexSwitcher.deleteAccount(deleteModal.id)
      setAccounts(r.accounts)
      setActiveId(r.activeAccountId)
      setLiveAuthPresent(r.liveAuthPresent)
      setDeleteModal(null)
      showToast('账号已删除')
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="app">
      <header className="toolbar">
        <span className="toolbar-title">Codex 切号器</span>
        <select
          className="filter-select"
          aria-label="额度筛选"
          value={quotaFilter}
          onChange={(e) => setQuotaFilter(e.target.value as QuotaFilterValue)}
        >
          <option value="all">全部（{filterCounts.all}）</option>
          <option value="available">可用（{filterCounts.available}）</option>
          <option value="empty">无额度（{filterCounts.empty}）</option>
          <option value="blocked">封禁（{filterCounts.blocked}）</option>
        </select>
        <button
          type="button"
          className="btn btn-toolbar"
          onClick={() => void onAdd()}
        >
          添加账号
        </button>
        <button type="button" className="btn btn-toolbar" onClick={() => void onImportLive()}>
          导入当前 Live
        </button>
        <button type="button" className="btn btn-toolbar" onClick={() => void onImportAuthJson()}>
          从 JSON 导入
        </button>
        <button
          type="button"
          className="btn btn-toolbar"
          onClick={() => void onExportAuthJson()}
          disabled={accounts.length === 0}
        >
          导出 JSON
        </button>
        <button type="button" className="btn btn-toolbar" onClick={() => void onRefreshAll()}>
          刷新全部
        </button>
        <button type="button" className="btn btn-toolbar" onClick={() => void onWarmup()}>
          一键预热
        </button>
      </header>
      {loginInProgress ? (
        <div className="path-hint login-wait-hint">
          已打开浏览器登录，窗口可继续使用；未完成可点「取消登录」结束等待。
          <button type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: 8 }} onClick={onCancelLogin}>
            取消登录
          </button>
        </div>
      ) : null}
      {liveInfo ? (
        <div className="path-hint live-banner">
          <strong>Live 会话</strong> {liveInfo.email ?? '—'} · {liveInfo.planType ?? '—'} · {liveStatusLabel(liveInfo.status)}
          {quotaRefreshUi.mode === 'all' ? (
            <>
              {' · '}
              <span className="quota-cell-loading quota-cell-loading-inline" aria-label="刷新中">
                <span className="quota-spinner" aria-hidden />
              </span>
            </>
          ) : liveInfo.lastQuotaSnapshot ? (
            ` · ${quotaSummaryText(liveInfo.lastQuotaSnapshot)}`
          ) : null}
        </div>
      ) : null}

      <div className="table-wrap">
        {filtered.length === 0 ? (
          <div className="empty">{accounts.length === 0 ? '暂无账号，点击「添加账号」通过浏览器登录。' : '当前筛选下无账号'}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>账号信息</th>
                <th
                  onClick={() => setSortConfig(c => ({ field: '5h', dir: c?.field === '5h' && c.dir === 'asc' ? 'desc' : 'asc' }))}
                  style={{ cursor: 'pointer' }}
                  title="点击按额度比例排序"
                >
                  5h 额度 {sortConfig?.field === '5h' ? (sortConfig.dir === 'asc' ? '↑' : '↓') : ''}
                </th>
                <th
                  onClick={() => setSortConfig(c => ({ field: '7d', dir: c?.field === '7d' && c.dir === 'asc' ? 'desc' : 'asc' }))}
                  style={{ cursor: 'pointer' }}
                  title="点击按额度比例排序"
                >
                  7d 额度 {sortConfig?.field === '7d' ? (sortConfig.dir === 'asc' ? '↑' : '↓') : ''}
                </th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => {
                const q = a.lastQuotaSnapshot
                const isActive = a.id === activeId
                const display = getQuotaDisplayWindows(q)
                const quotaLoading =
                  quotaRefreshUi.mode === 'all' ||
                  (quotaRefreshUi.mode === 'row' && quotaRefreshUi.accountId === a.id)
                return (
                  <tr key={a.id} className={isActive ? 'row-active' : undefined}>
                    <td>
                      <div
                        className="account-primary"
                        style={{ cursor: 'pointer' }}
                        title="点击复制账号"
                        onClick={() => {
                          navigator.clipboard.writeText(a.email)
                          showToast('已复制账号：' + a.email)
                        }}
                      >
                        <span className="account-email" title={a.email}>
                          {a.email}
                        </span>
                        <span className="plan-badge">{planBadgeText(q?.planType ?? a.planType)}</span>
                        {isActive ? <span className="plan-badge plan-badge-active">当前</span> : null}
                      </div>
                      <div className="account-sub">
                        AUTH | {(a.stableFingerprint ?? a.fingerprint).slice(0, 12).toUpperCase()}
                      </div>

                    </td>
                    <td>
                      <QuotaProgressBlock label="5小时" q={display.fiveHour} tone="green" />
                    </td>
                    <td>
                      <QuotaProgressBlock label="7天" q={display.sevenDay} tone="blue" />
                    </td>
                    <td className="status-cell">
                      <span className={statusPill(a.status).cls}>{statusPill(a.status).text}</span>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => void onSwitch(a.id)}>
                          切换
                        </button>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void onRefreshRow(a.id)}>
                          刷新
                        </button>
                        <button type="button" className="btn btn-sm btn-warmup" onClick={() => void onWarmupRow(a.id)}>
                          预热
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          onClick={() => setDeleteModal({ id: a.id, email: a.email })}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {quotaRefreshUi.mode !== 'idle' && (
        <div className="global-refreshing-float">
          <span className="quota-spinner" aria-hidden />
          <span>额度刷新中...</span>
        </div>
      )}
      {toast ? <div className="toast">{toast}</div> : null}

      {deleteModal ? (
        <div className="modal-back" role="presentation" onClick={() => !deleting && setDeleteModal(null)}>
          <div className="modal" role="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>确认删除</h3>
            <p style={{ margin: '0 0 12px', color: 'var(--text)' }}>
              确定要删除账号 <strong>{deleteModal.email}</strong> 吗？此操作不可恢复。
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" disabled={deleting} onClick={() => setDeleteModal(null)}>
                取消
              </button>
              <button type="button" className="btn btn-danger" disabled={deleting} onClick={() => void confirmDelete()}>
                {deleting ? '删除中…' : '删除'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
