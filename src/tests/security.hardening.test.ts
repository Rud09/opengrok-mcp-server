import { describe, it, expect } from 'vitest';
import { buildSafeUrl, isPrivateIp } from '../server/client.js';

describe('buildSafeUrl SSRF protection', () => {
  const base = new URL('https://opengrok.company.com/source/');

  it('allows legitimate host', () => {
    expect(() => buildSafeUrl(base, 'api', 'v1', 'projects')).not.toThrow();
  });

  it('blocks hostname mismatch', () => {
    expect(() => buildSafeUrl(base, '//evil.com/steal')).toThrow(/SSRF/);
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
});
