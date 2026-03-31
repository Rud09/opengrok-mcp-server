import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';

// ─────────────────────────────────────────────────────────────────────────────
// Shared mock state for @napi-rs/keyring
// ─────────────────────────────────────────────────────────────────────────────

const keyringMocks = vi.hoisted(() => ({
  shouldThrow: false,
  storedPasswords: new Map<string, string>(),
}));

vi.mock('@napi-rs/keyring', () => {
  class Entry {
    private username: string;
    constructor(_service: string, username: string) {
      this.username = username;
    }
    setPassword(password: string): void {
      if (keyringMocks.shouldThrow) throw new Error('no keyring');
      keyringMocks.storedPasswords.set(this.username, password);
    }
    getPassword(): string | null {
      if (keyringMocks.shouldThrow) throw new Error('no keyring');
      return keyringMocks.storedPasswords.get(this.username) ?? null;
    }
    deletePassword(): boolean {
      if (keyringMocks.shouldThrow) throw new Error('no keyring');
      return keyringMocks.storedPasswords.delete(this.username);
    }
  }
  return { Entry };
});

vi.mock('../../server/config.js', () => ({
  getConfigDirectory: () => os.tmpdir(),
}));

// ─────────────────────────────────────────────────────────────────────────────

describe('keychain store/retrieve via keyring', () => {
  beforeEach(() => {
    keyringMocks.shouldThrow = false;
    keyringMocks.storedPasswords.clear();
  });

  it('stores and retrieves via keyring Entry', async () => {
    const { storeCredentials, retrievePassword } = await import('../../server/cli/keychain.js');
    await storeCredentials('https://og.example.com', 'admin', 'my-secret');
    const result = await retrievePassword('admin');
    expect(result).toBe('my-secret');
  });

  it('falls back to encrypted file when keyring Entry throws on setPassword', async () => {
    keyringMocks.shouldThrow = true;
    const { storeCredentials, retrievePassword } = await import('../../server/cli/keychain.js');
    const uniqueUser = 'testuser-fallback-' + Date.now();
    await storeCredentials('https://og.example.com', uniqueUser, 'fallback-pass');
    const result = await retrievePassword(uniqueUser);
    expect(result).toBe('fallback-pass');
  });

  it('returns null when neither keyring nor file has credentials', async () => {
    keyringMocks.shouldThrow = true;
    const { retrievePassword } = await import('../../server/cli/keychain.js');
    // Use a unique username that has no stored file
    const result = await retrievePassword('nonexistent-user-xyz-' + Date.now());
    expect(result).toBeNull();
  });

  it('deleteCredentials removes keyring entry', async () => {
    keyringMocks.shouldThrow = false;
    const { storeCredentials, deleteCredentials, retrievePassword } = await import('../../server/cli/keychain.js');
    await storeCredentials('https://og.example.com', 'admin2', 'pass123');
    await deleteCredentials('admin2');
    // After deletion, keyring no longer has it
    expect(keyringMocks.storedPasswords.has('admin2')).toBe(false);
    // retrievePassword returns null (keyring miss + no file)
    const result = await retrievePassword('admin2');
    expect(result).toBeNull();
  });
});

describe('keychain encryption roundtrip via file fallback', () => {
  beforeEach(() => {
    keyringMocks.shouldThrow = true;
    keyringMocks.storedPasswords.clear();
  });

  it('encrypts and decrypts a password correctly via AES-GCM file fallback', async () => {
    const { storeCredentials, retrievePassword } = await import('../../server/cli/keychain.js');
    const uniqueUser = 'enctest-' + Date.now();
    const secretPassword = 'super-secret-password-123!@#';

    await storeCredentials('https://og.example.com', uniqueUser, secretPassword);
    const retrieved = await retrievePassword(uniqueUser);
    expect(retrieved).toBe(secretPassword);
  });

  it('returns null for corrupted encrypted file', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const dir = os.tmpdir();
    const uniqueUser = 'corrupttest-' + Date.now();
    // Write corrupted data directly
    fs.writeFileSync(path.join(dir, `cred-${uniqueUser}.enc`), 'gcm:notbase64!!!', 'utf8');
    fs.writeFileSync(path.join(dir, `cred-${uniqueUser}.key`), 'a'.repeat(64), 'utf8');

    const { retrievePassword } = await import('../../server/cli/keychain.js');
    const result = await retrievePassword(uniqueUser);
    expect(result).toBeNull();
  });
});
