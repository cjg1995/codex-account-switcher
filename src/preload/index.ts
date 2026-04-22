import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('codexSwitcher', {
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  addViaLogin: () => ipcRenderer.invoke('accounts:addViaLogin'),
  addViaLoginCancel: () => ipcRenderer.invoke('accounts:addViaLoginCancel'),
  importAuthJsonFile: () => ipcRenderer.invoke('accounts:importAuthJsonFile'),
  exportAuthJsonFile: () => ipcRenderer.invoke('accounts:exportAuthJsonFile'),
  switchAccount: (accountId: string) => ipcRenderer.invoke('accounts:switch', accountId),
  refreshOne: (accountId: string) => ipcRenderer.invoke('accounts:refreshOne', accountId),
  refreshAll: () => ipcRenderer.invoke('accounts:refreshAll'),
  warmupNeverRefreshed: () => ipcRenderer.invoke('accounts:warmupNeverRefreshed'),
  warmupOne: (accountId: string) => ipcRenderer.invoke('accounts:warmupOne', accountId),
  refreshLive: () => ipcRenderer.invoke('accounts:refreshLive'),
  importLive: () => ipcRenderer.invoke('accounts:importLive'),
  updateNickname: (accountId: string, nickname: string) =>
    ipcRenderer.invoke('accounts:updateNickname', accountId, nickname),
  deleteAccount: (accountId: string) => ipcRenderer.invoke('accounts:delete', accountId),
  reorderAccounts: (accountIds: string[]) => ipcRenderer.invoke('accounts:reorder', accountIds)
})
