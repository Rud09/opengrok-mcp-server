import * as crypto from 'crypto';
import * as os from 'os';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getConfigDirectory } from '../config.js';

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
  const entry = getKeyringEntry(username);
  if (entry) {
    try {
      entry.setPassword(password);
      return;
    } catch { /* fall through to file fallback */ }
  }
  storeInEncryptedFile(username, password);
}

export function retrievePassword(username: string): string | null {
  const entry = getKeyringEntry(username);
  if (entry) {
    try {
      return entry.getPassword();
    } catch { /* fall through to file fallback */ }
  }
  return retrieveFromEncryptedFile(username);
}

export function deleteCredentials(username: string): void {
  const entry = getKeyringEntry(username);
  if (entry) {
    try { entry.deletePassword(); } catch { /* not stored in keyring */ }
  }
  // Also clear encrypted files
  const dir = getConfigDirectory();
  const encPath = join(dir, `cred-${username}.enc`);
  if (existsSync(encPath)) {
    try { unlinkSync(encPath); } catch { /* ignore */ }
  }
}

function deriveFileKey(username: string): string {
  // Derive a deterministic key from machine identity so no key file is needed.
  // The key is specific to this machine and username — not exportable to other machines.
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
    return decryptWithGcm(encrypted, key);
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
