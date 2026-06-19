import { writeFileSync, renameSync } from 'node:fs'

/**
 * Atomic file write: write to a temp file first, then rename.
 * Prevents corrupt data if the process crashes mid-write.
 *
 * 归属：跨层共享叶子层 utils/（ADR 0004）。renameSync 在 POSIX/NTFS 上都是原子操作，
 * 被 infra（pi-config-bridge/pi-provider-store）和 services（config-service）共用，
 * 无业务语义，故放在所有业务层之下的 utils 而非任一业务层。
 */
export function atomicWrite(filePath: string, data: string): void {
  const tmpPath = filePath + '.tmp'
  writeFileSync(tmpPath, data, 'utf-8')
  renameSync(tmpPath, filePath)
}
