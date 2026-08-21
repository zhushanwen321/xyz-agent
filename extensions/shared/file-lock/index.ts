// Re-export barrel：pi 包惯例（源码在 src/，包根 index.ts 只做转发）。
export {
	withFileLock,
	withFileLockSync,
	type FileLockOptions,
	type SyncFileLockOptions,
} from "./src/file-lock.ts";
