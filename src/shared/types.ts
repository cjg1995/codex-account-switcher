export type AccountStatus =
  | 'ok'
  | 'unauthorized'
  | 'no_quota'
  | 'app_server_failed'
  | 'snapshot_corrupt'
  | 'idle'
  | 'refreshing'

export interface QuotaWindow {
  usedPercent: number | null
  resetsAt: number | null
  windowDurationMins?: number | null
}

export interface QuotaCredits {
  hasCredits?: boolean
  unlimited?: boolean
  balance?: number | null
}

export interface QuotaBucketRow {
  limitId: string
  limitName: string | null
  displayLabel: string
  primary: QuotaWindow | null
  secondary: QuotaWindow | null
}

export interface QuotaSnapshot {
  limitId: string
  limitName: string | null
  primary: QuotaWindow | null
  secondary: QuotaWindow | null
  credits: QuotaCredits | null
  planType: string | null
  refreshedAt: string
  buckets?: QuotaBucketRow[]
}

export interface SavedAccount {
  id: string
  email: string
  planType: string | null
  nickname: string
  fingerprint: string
  /** 不含 token 的指纹，用于 Live 与列表匹配；旧数据可在 listAccounts 时补全 */
  stableFingerprint?: string
  encryptedAuthBlobRef: string
  lastQuotaSnapshot: QuotaSnapshot | null
  status: AccountStatus
  addedAt: string
  lastRefreshedAt: string | null
}

export interface SwitchResult {
  success: boolean
  activeAccountId: string | null
  backupPath: string | null
  warning: string
}

export interface AccountsStoreFile {
  version: 1
  accounts: SavedAccount[]
}

export interface ImportAuthJsonError {
  filePath: string
  message: string
}

export interface ImportAuthJsonSummary {
  files: number
  accounts: number
  imported: number
  updated: number
  skipped: number
  failed: number
  accountIds: string[]
  errors: ImportAuthJsonError[]
}

export interface ExportAuthJsonSummary {
  directoryPath: string
  accountCount: number
  filePaths: string[]
}

export type LiveSessionStatus =
  | 'ok'
  | 'no_live_file'
  | 'unauthorized'
  | 'no_quota'
  | 'app_server_failed'

export interface LiveSessionInfo {
  email: string | null
  planType: string | null
  lastQuotaSnapshot: QuotaSnapshot | null
  lastRefreshedAt: string | null
  status: LiveSessionStatus
  stderrHint?: string
}
