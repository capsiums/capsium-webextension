import { unzipSync } from 'fflate';

/**
 * Thin wrapper over fflate. Returns package-relative POSIX paths mapped to
 * raw bytes; directory entries are omitted.
 */
export function unzipPackage(zipBytes: Uint8Array): Map<string, Uint8Array> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes);
  } catch (error) {
    throw new Error(
      `Not a valid .cap (ZIP) archive: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const files = new Map<string, Uint8Array>();
  for (const [path, bytes] of Object.entries(entries)) {
    if (path.endsWith('/')) continue;
    files.set(path, bytes);
  }
  return files;
}
