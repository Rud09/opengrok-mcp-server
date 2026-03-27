/**
 * File reference cache — tracks which memory files have been "uploaded" in the
 * current session. When MCP SDK gains Files API support, this becomes the upload
 * layer. For now it tracks content hashes to detect when content changed,
 * enabling opengrok_read_memory to return "[unchanged]" when content is identical
 * to the last read.
 */
export class FileReferenceCache {
  private cache = new Map<string, { hash: string; uploadedAt: number }>();

  /** Returns true if the content is unchanged since last reference. */
  isUnchanged(filename: string, content: string): boolean {
    const entry = this.cache.get(filename);
    if (!entry) return false;
    return entry.hash === simpleHash(content);
  }

  /**
   * Record that we have "uploaded" this content.
   * @returns hash string acting as the "file reference" for this session.
   */
  register(filename: string, content: string): string {
    const hash = simpleHash(content);
    this.cache.set(filename, { hash, uploadedAt: Date.now() });
    return hash;
  }

  /** Clear all cache entries (e.g., on session reset). */
  clear(): void {
    this.cache.clear();
  }
}

export function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
