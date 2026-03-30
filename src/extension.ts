import * as vscode from 'vscode';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';

// Credential files older than this are considered stale and will be cleaned up
const CREDENTIAL_FILE_MAX_AGE_MS = 60000; // 60 seconds

// Global state keys
const SETUP_PROMPTED_KEY = 'opengrok.setupPrompted.v2';

// Auto-update check
const GITHUB_REPO_OWNER = 'IcyHot09';
const GITHUB_REPO_NAME = 'opengrok-mcp-server';
const GITHUB_API_BASE = 'https://api.github.com';
const RELEASES_PAGE_URL = `https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases`;
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let secretStorage: vscode.SecretStorage;
let mcpProvider: OpenGrokMcpProvider | undefined;

// Tracks if the extension was activated without credentials, requiring a window reload to populate tools

/**
 * Clean up stale credential files from temp directory.
 * Files older than CREDENTIAL_FILE_MAX_AGE_MS are deleted.
 * This handles cases where the server crashed before reading the file.
 */
function cleanupStaleCredentialFiles(): void {
    try {
        const tempDir = os.tmpdir();
        const files = fs.readdirSync(tempDir);
        const now = Date.now();
        
        for (const file of files) {
            if (file.startsWith('opengrok-cred-') && file.endsWith('.tmp')) {
                const filepath = path.join(tempDir, file);
                try {
                    const stat = fs.statSync(filepath);
                    const ageMs = now - stat.mtimeMs;
                    
                    if (ageMs > CREDENTIAL_FILE_MAX_AGE_MS) {
                        fs.unlinkSync(filepath);
                        log(`Cleaned up stale credential file (${Math.round(ageMs / 1000)}s old): ${filepath}`);
                    }
                } catch {
                    // File might have been deleted by server, ignore
                }
            }
        }
    } catch (err) {
        log(`Warning: Failed to clean up stale credential files: ${err}`);
    }
}

/**
 * Clean up ALL credential files (used on extension deactivation)
 */
function cleanupAllCredentialFiles(): void {
    try {
        const tempDir = os.tmpdir();
        const files = fs.readdirSync(tempDir);
        
        for (const file of files) {
            if (file.startsWith('opengrok-cred-') && file.endsWith('.tmp')) {
                const filepath = path.join(tempDir, file);
                try {
                    fs.unlinkSync(filepath);
                    log(`Credential file cleaned up: ${filepath}`);
                } catch {
                    // Ignore errors during cleanup
                }
            }
        }
    } catch (err) {
        log(`Warning: Failed to clean up credential files: ${err}`);
    }
}

/**
 * Get the current extension version from package.json
 */
function getExtensionVersion(): string {
    const ext = vscode.extensions.getExtension('IcyHot09.opengrok-mcp-server');
    return ext?.packageJSON.version || '0.0.0';
}

/**
 * Signal VS Code to re-query our MCP provider for updated server definitions.
 * This uses the official onDidChangeMcpServerDefinitions event API.
 */
function notifyMcpServerChanged(): void {
    if (mcpProvider) {
        mcpProvider.fireChanged();
        log('Notified VS Code of MCP server definition change.');
    }
}

/**
 * Check for version updates and notify user
 */
async function checkVersionUpdate(context: vscode.ExtensionContext): Promise<void> {
    const currentVersion = getExtensionVersion();
    const previousVersion = context.globalState.get<string>('extensionVersion');

    // Save current version first — must happen before any await that might
    // trigger a reload, otherwise the notification reappears on every reload.
    await context.globalState.update('extensionVersion', currentVersion);

    if (previousVersion && previousVersion !== currentVersion) {
        // Version has been updated
        log(`Extension updated: ${previousVersion} → ${currentVersion}`);

        const action = await vscode.window.showInformationMessage(
            `OpenGrok MCP updated to v${currentVersion}! To use the latest features in Copilot Chat, please reload the window, then enable OpenGrok in the 🔧 Tools menu.`,
            'Reload Window',
            'View Changelog',
            'Later'
        );

        if (action === 'Reload Window') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        } else if (action === 'View Changelog') {
            vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/blob/main/CHANGELOG.md`));
        }

        // New version may have new/changed tools — notify VS Code to re-query our provider
        notifyMcpServerChanged();
    }
}

/**
 * Check GitHub Releases for a newer stable version and offer to install it.
 * No authentication needed — the repository is public.
 * In automatic mode (default) the check is throttled to once per 24 hours.
 * In manual mode (options.manual = true) the throttle is skipped and the user
 * is always told whether they are up to date.
 */
async function checkForRemoteUpdate(
    context: vscode.ExtensionContext,
    options?: { manual?: boolean }
): Promise<void> {
    const manual = options?.manual ?? false;
    const config = vscode.workspace.getConfiguration('opengrok-mcp');
    const verifySsl = config.get<boolean>('verifySsl') ?? true;

    // Throttle automatic checks to once per UPDATE_CHECK_INTERVAL_MS
    if (!manual) {
        const lastCheck = context.globalState.get<number>('lastUpdateCheck', 0);
        if (Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) {
            log('Update check skipped — checked recently.');
            return;
        }
    }

    try {
        log('Checking for extension updates...');

        const releasesUrl = new URL(
            `${GITHUB_API_BASE}/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases?per_page=5`
        );
        const headers: Record<string, string> = {
            'User-Agent': 'OpenGrok-MCP-UpdateCheck/1.0',
            'Accept': 'application/vnd.github+json',
        };

        interface GitHubRelease {
            prerelease?: boolean;
            draft?: boolean;
            tag_name?: string;
            assets?: Array<{ name?: string; browser_download_url?: string }>;
        }
        const releases = await httpGetJson(releasesUrl, headers, verifySsl) as GitHubRelease[];
        await context.globalState.update('lastUpdateCheck', Date.now());

        // Find the latest stable release (skip beta/alpha/rc/prerelease)
        let latestRelease: GitHubRelease | null = null;
        let latestVersion = '';
        for (const rel of releases) {
            if (rel.prerelease || rel.draft) { continue; }
            const tag = (rel.tag_name ?? '').replace(/^v/, '');
            if (!tag || /beta|alpha|rc/i.test(tag)) { continue; }
            if (!latestVersion || semverCompare(tag, latestVersion) > 0) {
                latestVersion = tag;
                latestRelease = rel;
            }
        }

        if (!latestVersion) {
            log('No stable version found in releases.');
            if (manual) {
                vscode.window.showInformationMessage('OpenGrok MCP: No stable release found.');
            }
            return;
        }

        const currentVersion = getExtensionVersion();
        log(`Update check: installed=${currentVersion}, latest=${latestVersion}`);

        if (semverCompare(latestVersion, currentVersion) <= 0) {
            log('Already on the latest version.');
            if (manual) {
                vscode.window.showInformationMessage(
                    `OpenGrok MCP: You are on the latest version (v${currentVersion}).`
                );
            }
            return;
        }

        if (!latestRelease) {
            log('No stable version found in releases.');
            if (manual) {
                vscode.window.showInformationMessage('OpenGrok MCP: No stable release found.');
            }
            return;
        }

        // Find .vsix asset in release assets
        const vsixAsset = latestRelease.assets?.find(
            (a) => /\.vsix$/i.test(a.name ?? '')
        );
        const vsixUrl: string | undefined = vsixAsset?.browser_download_url;
        const releaseUrl = `${RELEASES_PAGE_URL}/tag/v${latestVersion}`;

        const actions: string[] = ['View Release Notes', 'Dismiss'];
        if (vsixUrl) { actions.unshift('Install Update'); }

        const action = await vscode.window.showInformationMessage(
            `OpenGrok MCP v${latestVersion} is available (you have v${currentVersion}).`,
            ...actions
        );

        if (action === 'Install Update' && vsixUrl) {
            const tmpPath = path.join(os.tmpdir(), `opengrok-mcp-${latestVersion}.vsix`);

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Downloading OpenGrok MCP v${latestVersion}...`, cancellable: false },
                async () => {
                    await downloadToFile(new URL(vsixUrl), tmpPath, verifySsl);
                }
            );

            await vscode.commands.executeCommand(
                'workbench.extensions.installExtension',
                vscode.Uri.file(tmpPath)
            );

            try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }

            const reload = await vscode.window.showInformationMessage(
                `OpenGrok MCP updated to v${latestVersion}! Reload to activate the new version.`,
                'Reload Window'
            );
            if (reload === 'Reload Window') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        } else if (action === 'View Release Notes') {
            vscode.env.openExternal(vscode.Uri.parse(releaseUrl));
        }
    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Update check failed (non-fatal): ${errMsg}`);
        if (manual) {
            vscode.window.showWarningMessage(
                `OpenGrok MCP: Could not check for updates. ${errMsg}`
            );
        }
    }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    secretStorage = context.secrets;

    outputChannel = vscode.window.createOutputChannel('OpenGrok MCP');
    context.subscriptions.push(outputChannel);

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'opengrok-mcp.showLogs';
    context.subscriptions.push(statusBarItem);

    const currentVersion = getExtensionVersion();
    log(`OpenGrok MCP v${currentVersion} activating...`);

    // Check for version updates
    await checkVersionUpdate(context);

    context.subscriptions.push(
        vscode.commands.registerCommand('opengrok-mcp.configure', configureCredentials),
        vscode.commands.registerCommand('opengrok-mcp.configureUI', () => {
            openConfigurationPanel(context);
        }),
        vscode.commands.registerCommand('opengrok-mcp.test', testConnection),
        vscode.commands.registerCommand('opengrok-mcp.showLogs', () => outputChannel.show()),
        vscode.commands.registerCommand('opengrok-mcp.statusMenu', showStatusMenu),
        vscode.commands.registerCommand('opengrok-mcp.checkUpdate', () => checkForRemoteUpdate(context, { manual: true })),
    );

    // Re-query MCP server definition when any opengrok-mcp setting changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('opengrok-mcp')) {
                notifyMcpServerChanged();
            }
        })
    );

    // Fire-and-forget: check for remote updates (throttled to once per 24 h)
    setTimeout(() => { void checkForRemoteUpdate(context); }, 30_000);

    const config = vscode.workspace.getConfiguration('opengrok-mcp');
    const username = config.get<string>('username');

    // Register native MCP Provider for Copilot Chat
    if (vscode.lm && vscode.lm.registerMcpServerDefinitionProvider) {
        mcpProvider = new OpenGrokMcpProvider();
        context.subscriptions.push(
            vscode.lm.registerMcpServerDefinitionProvider('opengrok-mcp-server', mcpProvider)
        );
        log('Registered native MCP Server Definition Provider.');
    } else {
        log('Warning: This version of VS Code does not support native MCP Server Definition Providers. Copilot features may not work.');
    }

    if (username) {
        updateStatusBar('ready');
    } else {
        updateStatusBar('unconfigured');
        const action = await vscode.window.showInformationMessage(
            'OpenGrok MCP: To enable Copilot codebase search, please configure your OpenGrok credentials.',
            'Configure Now',
            'Later'
        );
        if (action === 'Configure Now') {
            openConfigurationPanel(context);
        } else if (!context.globalState.get<boolean>(SETUP_PROMPTED_KEY)) {
            // First time setup: open configuration automatically
            openConfigurationPanel(context);
            await context.globalState.update(SETUP_PROMPTED_KEY, true);
        }
    }

    log(`OpenGrok MCP v${currentVersion} activated`);
}

function log(message: string): void {
    outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function updateStatusBar(state: 'ready' | 'error' | 'unconfigured'): void {
    switch (state) {
        case 'ready':
            statusBarItem.text = '$(search) OpenGrok';
            statusBarItem.tooltip = 'OpenGrok MCP: Ready - Click for options';
            statusBarItem.backgroundColor = undefined;
            statusBarItem.command = 'opengrok-mcp.statusMenu';
            break;
        case 'error':
            statusBarItem.text = '$(warning) OpenGrok';
            statusBarItem.tooltip = 'OpenGrok MCP: Error - Click for options';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            statusBarItem.command = 'opengrok-mcp.statusMenu';
            break;
        case 'unconfigured':
            statusBarItem.text = '$(gear) OpenGrok';
            statusBarItem.tooltip = 'OpenGrok MCP: Not configured - Click to setup';
            statusBarItem.command = 'opengrok-mcp.configureUI';
            break;
    }
    statusBarItem.show();
}

async function showStatusMenu(): Promise<void> {
    const action = await vscode.window.showQuickPick([
        { label: '$(zap) Test Connection', detail: 'Verify connection to the OpenGrok server', command: 'opengrok-mcp.test' },
        { label: '$(settings-gear) Configuration Manager', detail: 'Open visual configuration panel', command: 'opengrok-mcp.configureUI' },
        { label: '$(gear) Quick Configure', detail: 'Update credentials via input prompts', command: 'opengrok-mcp.configure' },
        { label: '$(output) Show Server Logs', detail: 'View diagnostic logs for learning and debugging', command: 'opengrok-mcp.showLogs' },
        { label: '$(cloud-download) Check for Updates', detail: 'Check for new extension versions on GitHub', command: 'opengrok-mcp.checkUpdate' }
    ], {
        placeHolder: 'OpenGrok MCP Options'
    });

    if (action) {
        vscode.commands.executeCommand(action.command);
    }
}

async function configureCredentials(): Promise<void> {
    const config = vscode.workspace.getConfiguration('opengrok-mcp');

    const currentUrl = config.get<string>('baseUrl') || '';
    const baseUrl = await vscode.window.showInputBox({
        prompt: 'Enter OpenGrok server URL',
        value: currentUrl,
        ignoreFocusOut: true,
        validateInput: (value) => {
            try { new URL(value); return null; }
            catch { return 'Please enter a valid URL'; }
        }
    });
    if (!baseUrl) return;

    const currentUsername = config.get<string>('username') || '';
    const username = await vscode.window.showInputBox({
        prompt: 'Enter your OpenGrok username',
        value: currentUsername,
        ignoreFocusOut: true
    });
    if (!username) return;

    const password = await vscode.window.showInputBox({
        prompt: 'Enter your OpenGrok password',
        password: true,
        ignoreFocusOut: true
    });
    if (!password) return;

    await config.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
    await config.update('username', username, vscode.ConfigurationTarget.Global);

    // Store password in VS Code SecretStorage (encrypted, per-user, never in settings.json)
    await secretStorage.store(`opengrok-password-${username}`, password);
    log(`Credentials saved for user: ${username}`);

    void vscode.window.showInformationMessage(
        'OpenGrok credentials saved securely! Copilot Chat can now search your codebase.',
        'Test Connection'
    ).then(action => {
        if (action === 'Test Connection') void testConnection();
    });

    updateStatusBar('ready');
}

/**
 * Test connection using Node's https module — properly supports rejectUnauthorized
 * for internal/self-signed certificates on corporate networks.
 */
async function testConnection(silent = false): Promise<void> {
    const config = vscode.workspace.getConfiguration('opengrok-mcp');
    const username = config.get<string>('username');
    const baseUrl = config.get<string>('baseUrl');
    const verifySsl = config.get<boolean>('verifySsl') ?? true;

    if (!username) {
        if (!silent) {
            vscode.window.showErrorMessage('OpenGrok: No username configured.', 'Configure Now')
                .then(a => { if (a === 'Configure Now') vscode.commands.executeCommand('opengrok-mcp.configureUI'); });
        }
        return;
    }

    const password = await secretStorage.get(`opengrok-password-${username}`);
    if (!password) {
        if (!silent) {
            vscode.window.showErrorMessage('OpenGrok: No password found. Please configure credentials.', 'Configure Now')
                .then(a => { if (a === 'Configure Now') vscode.commands.executeCommand('opengrok-mcp.configureUI'); });
        }
        return;
    }

    const runTest = async () => {
        try {
            const targetUrl = baseUrl || '';
            const parsed = new URL(targetUrl);
            const b64 = Buffer.from(`${username}:${password}`).toString('base64');

            const statusCode = await httpGet(parsed, {
                'Authorization': `Basic ${b64}`,
                'User-Agent': 'OpenGrok-MCP/2.0.0'
            }, verifySsl);

            if (statusCode >= 200 && statusCode < 400) {
                log(`Connection test successful (HTTP ${statusCode})`);
                if (!silent) vscode.window.showInformationMessage('✓ OpenGrok connection successful!');
                updateStatusBar('ready');
            } else if (statusCode === 401) {
                log('Authentication failed (401)');
                if (!silent) vscode.window.showErrorMessage('✗ Authentication failed. Check your username and password.');
                updateStatusBar('error');
            } else {
                log(`Unexpected status: ${statusCode}`);
                if (!silent) vscode.window.showWarningMessage(`OpenGrok returned HTTP ${statusCode}`);
            }
        } catch (err: unknown) {
            const msg: string = err instanceof Error ? err.message : String(err);
            log(`Connection test failed: ${msg}`);
            if (!silent) {
                if (msg.includes('certificate') || msg.includes('self-signed') || msg.includes('CERT') || msg.includes('SSL')) {
                    vscode.window.showErrorMessage(
                        '✗ SSL certificate error. If using a self-signed/internal CA, disable SSL verification in Settings.',
                        'Open Settings'
                    ).then(a => {
                        if (a === 'Open Settings') {
                            vscode.commands.executeCommand('workbench.action.openSettings', 'opengrok-mcp.verifySsl');
                        }
                    });
                } else {
                    vscode.window.showErrorMessage(`✗ Connection failed: ${msg}`);
                }
            }
            updateStatusBar('error');
        }
    };

    if (silent) {
        await runTest();
    } else {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Testing OpenGrok connection...',
            cancellable: false
        }, runTest);
    }
}

/**
 * Perform a GET request using Node's built-in https/http module.
 * This properly supports rejectUnauthorized for internal CA certs,
 * unlike the global fetch() in VS Code's Node.js context.
 */
function httpGet(url: URL, headers: Record<string, string>, verifySsl: boolean): Promise<number> {
    return new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(
            {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'GET',
                headers,
                rejectUnauthorized: verifySsl,
                timeout: 15000,
            },
            (res: http.IncomingMessage) => {
                res.resume(); // Consume the response data to avoid memory leaks
                resolve(res.statusCode ?? 0);
            }
        );
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Perform a GET request and return the parsed JSON body.
 * Rejects if the response status is non-2xx or the body is not valid JSON.
 */
function httpGetJson(url: URL, headers: Record<string, string>, verifySsl: boolean): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(
            {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'GET',
                headers,
                rejectUnauthorized: verifySsl,
                timeout: 15000,
            },
            (res: http.IncomingMessage) => {
                const statusCode = res.statusCode ?? 0;
                if (statusCode < 200 || statusCode >= 300) {
                    res.resume();
                    reject(new Error(`HTTP ${statusCode}`));
                    return;
                }
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    } catch {
                        reject(new Error('Failed to parse JSON response'));
                    }
                });
            }
        );
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Download a URL to a local file path, following up to 5 redirects.
 */
function downloadToFile(url: URL, destPath: string, verifySsl: boolean, redirectsLeft = 5, headers: Record<string, string> = {}): Promise<void> {
    return new Promise((resolve, reject) => {
        if (redirectsLeft === 0) {
            reject(new Error('Too many redirects'));
            return;
        }
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(
            {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'GET',
                headers,
                rejectUnauthorized: verifySsl,
                timeout: 60000,
            },
            (res: http.IncomingMessage) => {
                const statusCode = res.statusCode ?? 0;
                const location = res.headers.location;
                if (statusCode >= 300 && statusCode < 400 && location) {
                    res.resume();
                    const redirectUrl = new URL(location);
                    // Block redirects to untrusted hosts or protocol downgrades
                    if (redirectUrl.hostname !== url.hostname || redirectUrl.protocol !== url.protocol) {
                        reject(new Error(`Redirect to untrusted destination blocked: ${redirectUrl.protocol}//${redirectUrl.hostname}`));
                        return;
                    }
                    downloadToFile(redirectUrl, destPath, verifySsl, redirectsLeft - 1, headers)
                        .then(resolve).catch(reject);
                    return;
                }
                if (statusCode < 200 || statusCode >= 300) {
                    res.resume();
                    reject(new Error(`HTTP ${statusCode}`));
                    return;
                }
                const out = fs.createWriteStream(destPath);
                res.pipe(out);
                out.on('finish', () => out.close(() => resolve()));
                out.on('error', reject);
            }
        );
        req.on('timeout', () => { req.destroy(); reject(new Error('Download timed out')); });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Compare two semver strings (major.minor.patch).
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
function semverCompare(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) { return diff < 0 ? -1 : 1; }
    }
    return 0;
}


class OpenGrokMcpProvider implements vscode.McpServerDefinitionProvider {
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeMcpServerDefinitions = this._onDidChange.event;

    fireChanged(): void {
        this._onDidChange.fire();
    }

    async provideMcpServerDefinitions(_token: vscode.CancellationToken): Promise<vscode.McpServerDefinition[]> {
        // Clean up stale credential files (>60 seconds old) from previous calls
        // Server should delete files immediately after reading, so stale files indicate crashed servers
        cleanupStaleCredentialFiles();

        const config = vscode.workspace.getConfiguration('opengrok-mcp');
        const username = config.get<string>('username');
        if (!username) return [];

        const password = await secretStorage.get(`opengrok-password-${username}`);
        const baseUrl = config.get<string>('baseUrl') || '';
        const verifySsl = config.get<boolean>('verifySsl') ?? false;
        const proxy = config.get<string>('proxy');

        const env: Record<string, string> = {
            OPENGROK_BASE_URL: baseUrl,
            OPENGROK_USERNAME: username,
            OPENGROK_VERIFY_SSL: verifySsl ? 'true' : 'false',
        };

        const codeMode = config.get<boolean>('codeMode') ?? true;
        const contextBudget = config.get<string>('contextBudget') ?? 'minimal';
        const memoryBankDir = config.get<string>('memoryBankDir') ?? '';

        env.OPENGROK_CODE_MODE = codeMode ? 'true' : 'false';
        env.OPENGROK_CONTEXT_BUDGET = contextBudget;
        if (memoryBankDir) {
            env.OPENGROK_MEMORY_BANK_DIR = memoryBankDir;
        } else if (vscode.workspace.workspaceFolders?.length) {
            // Default: workspace-specific memory bank
            const wsRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            env.OPENGROK_MEMORY_BANK_DIR = path.join(wsRoot, '.opengrok', 'memory-bank');
        }

        const defaultProject = config.get<string>('defaultProject') ?? '';
        const responseFormatOverride = config.get<string>('responseFormatOverride') ?? '';
        const compileDbPaths = (config.get<string>('compileDbPaths') ?? '').trim();
        if (defaultProject) env.OPENGROK_DEFAULT_PROJECT = defaultProject;
        if (responseFormatOverride) env.OPENGROK_RESPONSE_FORMAT_OVERRIDE = responseFormatOverride;

        if (password) {
            // Write credentials to secure temporary file with AES-256 encryption
            // This prevents exposure via process inspection AND file reading
            try {
                const tempDir = os.tmpdir();
                const filename = `opengrok-cred-${crypto.randomBytes(16).toString('hex')}.tmp`;
                const filepath = path.join(tempDir, filename);
                
                // Generate one-time encryption key and IV
                const encryptionKey = crypto.randomBytes(32); // AES-256
                const iv = crypto.randomBytes(16);
                
                // Encrypt the password
                const cipher = crypto.createCipheriv('aes-256-cbc', encryptionKey, iv);
                let encrypted = cipher.update(password, 'utf8', 'base64');
                encrypted += cipher.final('base64');
                
                // Write encrypted data: IV:EncryptedPassword
                const fileContent = `${iv.toString('base64')}:${encrypted}`;
                fs.writeFileSync(filepath, fileContent, { 
                    encoding: 'utf8',
                    mode: 0o600  // rw------- on Unix; on Windows, file is in user's temp dir
                });
                
                // Windows: Apply explicit ACLs for defense-in-depth
                if (process.platform === 'win32') {
                    try {
                        // Remove inherited permissions and grant full control only to current user
                        execSync(`icacls "${filepath}" /inheritance:r /grant:r "%username%:(F)" /Q`, 
                                 { windowsHide: true });
                        log('Windows ACL hardening applied to credential file');
                    } catch (aclErr) {
                        log(`Warning: Failed to apply Windows ACLs (file still protected by temp dir): ${aclErr}`);
                    }
                }
                
                env.OPENGROK_PASSWORD_FILE = filepath;
                env.OPENGROK_PASSWORD_KEY = encryptionKey.toString('base64');
                log(`Credential file created (encrypted): ${filepath}`);
                
                // Note: File will be securely deleted by the server after it reads and decrypts the password.
                // Stale files (from crashed servers) are cleaned up on next provideMcpServerDefinitions() call.
            } catch (err) {
                log(`Warning: Failed to create credential file, falling back to env variable: ${err}`);
                env.OPENGROK_PASSWORD = password;
            }
        }

        if (proxy) {
            env.HTTP_PROXY = proxy;
            env.HTTPS_PROXY = proxy;
        }

        // Local layer — user config takes precedence over auto-discovery
        if (compileDbPaths) {
            env.OPENGROK_LOCAL_COMPILE_DB_PATHS = compileDbPaths;
        } else {
            // Auto-discover compile_commands.json files in all workspace folders
            const compileDbUris = await vscode.workspace.findFiles('**/compile_commands.json');
            if (compileDbUris.length > 0) {
                env.OPENGROK_LOCAL_COMPILE_DB_PATHS = compileDbUris.map(u => u.fsPath).join(',');
            }
        }

        // Return the definition object
        // Use process.execPath to get VS Code's bundled Node.js runtime path
        // This ensures it works even when Node.js is not installed system-wide
        const def = new vscode.McpStdioServerDefinition(
            'OpenGrok',
            process.execPath,
            [getServerScriptPath()],
            env,
            `${getExtensionVersion()}-${codeMode ? 'code' : 'legacy'}-${contextBudget}`
        );
        return [def];
    }
}

function getServerScriptPath(): string {
    // The bundled server is at out/server/main.js relative to the extension root
    const ext = vscode.extensions.getExtension('IcyHot09.opengrok-mcp-server');
    if (ext) {
        return ext.extensionUri.fsPath.replace(/\\/g, '/') + '/out/server/main.js';
    }
    return 'out/server/main.js';
}

// ============================================================================
// Editor Configuration Panel (Sidebar/Beside)
// ============================================================================

let configPanel: vscode.WebviewPanel | undefined;

function openConfigurationPanel(context: vscode.ExtensionContext): void {
    if (configPanel) {
        configPanel.reveal(vscode.ViewColumn.One);
        return;
    }

    const column = vscode.window.activeTextEditor
        ? vscode.ViewColumn.Beside
        : vscode.ViewColumn.One;

    configPanel = vscode.window.createWebviewPanel(
        'opengrok-mcp.configView',
        'OpenGrok Configuration',
        column,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    configPanel.webview.html = getConfigManagerHtml(context);

    // Initial load
    void _sendCurrentConfig(configPanel.webview);

    configPanel.webview.onDidReceiveMessage(
        async (message) => {
            if (!configPanel) return;
            log(`Config webview message: ${message.type}`);
            try {
                switch (message.type) {
                    case 'getConfig':
                        await _sendCurrentConfig(configPanel.webview);
                        break;
                    case 'testConnection':
                        await _handleTestConnection(configPanel.webview, message.data);
                        break;
                    case 'saveConfiguration':
                        await _handleSaveConfiguration(configPanel.webview, message.data);
                        break;
                }
            } catch (error: unknown) {
                const errMsg = error instanceof Error ? error.message : String(error);
                log(`Error handling webview message: ${errMsg}`);
                configPanel?.webview.postMessage({ type: 'error', message: errMsg });
            }
        },
        undefined,
        context.subscriptions
    );

    configPanel.onDidDispose(
        () => {
            configPanel = undefined;
        },
        null,
        context.subscriptions
    );
}

async function _sendCurrentConfig(webview: vscode.Webview): Promise<void> {
    const config = vscode.workspace.getConfiguration('opengrok-mcp');
    const username = config.get<string>('username') || '';
    const baseUrl = config.get<string>('baseUrl') || '';
    const verifySsl = config.get<boolean>('verifySsl') ?? true;
    const proxy = config.get<string>('proxy') || '';
    const defaultProject = config.get<string>('defaultProject') || '';
    const contextBudget = config.get<string>('contextBudget') || 'minimal';
    const responseFormatOverride = config.get<string>('responseFormatOverride') || '';
    const codeMode = config.get<boolean>('codeMode') ?? true;
    const memoryBankDir = config.get<string>('memoryBankDir') || '';
    const compileDbPaths = config.get<string>('compileDbPaths') || '';
    const apiVersion = config.get<string>('apiVersion') || 'v1';

    let hasPassword = false;
    if (username) {
        const password = await secretStorage.get(`opengrok-password-${username}`);
        hasPassword = !!password;
    }

    webview.postMessage({
        type: 'loadConfig',
        config: { baseUrl, username, verifySsl, proxy, hasPassword, defaultProject, contextBudget, responseFormatOverride, codeMode, memoryBankDir, compileDbPaths, apiVersion }
    });
}

async function _handleTestConnection(webview: vscode.Webview, data: { baseUrl: string; username: string; password: string; verifySsl: boolean; proxy?: string }): Promise<void> {
    // Read apiVersion from VS Code settings to match the actual client configuration
    const apiVersion = vscode.workspace.getConfiguration('opengrok-mcp').get<string>('apiVersion') || 'v1';
    await handleWebviewTestConnection(
        (msg: Record<string, unknown>) => { void webview.postMessage(msg); },
        { ...data, apiVersion }
    );
}

async function _handleSaveConfiguration(webview: vscode.Webview, data: {
    baseUrl: string;
    username: string;
    password?: string;
    proxy?: string;
    verifySsl: boolean;
    defaultProject?: string;
    contextBudget?: string;
    responseFormatOverride?: string;
    codeMode?: boolean;
    memoryBankDir?: string;
    compileDbPaths?: string;
    codeModeChanged?: boolean;
    apiVersion?: string;
}): Promise<void> {
    await handleSaveConfiguration(
        (msg: Record<string, unknown>) => { void webview.postMessage(msg); },
        data
    );
}

async function handleWebviewTestConnection(
    postMessage: (msg: Record<string, unknown>) => void,
    data: { baseUrl: string; username: string; password: string; verifySsl: boolean; proxy?: string; apiVersion?: string }
): Promise<void> {
    const { baseUrl, username, password, verifySsl, proxy, apiVersion = 'v1' } = data;

    postMessage({ type: 'testing', message: 'Testing connection...' });

    try {
        const parsed = new URL(baseUrl);
        const base = parsed.href.replace(/\/+$/, '');
        // Use the configured API version — hardcoding v1 fails when server uses v2
        const apiUrl = new URL(`${base}/api/${apiVersion}/projects`);
        const b64 = Buffer.from(`${username}:${password}`).toString('base64');

        await new Promise<void>((resolve, reject) => {
            const makeRequest = (targetUrl: URL, proxyUrl?: URL): void => {
                const isHttps = targetUrl.protocol === 'https:';
                const protocol = isHttps ? https : http;

                // Proxy-aware request options
                // Use a wide type to accommodate both http and https-specific options
                let options: http.RequestOptions & { rejectUnauthorized?: boolean };
                if (proxyUrl) {
                    if (isHttps) {
                        // HTTPS target via proxy: use CONNECT tunnel
                        const connectReq = http.request({
                            hostname: proxyUrl.hostname,
                            port: Number(proxyUrl.port) || 8080,
                            method: 'CONNECT',
                            path: `${targetUrl.hostname}:${Number(targetUrl.port) || 443}`,
                        });
                        connectReq.on('connect', (_res, socket) => {
                            // socket comes from the CONNECT tunnel — cast is required since Node.js
                            // typings don't expose the `socket` injection option in RequestOptions
                            const tunnelOpts = {
                                hostname: targetUrl.hostname,
                                port: Number(targetUrl.port) || 443,
                                path: targetUrl.pathname + targetUrl.search,
                                method: 'GET',
                                headers: { 'Authorization': `Basic ${b64}`, 'Accept': 'application/json' },
                                rejectUnauthorized: verifySsl,
                                socket,
                            };
                            const tunnelReq = https.request(
                                tunnelOpts as unknown as https.RequestOptions,
                                handleResponse
                            );
                            tunnelReq.on('error', (err: Error) => reject(err));
                            tunnelReq.end();
                        });
                        connectReq.on('error', (err: Error) => reject(err));
                        connectReq.end();
                        return;
                    } else {
                        // HTTP target via proxy: use absolute URL as path
                        options = {
                            hostname: proxyUrl.hostname,
                            port: Number(proxyUrl.port) || 8080,
                            path: targetUrl.href,
                            method: 'GET',
                            headers: { 'Authorization': `Basic ${b64}`, 'Accept': 'application/json' },
                        };
                    }
                } else {
                    options = {
                        hostname: targetUrl.hostname,
                        port: targetUrl.port || (isHttps ? 443 : 80),
                        path: targetUrl.pathname + targetUrl.search,
                        method: 'GET',
                        headers: { 'Authorization': `Basic ${b64}`, 'Accept': 'application/json' },
                        rejectUnauthorized: verifySsl,
                    };
                }

                const req = protocol.request(options, handleResponse);
                req.on('error', (err: Error) => reject(err));
                req.setTimeout(10000, () => {
                    req.destroy();
                    reject(new Error('Connection timed out'));
                });
                req.end();
            };

            const handleResponse = (res: http.IncomingMessage): void => {
                let body = '';
                res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                res.on('end', () => {
                    if (res.statusCode === 401) {
                        reject(new Error('Authentication failed (401). Check username/password.'));
                    } else if (res.statusCode === 403) {
                        reject(new Error('Access denied (403). Check credentials or server permissions.'));
                    } else if (!res.statusCode || res.statusCode >= 400) {
                        reject(new Error(`Server returned status ${res.statusCode} — is this an OpenGrok server?`));
                    } else {
                        try {
                            const json = JSON.parse(body);
                            // Accept both array (API v1) and object (API v2) responses
                            const isValid = Array.isArray(json) || (typeof json === 'object' && json !== null);
                            if (!isValid) {
                                reject(new Error('Unexpected response format — is this an OpenGrok server?'));
                            } else {
                                resolve();
                            }
                        } catch {
                            reject(new Error('Response is not JSON — is this an OpenGrok server?'));
                        }
                    }
                });
            };

            const proxyUrl = proxy ? (() => { try { return new URL(proxy); } catch { return undefined; } })() : undefined;
            makeRequest(apiUrl, proxyUrl);
        });

        log('✓ Webview test connection successful');
        postMessage({ type: 'testSuccess', message: '✓ Connection successful!' });
    } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log(`✗ Webview test connection failed: ${errMsg}`);
        postMessage({ type: 'error', message: `✗ Connection failed: ${errMsg}` });
    }
}

async function handleSaveConfiguration(
    postMessage: (msg: Record<string, unknown>) => void,
    data: {
        baseUrl: string;
        username: string;
        password?: string;
        proxy?: string;
        verifySsl: boolean;
        defaultProject?: string;
        contextBudget?: string;
        responseFormatOverride?: string;
        codeMode?: boolean;
        memoryBankDir?: string;
        compileDbPaths?: string;
        codeModeChanged?: boolean;
        apiVersion?: string;
    }
): Promise<void> {
    const { baseUrl, username, password, proxy, verifySsl, defaultProject, contextBudget, responseFormatOverride, codeMode, memoryBankDir, compileDbPaths, codeModeChanged, apiVersion } = data;

    const config = vscode.workspace.getConfiguration('opengrok-mcp');
    const oldUsername = config.get<string>('username');

    let finalPassword = password;
    if (!finalPassword && oldUsername) {
        finalPassword = await secretStorage.get(`opengrok-password-${oldUsername}`);
    }

    if (!finalPassword) {
        postMessage({ type: 'error', message: 'Password is required' });
        return;
    }

    await config.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
    await config.update('username', username, vscode.ConfigurationTarget.Global);
    await config.update('verifySsl', verifySsl, vscode.ConfigurationTarget.Global);
    await config.update('proxy', proxy || undefined, vscode.ConfigurationTarget.Global);
    if (defaultProject !== undefined) await config.update('defaultProject', defaultProject || undefined, vscode.ConfigurationTarget.Global);
    if (contextBudget) await config.update('contextBudget', contextBudget, vscode.ConfigurationTarget.Global);
    if (responseFormatOverride !== undefined) await config.update('responseFormatOverride', responseFormatOverride || undefined, vscode.ConfigurationTarget.Global);
    if (codeMode !== undefined) await config.update('codeMode', codeMode, vscode.ConfigurationTarget.Global);
    if (memoryBankDir !== undefined) await config.update('memoryBankDir', memoryBankDir || undefined, vscode.ConfigurationTarget.Global);
    if (compileDbPaths !== undefined) await config.update('compileDbPaths', compileDbPaths || undefined, vscode.ConfigurationTarget.Global);
    if (apiVersion !== undefined) await config.update('apiVersion', apiVersion || 'v1', vscode.ConfigurationTarget.Global);

    await secretStorage.store(`opengrok-password-${username}`, finalPassword);

    if (oldUsername && oldUsername !== username) {
        await secretStorage.delete(`opengrok-password-${oldUsername}`);
    }

    log(`Configuration saved for user: ${username}`);
    updateStatusBar('ready');
    notifyMcpServerChanged();

    const saveMsg = codeModeChanged
        ? 'Configuration saved! Code Mode is toggling — tools will refresh in 5–10 sec.'
        : 'Configuration saved! Tools are refreshing.';
    postMessage({ type: 'success', message: saveMsg });
    setTimeout(() => { void testConnection(true); }, 1000);
}

function getConfigManagerHtml(context: vscode.ExtensionContext): string {
    try {
        const htmlPath = path.join(context.extensionPath, 'out', 'webview', 'configManager.html');
        if (fs.existsSync(htmlPath)) {
            return fs.readFileSync(htmlPath, 'utf8');
        }
    } catch (err) {
        log(`Warning: Could not load external HTML: ${err}`);
    }
    return '<html><body><p>Configuration panel unavailable. Please reinstall the extension.</p></body></html>';
}

export function deactivate(): void {
    cleanupAllCredentialFiles();
    log('OpenGrok MCP extension deactivated');
}
