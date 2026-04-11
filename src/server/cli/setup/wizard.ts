import * as p from '@clack/prompts';
import { detectInstalledClients } from './detect.js';
import { configureClaudeCode, configureCodex, configureCopilotCli, readStoredEnv } from './configure.js';
import { storeCredentials, retrievePassword } from '../keychain.js';

export async function runSetup(): Promise<void> {
  p.intro('OpenGrok MCP Server Setup');

  // Load previously stored config so prompts can be pre-filled
  const stored = readStoredEnv();
  const hasStored = Boolean(stored['OPENGROK_BASE_URL']);
  if (hasStored) {
    p.log.info('Existing configuration detected — prompts pre-filled with current values.');
  }

  // --- CONNECTION ---
  const url = await p.text({
    message: 'OpenGrok server URL',
    placeholder: 'https://opengrok.company.com/source/',
    initialValue: stored['OPENGROK_BASE_URL'] ?? '',
    validate: (v) => {
      if (!v) return 'Enter a valid URL';
      try {
        const parsed = new URL(v);
        if (!['http:', 'https:'].includes(parsed.protocol)) return 'URL must use http:// or https://';
        if (parsed.protocol === 'http:') return 'Warning: HTTP sends credentials unencrypted. Use HTTPS for production.';
      } catch { return 'Enter a valid URL'; }
    },
  });
  if (p.isCancel(url)) { p.cancel('Setup cancelled'); process.exit(0); }

  const username = await p.text({
    message: 'Username (leave blank for anonymous)',
    defaultValue: stored['OPENGROK_USERNAME'] ?? '',
  });
  if (p.isCancel(username)) { p.cancel('Setup cancelled'); process.exit(0); }

  let password = '';
  if (String(username)) {
    const storedPassword = retrievePassword(String(username));
    const pwMessage = storedPassword
      ? 'Password (press Enter to keep existing)'
      : 'Password';
    const pw = await p.password({ message: pwMessage });
    if (p.isCancel(pw)) { p.cancel('Setup cancelled'); process.exit(0); }
    password = String(pw) || storedPassword || '';
  }

  const verifySsl = await p.confirm({
    message: 'Verify SSL/TLS certificates? (disable only for self-signed or internal CA certificates)',
    initialValue: stored['OPENGROK_VERIFY_SSL'] !== 'false',
  });
  if (p.isCancel(verifySsl)) { p.cancel('Setup cancelled.'); process.exit(0); }

  // --- PREFERENCES ---
  const validBudgets = ['minimal', 'standard', 'generous'];
  const storedBudget = validBudgets.includes(stored['OPENGROK_CONTEXT_BUDGET'] ?? '') ? stored['OPENGROK_CONTEXT_BUDGET'] ?? 'standard' : 'standard';
  const budget = await p.select({
    message: 'Response detail level',
    options: [
      { value: 'minimal',  label: 'Compact (4 KB) — fewer tokens, lower detail' },
      { value: 'standard', label: 'Standard (8 KB) — balanced, recommended' },
      { value: 'generous', label: 'Detailed (16 KB) — more context, more tokens' },
    ],
    initialValue: storedBudget,
  });
  if (p.isCancel(budget)) { p.cancel('Setup cancelled'); process.exit(0); }

  const codeMode = await p.confirm({
    message: 'Enable Code Mode? (sandboxed JS runtime — ~90% fewer tokens, recommended for large codebases)',
    initialValue: stored['OPENGROK_CODE_MODE'] !== 'false',
  });
  if (p.isCancel(codeMode)) { p.cancel('Setup cancelled'); process.exit(0); }

  const defaultProject = await p.text({
    message: 'Default project (leave blank to search all projects)',
    defaultValue: stored['OPENGROK_DEFAULT_PROJECT'] ?? '',
    placeholder: 'my-project',
  });
  if (p.isCancel(defaultProject)) { p.cancel('Setup cancelled'); process.exit(0); }

  const enableElicitation = await p.confirm({
    message: 'Enable Interactive AI Prompts? The AI can pause to ask questions during investigations (e.g., project selection, file disambiguation). Requires Claude Code v2.1.76+ or a client that supports MCP Elicitation',
    initialValue: stored['OPENGROK_ENABLE_ELICITATION'] === 'true',
  });
  if (p.isCancel(enableElicitation)) { p.cancel('Setup cancelled'); process.exit(0); }

  // --- ADVANCED (optional) ---
  const storedProxy = stored['HTTP_PROXY'] ?? stored['HTTPS_PROXY'] ?? '';
  const storedApiVersion = stored['OPENGROK_API_VERSION'] ?? 'v1';
  const storedResponseFormat = stored['OPENGROK_RESPONSE_FORMAT_OVERRIDE'] ?? '';
  const storedMemoryBankDir = stored['OPENGROK_MEMORY_BANK_DIR'] ?? '';
  const storedCompileDbPaths = stored['OPENGROK_LOCAL_COMPILE_DB_PATHS'] ?? '';
  const storedEnableFilesApi = stored['OPENGROK_ENABLE_FILES_API'] === 'true';
  const storedEnableSampling = stored['OPENGROK_ENABLE_SAMPLING'] === 'true';
  const storedSamplingModel = stored['OPENGROK_SAMPLING_MODEL'] ?? '';
  const storedSamplingMaxTokens = stored['OPENGROK_SAMPLING_MAX_TOKENS'] ?? '256';
  const storedAuditLogFile = stored['OPENGROK_AUDIT_LOG_FILE'] ?? '';
  const storedRateLimitRpm = stored['OPENGROK_RATELIMIT_RPM'] ?? '60';
  const storedTimeout = stored['OPENGROK_TIMEOUT'] ?? '30';
  const storedDefaultMaxResults = stored['OPENGROK_DEFAULT_MAX_RESULTS'] ?? '25';
  const storedEnableObservationMasker = stored['OPENGROK_ENABLE_OBSERVATION_MASKER'] === 'true';
  const storedObservationMaskerTurns = stored['OPENGROK_OBSERVATION_MASKER_TURNS'] ?? '10';

  const hasStoredAdvanced = storedProxy || storedApiVersion !== 'v1' || storedResponseFormat ||
    storedMemoryBankDir || storedCompileDbPaths || storedEnableFilesApi || storedEnableSampling ||
    storedSamplingModel || storedSamplingMaxTokens !== '256' || storedAuditLogFile ||
    storedRateLimitRpm !== '60' || storedTimeout !== '30' || storedDefaultMaxResults !== '25' ||
    storedEnableObservationMasker || storedObservationMaskerTurns !== '10';

  const wantsAdvanced = await p.confirm({
    message: 'Configure advanced settings? (proxy, API version, response format, memory bank, audit log, rate limit)',
    initialValue: Boolean(hasStoredAdvanced),
  });
  if (p.isCancel(wantsAdvanced)) { p.cancel('Setup cancelled'); process.exit(0); }

  let proxy = storedProxy;
  let apiVersion = storedApiVersion;
  let responseFormatOverride = storedResponseFormat;
  let memoryBankDir = storedMemoryBankDir;
  let compileDbPaths = storedCompileDbPaths;
  let enableFilesApi = storedEnableFilesApi;
  let enableSampling = storedEnableSampling;
  let samplingModel = storedSamplingModel;
  let samplingMaxTokens = storedSamplingMaxTokens;
  let auditLogFile = storedAuditLogFile;
  let rateLimitRpm = storedRateLimitRpm;
  let timeout = storedTimeout;
  let defaultMaxResults = storedDefaultMaxResults;
  let enableObservationMasker = storedEnableObservationMasker;
  let observationMaskerTurns = storedObservationMaskerTurns;

  if (wantsAdvanced) {
    const proxyVal = await p.text({
      message: 'HTTP proxy URL (leave blank if none)',
      defaultValue: storedProxy,
      placeholder: 'http://proxy.company.com:8080',
    });
    if (p.isCancel(proxyVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    proxy = String(proxyVal);

    const apiVersionVal = await p.select({
      message: 'OpenGrok API version',
      options: [
        { value: 'v1', label: 'v1 — Compatible with all OpenGrok versions (default)' },
        { value: 'v2', label: 'v2 — Required for call graph features (OpenGrok 1.12+)' },
      ],
      initialValue: storedApiVersion,
    });
    if (p.isCancel(apiVersionVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    apiVersion = String(apiVersionVal);

    const validFormats = ['', 'markdown', 'json', 'tsv', 'toon', 'yaml', 'text'];
    const storedFormat = validFormats.includes(storedResponseFormat) ? storedResponseFormat : '';
    const responseFormat = await p.select({
      message: 'AI response format override',
      options: [
        { value: '',         label: 'Auto — each tool picks the best format (recommended)' },
        { value: 'markdown', label: 'Markdown — verbose but readable' },
        { value: 'json',     label: 'JSON — programmatic use' },
        { value: 'tsv',      label: 'TSV — compact tabular' },
        { value: 'toon',     label: 'TOON — token-optimized notation' },
        { value: 'yaml',     label: 'YAML — hierarchical data' },
        { value: 'text',     label: 'Text — raw code, no framing' },
      ],
      initialValue: storedFormat,
    });
    if (p.isCancel(responseFormat)) { p.cancel('Setup cancelled'); process.exit(0); }
    responseFormatOverride = String(responseFormat);

    const memoryBankVal = await p.text({
      message: 'Investigation notes directory (leave blank for default: ~/.config/opengrok-mcp/memory-bank/)',
      defaultValue: storedMemoryBankDir,
    });
    if (p.isCancel(memoryBankVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    memoryBankDir = String(memoryBankVal);

    const compileDbVal = await p.text({
      message: 'C/C++ compile commands paths (comma-separated paths to compile_commands.json, blank = auto)',
      defaultValue: storedCompileDbPaths,
    });
    if (p.isCancel(compileDbVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    compileDbPaths = String(compileDbVal);

    const enableFilesApiVal = await p.confirm({
      message: 'Enable Files API cache? (avoids re-uploading unchanged investigation notes to the AI)',
      initialValue: storedEnableFilesApi,
    });
    if (p.isCancel(enableFilesApiVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    enableFilesApi = Boolean(enableFilesApiVal);

    const enableSamplingVal = await p.confirm({
      message: 'Enable AI Sampling? (server requests LLM completions for error explanations and summaries — disable to avoid consuming premium requests in GitHub Copilot)',
      initialValue: storedEnableSampling,
    });
    if (p.isCancel(enableSamplingVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    enableSampling = Boolean(enableSamplingVal);

    const samplingModelVal = await p.text({
      message: 'AI sampling model (leave blank for client default)',
      defaultValue: storedSamplingModel,
    });
    if (p.isCancel(samplingModelVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    samplingModel = String(samplingModelVal);

    const samplingMaxTokensVal = await p.text({
      message: 'AI sampling token budget (default: 256, range: 64–4096)',
      initialValue: storedSamplingMaxTokens,
      validate: (v) => {
        const n = parseInt(v ?? '', 10);
        if (isNaN(n) || n < 64 || n > 4096) return 'Enter a number between 64 and 4096';
      },
    });
    if (p.isCancel(samplingMaxTokensVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    samplingMaxTokens = String(samplingMaxTokensVal);

    const auditLogFileVal = await p.text({
      message: 'Audit log file path (leave blank to disable)',
      defaultValue: storedAuditLogFile,
    });
    if (p.isCancel(auditLogFileVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    auditLogFile = String(auditLogFileVal);

    const rateLimitRpmVal = await p.text({
      message: 'Request rate limit in RPM (default: 60)',
      initialValue: storedRateLimitRpm,
      validate: (v) => {
        const n = parseInt(v ?? '', 10);
        if (isNaN(n) || n < 1) return 'Enter a positive integer';
      },
    });
    if (p.isCancel(rateLimitRpmVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    rateLimitRpm = String(rateLimitRpmVal);

    const timeoutVal = await p.text({
      message: 'Request timeout in seconds (default: 30)',
      initialValue: storedTimeout,
      validate: (v) => {
        const n = parseInt(v ?? '', 10);
        if (isNaN(n) || n < 1) return 'Enter a positive integer';
      },
    });
    if (p.isCancel(timeoutVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    timeout = String(timeoutVal);

    const defaultMaxResultsVal = await p.text({
      message: 'Default max results per search (default: 25)',
      initialValue: storedDefaultMaxResults,
      validate: (v) => {
        const n = parseInt(v ?? '', 10);
        if (isNaN(n) || n < 1) return 'Enter a positive integer';
      },
    });
    if (p.isCancel(defaultMaxResultsVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    defaultMaxResults = String(defaultMaxResultsVal);

    const enableObservationMaskerVal = await p.confirm({
      message: 'Enable Observation Masker? (prepend compact history summaries to results after N turns — only useful for clients that truncate context; no benefit for Claude Code or Cursor)',
      initialValue: storedEnableObservationMasker,
    });
    if (p.isCancel(enableObservationMaskerVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    enableObservationMasker = Boolean(enableObservationMaskerVal);

    const observationMaskerTurnsVal = await p.text({
      message: 'Observation Masker — full-text window size (how many recent results to keep in full, default: 10)',
      initialValue: storedObservationMaskerTurns,
      validate: (v) => {
        const n = parseInt(v ?? '', 10);
        if (isNaN(n) || n < 1) return 'Enter a positive integer';
      },
    });
    if (p.isCancel(observationMaskerTurnsVal)) { p.cancel('Setup cancelled'); process.exit(0); }
    observationMaskerTurns = String(observationMaskerTurnsVal);
  }

  // --- STORE CREDENTIALS ---
  if (String(username) && password) {
    storeCredentials(String(url), String(username), password);
    p.log.success('Credentials stored in OS keychain');
  }

  // --- CONFIGURE MCP CLIENTS ---
  const clients = detectInstalledClients();
  const mcpConfig = {
    url: String(url),
    username: String(username),
    verifySsl: Boolean(verifySsl),
    contextBudget: String(budget),
    codeMode: Boolean(codeMode),
    defaultProject: String(defaultProject),
    enableElicitation: Boolean(enableElicitation),
    proxy,
    apiVersion,
    responseFormatOverride,
    memoryBankDir,
    compileDbPaths,
    enableFilesApi,
    enableSampling,
    samplingModel,
    samplingMaxTokens,
    auditLogFile,
    rateLimitRpm,
    timeout,
    defaultMaxResults,
    enableObservationMasker,
    observationMaskerTurns,
  };

  const spin = p.spinner();

  if (clients.claudeCode) {
    spin.start('Configuring Claude Code CLI...');
    try {
      configureClaudeCode(mcpConfig);
      spin.stop('Claude Code CLI configured \u2713');
    } catch (e) {
      spin.stop(`Claude Code CLI: ${(e as Error).message}`);
    }
  }

  if (clients.codex) {
    spin.start('Configuring Codex CLI...');
    try {
      configureCodex(mcpConfig);
      spin.stop('Codex CLI configured \u2713');
    } catch (e) {
      spin.stop(`Codex CLI: ${(e as Error).message}`);
    }
  }

  if (clients.copilotCli) {
    spin.start('Configuring GitHub Copilot CLI...');
    try {
      configureCopilotCli(mcpConfig);
      spin.stop('GitHub Copilot CLI configured \u2713');
    } catch (e) {
      spin.stop(`GitHub Copilot CLI: ${(e as Error).message}`);
    }
  }

  if (!clients.claudeCode && !clients.codex && !clients.copilotCli) {
    p.log.warn('No supported MCP clients detected. Install Claude Code CLI, GitHub Copilot CLI, or Codex CLI and re-run setup.');
  }

  p.outro('Setup complete! Run `opengrok-mcp status` to verify the connection.');
}
