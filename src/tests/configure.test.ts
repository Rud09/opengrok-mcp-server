import { describe, it, expect } from 'vitest';
import { buildEnv } from '../server/cli/setup/configure.js';
import type { McpConfig } from '../server/cli/setup/configure.js';

describe('buildEnv()', () => {
  it('sets OPENGROK_BASE_URL always', () => {
    const env = buildEnv({ url: 'https://og.example.com/' });
    expect(env['OPENGROK_BASE_URL']).toBe('https://og.example.com/');
  });

  it('omits OPENGROK_ENABLE_FILES_API when false (default)', () => {
    const env = buildEnv({ url: 'https://og.example.com/', enableFilesApi: false });
    expect(env).not.toHaveProperty('OPENGROK_ENABLE_FILES_API');
  });

  it('sets OPENGROK_ENABLE_FILES_API=true when true', () => {
    const env = buildEnv({ url: 'https://og.example.com/', enableFilesApi: true });
    expect(env['OPENGROK_ENABLE_FILES_API']).toBe('true');
  });

  it('sets OPENGROK_SAMPLING_MODEL when provided', () => {
    const env = buildEnv({ url: 'https://og.example.com/', samplingModel: 'claude-sonnet-4-6' });
    expect(env['OPENGROK_SAMPLING_MODEL']).toBe('claude-sonnet-4-6');
  });

  it('omits OPENGROK_SAMPLING_MODEL when blank', () => {
    const env = buildEnv({ url: 'https://og.example.com/', samplingModel: '' });
    expect(env).not.toHaveProperty('OPENGROK_SAMPLING_MODEL');
  });

  it('omits OPENGROK_SAMPLING_MAX_TOKENS at default value 256', () => {
    const env = buildEnv({ url: 'https://og.example.com/', samplingMaxTokens: '256' });
    expect(env).not.toHaveProperty('OPENGROK_SAMPLING_MAX_TOKENS');
  });

  it('sets OPENGROK_SAMPLING_MAX_TOKENS when non-default', () => {
    const env = buildEnv({ url: 'https://og.example.com/', samplingMaxTokens: '512' });
    expect(env['OPENGROK_SAMPLING_MAX_TOKENS']).toBe('512');
  });

  it('sets OPENGROK_AUDIT_LOG_FILE when provided', () => {
    const env = buildEnv({ url: 'https://og.example.com/', auditLogFile: '/var/log/audit.json' });
    expect(env['OPENGROK_AUDIT_LOG_FILE']).toBe('/var/log/audit.json');
  });

  it('omits OPENGROK_RATELIMIT_RPM at default value 60', () => {
    const env = buildEnv({ url: 'https://og.example.com/', rateLimitRpm: '60' });
    expect(env).not.toHaveProperty('OPENGROK_RATELIMIT_RPM');
  });

  it('sets OPENGROK_RATELIMIT_RPM when non-default', () => {
    const env = buildEnv({ url: 'https://og.example.com/', rateLimitRpm: '30' });
    expect(env['OPENGROK_RATELIMIT_RPM']).toBe('30');
  });

  it('compile-time: McpConfig accepts all new fields', () => {
    const config: McpConfig = {
      url: 'https://og.example.com/',
      enableFilesApi: true,
      samplingModel: 'claude-haiku-4-5-20251001',
      samplingMaxTokens: '128',
      auditLogFile: '/tmp/audit.csv',
      rateLimitRpm: '120',
    };
    expect(config.url).toBeTruthy();
  });
});
