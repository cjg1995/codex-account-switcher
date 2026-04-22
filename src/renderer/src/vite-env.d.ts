/// <reference types="vite/client" />

import type {
  ExportAuthJsonSummary,
  ImportAuthJsonSummary,
  LiveSessionInfo,
  SavedAccount,
  SwitchResult
} from '@shared/types'

export interface ListResult {
  accounts: SavedAccount[]
  activeAccountId: string | null
  liveAuthPresent: boolean
}

export interface RefreshLiveResult extends ListResult {
  live: LiveSessionInfo
}

export interface SwitchResponse extends SwitchResult, ListResult {}

export interface ImportAuthJsonResponse extends ListResult {
  importSummary: ImportAuthJsonSummary
}

export interface WarmupResult extends ListResult {
  warmed: number
}

export interface WarmupOneResponse extends ListResult {
  warmupMode: 'warmed' | 'refreshed' | 'failed'
  warmupMessage: string
}

declare global {
  interface Window {
    codexSwitcher: {
      listAccounts: () => Promise<ListResult>
      addViaLogin: () => Promise<ListResult>
      addViaLoginCancel: () => Promise<void>
      importAuthJsonFile: () => Promise<ImportAuthJsonResponse>
      exportAuthJsonFile: () => Promise<ExportAuthJsonSummary>
      switchAccount: (accountId: string) => Promise<SwitchResponse>
      refreshOne: (accountId: string) => Promise<ListResult>
      refreshAll: () => Promise<ListResult>
      warmupNeverRefreshed: () => Promise<WarmupResult>
      warmupOne: (accountId: string) => Promise<WarmupOneResponse>
      refreshLive: () => Promise<RefreshLiveResult>
      importLive: () => Promise<ListResult>
      updateNickname: (accountId: string, nickname: string) => Promise<ListResult>
      deleteAccount: (accountId: string) => Promise<ListResult>
      reorderAccounts: (accountIds: string[]) => Promise<ListResult>
    }
  }
}

export {}
