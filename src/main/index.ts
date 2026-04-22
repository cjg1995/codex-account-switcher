import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { AccountService } from './account-service'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

app.setName('codex-account-switcher')

const service = new AccountService()

function getArgValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag)
  if (idx < 0) return null
  return process.argv[idx + 1] ?? null
}

function isDebugWarmupMode(): boolean {
  return Boolean(process.env.CODEX_DEBUG_WARMUP_ID ?? getArgValue('--debug-warmup'))
}

async function runDebugModeIfNeeded(): Promise<boolean> {
  const warmupAccountId = process.env.CODEX_DEBUG_WARMUP_ID ?? getArgValue('--debug-warmup')
  if (!warmupAccountId) return false
  const result = await service.debugWarmup(warmupAccountId)
  const outPath =
    process.env.CODEX_DEBUG_OUT ?? getArgValue('--debug-out') ?? path.join(process.cwd(), 'warmup-debug.json')
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8')
  await app.quit()
  return true
}

function resolvePreload(): string {
  const base = path.join(__dirname, '../preload')
  const mjs = path.join(base, 'index.mjs')
  if (fs.existsSync(mjs)) return mjs
  return path.join(base, 'index.js')
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 860,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      sandbox: false
    },
    title: 'Codex 切号器'
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('accounts:list', () => service.listAccounts())

  ipcMain.handle('accounts:addViaLogin', async () => {
    await service.addViaLogin()
    return service.listAccounts()
  })

  ipcMain.handle('accounts:addViaLoginCancel', () => {
    service.cancelAddViaLogin()
  })

  ipcMain.handle('accounts:importAuthJsonFile', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const openOptions = {
      title: '选择 auth.json 或账号备份 JSON',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile', 'multiSelections']
    } as const
    const { canceled, filePaths } = win
      ? await dialog.showOpenDialog(win, openOptions)
      : await dialog.showOpenDialog(openOptions)
    if (canceled || !filePaths[0]) {
      throw new Error('已取消')
    }
    const importSummary = await service.importAuthJsonFromPaths(filePaths)
    await service.refreshMany(importSummary.accountIds)
    return { ...service.listAccounts(), importSummary }
  })

  ipcMain.handle('accounts:exportAuthJsonFile', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const openOptions = {
      title: '选择 JSON 导出目录',
      defaultPath: app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory']
    } as const
    const { canceled, filePaths } = win
      ? await dialog.showOpenDialog(win, openOptions)
      : await dialog.showOpenDialog(openOptions)
    if (canceled || !filePaths[0]) {
      throw new Error('已取消')
    }
    return service.exportAuthJsonToDirectory(filePaths[0])
  })

  ipcMain.handle('accounts:switch', async (_e, accountId: string) => {
    const result = await service.switchAccount(accountId)
    const list = service.listAccounts()
    return { ...result, ...list }
  })

  ipcMain.handle('accounts:refreshOne', async (_e, accountId: string) => {
    await service.refreshOne(accountId)
    return service.listAccounts()
  })

  ipcMain.handle('accounts:refreshAll', async () => {
    await service.refreshAll()
    return service.listAccounts()
  })

  ipcMain.handle('accounts:warmupNeverRefreshed', async () => {
    const warmed = await service.warmupNeverRefreshed()
    return { warmed, ...service.listAccounts() }
  })

  ipcMain.handle('accounts:warmupOne', async (_e, accountId: string) => {
    const result = await service.warmupOne(accountId)
    return {
      ...service.listAccounts(),
      warmupMode: result.mode,
      warmupMessage: result.message
    }
  })

  ipcMain.handle('accounts:refreshLive', async () => {
    const live = await service.refreshLive()
    return { live, ...service.listAccounts() }
  })

  ipcMain.handle('accounts:importLive', async () => {
    await service.importLive()
    return service.listAccounts()
  })

  ipcMain.handle('accounts:updateNickname', (_e, accountId: string, nickname: string) => {
    service.updateNickname(accountId, nickname)
    return service.listAccounts()
  })

  ipcMain.handle('accounts:reorder', (_e, accountIds: string[]) => {
    service.reorderAccounts(accountIds)
    return service.listAccounts()
  })

  ipcMain.handle('accounts:delete', (_e, accountId: string) => {
    const deleted = service.deleteAccount(accountId)
    if (!deleted) throw new Error('未找到账号')
    return service.listAccounts()
  })
}

app.whenReady().then(() => {
  runDebugModeIfNeeded()
    .then((handled) => {
      if (handled) return
      Menu.setApplicationMenu(null)
      registerIpc()
      createWindow()
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err)
      process.stderr.write(`${msg}\n`)
      app.quit()
    })
})

app.on('window-all-closed', () => {
  if (isDebugWarmupMode()) return
  if (process.platform !== 'darwin') app.quit()
})
