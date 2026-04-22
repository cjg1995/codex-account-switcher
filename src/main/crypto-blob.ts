import { safeStorage } from 'electron'
import fs from 'fs'

export function encryptAuthSnapshot(plainUtf8: string): Buffer {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage 不可用，请确认系统已启用加密')
  }
  return safeStorage.encryptString(plainUtf8)
}

export function decryptAuthSnapshot(buf: Buffer): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage 不可用')
  }
  return safeStorage.decryptString(buf)
}

export function writeEncryptedBlob(filePath: string, plainUtf8: string): void {
  const enc = encryptAuthSnapshot(plainUtf8)
  fs.writeFileSync(filePath, enc)
}

export function readEncryptedBlob(filePath: string): string {
  const buf = fs.readFileSync(filePath)
  return decryptAuthSnapshot(buf)
}
