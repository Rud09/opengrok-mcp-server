import * as crypto from 'crypto';
import * as os from 'os';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getConfigDirectory, updateCredentialRotationTimestamp } from '../config.js';

const SERVICE = 'opengrok-mcp';

function getKeyringEntry(username: string): { setPassword(p: string): void; getPassword(): string | null; deletePassword(): void } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Entry } = require('@napi-rs/keyring') as { Entry: new (service: string, account: string) => { setPassword(p: string): void; getPassword(): string | null; deletePassword(): void } };
    return new Entry(SERVICE, username);
  } catch {
    return null;
  }
}

export function storeCredentials(
  _url: string,
  username: string,
  password: string
): void {
  purgeLegacyFiles(username);
  const entry = getKeyringEntry(username);
  if (entry) {
    try {
      entry.setPassword(password);
      updateCredentialRotationTimestamp(getConfigDirectory());
      return;
    } catch { /* fall through to file fallback */ }
  }
  storeInEncryptedFile(username, password);
  updateCredentialRotationTimestamp(getConfigDirectory());
}

/** Remove credential artifacts left by older versions of the setup wizard. */
function purgeLegacyFiles(username: string): void {
  const dir = getConfigDirectory();
  for (const name of [`cred-${username}.key`, 'credentials.enc', '.salt', 'config']) {
    const p = join(dir, name);
    if (existsSync(p)) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
  }
}

export function retrievePassword(username: string): string | null {
  const entry = getKeyringEntry(username);
  if (entry) {
    try {
      const pw = entry.getPassword();
      if (pw !== null) return pw;
      // null means keyring accessible but no entry — fall through to file
    } catch { /* keyring unavailable — fall through to file fallback */ }
  }
  return retrieveFromEncryptedFile(username);
}

export function deleteCredentials(username: string): void {
  const entry = getKeyringEntry(username);
  if (entry) {
    try { entry.deletePassword(); } catch { /* not stored in keyring */ }
  }
  // Clear current and legacy credential files
  const dir = getConfigDirectory();
  for (const name of [`cred-${username}.enc`, `cred-${username}.key`, 'credentials.enc', '.salt']) {
    const p = join(dir, name);
    if (existsSync(p)) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
  }
}

function deriveFileKey(username: string): string {
  // Platform-only key — stable across hostname changes (hostname-based key broke on
  // DHCP reassignment, VPN, container restarts, and renames).
  return crypto.createHash('sha256')
    .update(`opengrok-mcp:${username}:${os.platform()}`)
    .digest('hex');
}

function deriveLegacyFileKey(username: string): string {
  // Old key format that included hostname — kept only for transparent migration.
  return crypto.createHash('sha256')
    .update(`opengrok-mcp:${username}:${os.hostname()}:${os.platform()}`)
    .digest('hex');
}

function storeInEncryptedFile(username: string, password: string): void {
  const dir = getConfigDirectory();
  mkdirSync(dir, { recursive: true });
  const key = deriveFileKey(username);
  const encrypted = encryptWithGcm(password, key);
  writeFileSync(join(dir, `cred-${username}.enc`), encrypted, { encoding: 'utf8', mode: 0o600 });
}

function retrieveFromEncryptedFile(username: string): string | null {
  const dir = getConfigDirectory();
  const encPath = join(dir, `cred-${username}.enc`);
  if (!existsSync(encPath)) return null;
  try {
    const encrypted = readFileSync(encPath, 'utf8').trim();
    const key = deriveFileKey(username);
    try {
      return decryptWithGcm(encrypted, key);
    } catch {
      // Try legacy hostname-based key for transparent one-time migration.
      const legacyKey = deriveLegacyFileKey(username);
      const password = decryptWithGcm(encrypted, legacyKey);
      // Re-encrypt under the new stable key so future reads succeed.
      storeInEncryptedFile(username, password);
      return password;
    }
  } catch {
    return null;
  }
}

function encryptWithGcm(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = (cipher as crypto.CipherGCM).getAuthTag();
  return 'gcm:' + Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptWithGcm(data: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const raw = Buffer.from(data.replace(/^gcm:/, ''), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv) as crypto.DecipherGCM;
  decipher.setAuthTag(tag);
  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
}
