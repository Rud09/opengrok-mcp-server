import { Entry } from '@napi-rs/keyring';
import * as crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getConfigDirectory } from '../config.js';

const SERVICE = 'opengrok-mcp';

export function storeCredentials(
  _url: string,
  username: string,
  password: string
): void {
  try {
    const entry = new Entry(SERVICE, username);
    entry.setPassword(password);
  } catch {
    storeInEncryptedFile(username, password);
  }
}

export function retrievePassword(username: string): string | null {
  try {
    const entry = new Entry(SERVICE, username);
    return entry.getPassword();
  } catch {
    return retrieveFromEncryptedFile(username);
  }
}

export function deleteCredentials(username: string): void {
  try {
    const entry = new Entry(SERVICE, username);
    entry.deletePassword();
  } catch { /* not stored in keyring */ }
  // Also clear encrypted files
  const dir = getConfigDirectory();
  const encPath = join(dir, `cred-${username}.enc`);
  const keyPath = join(dir, `cred-${username}.key`);
  if (existsSync(encPath)) {
    try { unlinkSync(encPath); } catch { /* ignore */ }
  }
  if (existsSync(keyPath)) {
    try { unlinkSync(keyPath); } catch { /* ignore */ }
  }
}

function storeInEncryptedFile(username: string, password: string): void {
  const dir = getConfigDirectory();
  mkdirSync(dir, { recursive: true });
  const key = crypto.randomBytes(32).toString('hex');
  const encrypted = encryptWithGcm(password, key);
  writeFileSync(join(dir, `cred-${username}.enc`), encrypted, 'utf8');
  writeFileSync(join(dir, `cred-${username}.key`), key, 'utf8');
}

function retrieveFromEncryptedFile(username: string): string | null {
  const dir = getConfigDirectory();
  const encPath = join(dir, `cred-${username}.enc`);
  const keyPath = join(dir, `cred-${username}.key`);
  if (!existsSync(encPath) || !existsSync(keyPath)) return null;
  try {
    const encrypted = readFileSync(encPath, 'utf8').trim();
    const key = readFileSync(keyPath, 'utf8').trim();
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
