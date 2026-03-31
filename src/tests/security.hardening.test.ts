import { describe, it, expect } from 'vitest';
import { buildSafeUrl, isPrivateIp, assertSafePath } from '../server/client.js';

describe('buildSafeUrl SSRF protection', () => {
  const base = new URL('https://opengrok.company.com/source/');

  it('allows legitimate host', () => {
    expect(() => buildSafeUrl(base, 'api', 'v1', 'projects')).not.toThrow();
  });

  it('blocks hostname mismatch', () => {
    expect(() => buildSafeUrl(base, '//evil.com/steal')).toThrow(/SSRF/);
  });

  it('blocks buildSafeUrl with private IP base URL', () => {
    const privateBase = new URL('http://127.0.0.1:8080/');
    expect(() => buildSafeUrl(privateBase, 'api')).toThrow(/SSRF/);
  });
});

describe('isPrivateIp', () => {
  it('blocks IPv6-mapped loopback ::ffff:127.0.0.1', () => {
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
  });

  it('blocks IPv6-mapped private ::ffff:10.0.0.1', () => {
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
  });

  it('blocks direct 127.0.0.1', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
  });

  it('blocks RFC1918 10.x.x.x', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
  });

  it('blocks RFC1918 172.16.x.x', () => {
    expect(isPrivateIp('172.16.0.1')).toBe(true);
  });

  it('blocks RFC1918 192.168.x.x', () => {
    expect(isPrivateIp('192.168.1.1')).toBe(true);
  });

  it('blocks link-local 169.254.x.x', () => {
    expect(isPrivateIp('169.254.169.254')).toBe(true);
  });

  it('blocks localhost string', () => {
    expect(isPrivateIp('localhost')).toBe(true);
  });

  it('allows public IP', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
  });

  it('allows 0.0.0.0 as private (non-routable)', () => {
    expect(isPrivateIp('0.0.0.0')).toBe(true);
  });

  it('blocks IPv6 loopback ::1', () => {
    expect(isPrivateIp('::1')).toBe(true);
  });

  it('blocks IPv6 unspecified ::', () => {
    expect(isPrivateIp('::')).toBe(true);
  });

  it('blocks IPv6 ULA fc00::1', () => {
    expect(isPrivateIp('fc00::1')).toBe(true);
  });

  it('blocks IPv6 ULA fd00::1', () => {
    expect(isPrivateIp('fd00::1')).toBe(true);
  });

  it('blocks IPv6 link-local fe80::1', () => {
    expect(isPrivateIp('fe80::1')).toBe(true);
  });

  it('blocks IPv6 link-local febf::1', () => {
    expect(isPrivateIp('febf::1')).toBe(true);
  });
});

describe('assertSafePath traversal protection', () => {
  it('allows normal paths', () => {
    expect(() => assertSafePath('src/main/java/Foo.java')).not.toThrow();
    expect(() => assertSafePath('/project/file.c')).not.toThrow();
  });

  it('blocks ../ literal', () => {
    expect(() => assertSafePath('../etc/passwd')).toThrow(/Unsafe/);
  });

  it('blocks /../../ embedded', () => {
    expect(() => assertSafePath('foo/../../etc/passwd')).toThrow(/Unsafe/);
  });

  it('blocks RTL override character U+202E', () => {
    expect(() => assertSafePath('file\u202e.txt')).toThrow(/Unsafe/);
  });

  it('blocks zero-width space U+200B', () => {
    expect(() => assertSafePath('file\u200b/../secret')).toThrow(/Unsafe/);
  });

  it('blocks %2e%2e encoded', () => {
    expect(() => assertSafePath('%2e%2e/etc')).toThrow(/Unsafe/);
  });

  it('blocks null byte', () => {
    expect(() => assertSafePath('file\0.txt')).toThrow(/Unsafe/);
  });

  it('blocks double-encoded %252e%252e', () => {
    expect(() => assertSafePath('%252e%252e/secret')).toThrow(/Unsafe/);
  });

  it('blocks standalone ..', () => {
    expect(() => assertSafePath('..')).toThrow(/Unsafe/);
  });

  it('blocks path ending in /..', () => {
    expect(() => assertSafePath('foo/..')).toThrow(/Unsafe/);
  });
});
