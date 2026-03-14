#Requires -Version 5.1
<#
.SYNOPSIS
  Credential wrapper for the OpenGrok MCP server.

.DESCRIPTION
  Resolves credentials from Windows Credential Manager (cmdkey) or a DPAPI-
  encrypted fallback file, sets OPENGROK_PASSWORD, then starts the server.

  Run once interactively to store credentials:
    opengrok-mcp-wrapper.ps1 --setup

  Thereafter your MCP client invokes this script silently (no args).

.PARAMETER Setup
  Run interactive credential setup.
#>

param(
  [switch]$Setup,
  [switch]$Help,
  [switch]$Version,
  [Parameter(ValueFromRemainingArguments)]
  [string[]]$PassThru
)

$ErrorActionPreference = 'Stop'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$BinaryPath = if ($env:OPENGROK_BIN) { $env:OPENGROK_BIN } else { Join-Path $ScriptDir 'opengrok-mcp' }
$ConfigDir  = if ($env:OPENGROK_CONFIG_DIR) { $env:OPENGROK_CONFIG_DIR } else {
  Join-Path $env:APPDATA 'opengrok-mcp'
}
$ConfigFile = Join-Path $ConfigDir 'config.json'
$EncFile    = Join-Path $ConfigDir 'credentials.dpapi'
$DotEnvFile = Join-Path $ConfigDir '.env'

# Credential Manager target name
$CredTarget = 'opengrok-mcp'

# ──────────────────────────────────────────────────────────────────────────────
# DPAPI helpers
# ──────────────────────────────────────────────────────────────────────────────

function Protect-Secret {
  param([string]$PlainText, [string]$OutPath)
  Add-Type -AssemblyName System.Security
  $bytes     = [System.Text.Encoding]::UTF8.GetBytes($PlainText)
  $encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
                 $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [System.IO.File]::WriteAllBytes($OutPath, $encrypted)
  # Restrict file to current user only (best-effort; FAT32 volumes may ignore)
  $acl = Get-Acl $OutPath
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $env:USERNAME, 'FullControl', 'Allow')
  $acl.SetAccessRule($rule)
  Set-Acl $OutPath $acl -ErrorAction SilentlyContinue
}

function Unprotect-Secret {
  param([string]$InPath)
  Add-Type -AssemblyName System.Security
  $encrypted = [System.IO.File]::ReadAllBytes($InPath)
  $bytes     = [System.Security.Cryptography.ProtectedData]::Unprotect(
                 $encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [System.Text.Encoding]::UTF8.GetString($bytes)
}

# ──────────────────────────────────────────────────────────────────────────────
# Credential Manager helpers  (cmdkey / native API)
# ──────────────────────────────────────────────────────────────────────────────

function Save-ToCredentialManager {
  param([string]$Username, [string]$Password)
  # Remove existing, then add (cmdkey merges, but explicit delete is cleaner)
  cmdkey /delete:"$CredTarget" 2>$null | Out-Null
  $result = cmdkey /generic:"$CredTarget" /user:"$Username" /pass:"$Password" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "cmdkey failed: $result" }
}

function Read-FromCredentialManager {
  param([string]$Username)
  # Read via Windows API (CredRead) so we get the plaintext password back.
  Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class CredentialManager {
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr credentialPtr);

  [DllImport("advapi32.dll", EntryPoint="CredFree")]
  private static extern void CredFree([In] IntPtr buffer);

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName;
    public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }

  public static string GetPassword(string target) {
    IntPtr ptr;
    if (!CredRead(target, 1 /*CRED_TYPE_GENERIC*/, 0, out ptr)) return null;
    try {
      var cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
      if (cred.CredentialBlobSize == 0) return "";
      return Encoding.Unicode.GetString(Marshal.PtrToStringUni(cred.CredentialBlob,
        (int)(cred.CredentialBlobSize / 2)).ToCharArray());
    } finally { CredFree(ptr); }
  }
}
'@ -ErrorAction SilentlyContinue
  if (-not ([System.Management.Automation.PSTypeName]'CredentialManager').Type) { return $null }
  [CredentialManager]::GetPassword($CredTarget)
}

# ──────────────────────────────────────────────────────────────────────────────
# Safe .env parser (no Invoke-Expression)
# ──────────────────────────────────────────────────────────────────────────────

function Import-DotEnv {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return }
  foreach ($line in Get-Content $Path) {
    $line = $line.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { continue }
    $idx = $line.IndexOf('=')
    if ($idx -lt 1) { continue }
    $key   = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim()
    # Only safe variable names
    if ($key -match '^[A-Za-z_][A-Za-z0-9_]*$') {
      [System.Environment]::SetEnvironmentVariable($key, $value, 'Process')
    }
  }
}

function Import-ConfigJson {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return }
  $cfg = Get-Content $Path -Raw | ConvertFrom-Json
  foreach ($prop in $cfg.PSObject.Properties) {
    if ($prop.Name -match '^[A-Za-z_][A-Za-z0-9_]*$') {
      [System.Environment]::SetEnvironmentVariable($prop.Name, $prop.Value, 'Process')
    }
  }
}

# ──────────────────────────────────────────────────────────────────────────────
# --setup mode
# ──────────────────────────────────────────────────────────────────────────────

function Start-Setup {
  Write-Host ""
  Write-Host "╔════════════════════════════════════════════╗"
  Write-Host "║   OpenGrok MCP — Credential Setup         ║"
  Write-Host "╚════════════════════════════════════════════╝"
  Write-Host ""

  $defaultUrl = "https://opengrok.example.com/source/"
  $inputUrl   = Read-Host "OpenGrok Base URL [$defaultUrl]"
  $baseUrl    = if ($inputUrl) { $inputUrl } else { $defaultUrl }

  $defaultUser = $env:USERNAME
  $inputUser   = Read-Host "Username [$defaultUser]"
  $username    = if ($inputUser) { $inputUser } else { $defaultUser }

  $password = ""
  while (-not $password) {
    $secPass  = Read-Host "Password" -AsSecureString
    $bstr     = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secPass)
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    if (-not $password) { Write-Host "Password cannot be empty. Please try again." }
  }

  $inputSsl = Read-Host "Verify SSL certificates? [Y/n]"
  $verifySsl = ($inputSsl -ne 'n' -and $inputSsl -ne 'N' -and $inputSsl -notmatch '^no$')

  Write-Host ""
  Write-Host "Testing connection..."

  $testUri    = $baseUrl.TrimEnd('/') + '/api/v1/projects'
  $httpStatus = $null
  try {
    $cred    = [System.Net.NetworkCredential]::new($username, $password)
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.Credentials = $cred
    if (-not $verifySsl) {
      $handler.ServerCertificateCustomValidationCallback = { $true }
    }
    $client  = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(10)
    $resp    = $client.GetAsync($testUri).GetAwaiter().GetResult()
    $httpStatus = [int]$resp.StatusCode
    $client.Dispose()
  } catch {
    $httpStatus = 0
  }

  switch ($httpStatus) {
    200  { Write-Host "  [OK] Connection successful (HTTP $httpStatus)" }
    201  { Write-Host "  [OK] Connection successful (HTTP $httpStatus)" }
    401  { Write-Host "  [FAIL] Authentication failed (HTTP $httpStatus). Check username and password."; exit 1 }
    403  { Write-Host "  [FAIL] Forbidden (HTTP $httpStatus). Check username and password."; exit 1 }
    0    { Write-Host "  [FAIL] Could not reach $testUri. Check the URL and your network."; exit 1 }
    default { Write-Host "  [WARN] Unexpected response (HTTP $httpStatus). Proceeding anyway." }
  }

  # ── Store in Credential Manager (primary) ───────────────────────────────
  Write-Host ""
  Write-Host "Storing credentials..."

  $stored = $false
  try {
    Save-ToCredentialManager -Username $username -Password $password
    Write-Host "  [OK] Stored in Windows Credential Manager"
    $stored = $true
  } catch {
    Write-Host "  [WARN] Credential Manager write failed: $_"
    Write-Host "         Falling back to DPAPI encrypted file."
  }

  if (-not $stored) {
    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
    try {
      Protect-Secret -PlainText $password -OutPath $EncFile
      Write-Host "  [OK] Stored in DPAPI-encrypted file: $EncFile"
      $stored = $true
    } catch {
      Write-Host "  [WARN] DPAPI encryption failed: $_"
    }
  }

  if (-not $stored) {
    # Last resort: .env (warn)
    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
    Set-Content -Path $DotEnvFile -Value "# Created: $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))`nOPENGROK_PASSWORD=$password" -Encoding UTF8
    $acl = Get-Acl $DotEnvFile
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
              $env:USERNAME, 'FullControl', 'Allow')
    $acl.SetAccessRule($rule)
    Set-Acl $DotEnvFile $acl -ErrorAction SilentlyContinue
    Write-Host "  [WARN] Fallback: password saved to $DotEnvFile (plaintext)"
  }

  # ── Save non-secret config ───────────────────────────────────────────────
  New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
  $cfg = [ordered]@{
    OPENGROK_BASE_URL  = $baseUrl
    OPENGROK_USERNAME  = $username
    OPENGROK_VERIFY_SSL = if ($verifySsl) { "true" } else { "false" }
  }
  $cfg | ConvertTo-Json | Set-Content -Path $ConfigFile -Encoding UTF8
  Write-Host "  [OK] Saved config: $ConfigFile"

  Write-Host ""
  Write-Host "╔════════════════════════════════════════════════════════╗"
  Write-Host "║   Setup complete! Add opengrok to your MCP client.    ║"
  Write-Host "╚════════════════════════════════════════════════════════╝"
  Write-Host ""
  Write-Host "Example client config (Claude Code, Cursor, Windsurf):"
  Write-Host ""
  $scriptPath = $MyInvocation.MyCommand.Path -replace '\.ps1$', '.cmd'
  Write-Host '  { "mcpServers": { "opengrok": { "command": "' + $scriptPath + '" } } }'
  Write-Host ""
  Write-Host "  For OpenCode (opencode.ai):"
  Write-Host '  { "mcp": { "opengrok": { "type": "local", "command": ["' + $scriptPath + '"] } } }'
  Write-Host ""
  Write-Host "See MCP_CLIENTS.md for all client configurations."
  Write-Host ""
}

# ──────────────────────────────────────────────────────────────────────────────
# Server mode: silent credential resolution → exec server
# ──────────────────────────────────────────────────────────────────────────────

function Start-Server {
  if (-not (Test-Path $BinaryPath)) {
    Write-Error "opengrok-mcp: binary not found: $BinaryPath`nSet OPENGROK_BIN or install to same directory."
    exit 1
  }

  # Resolve node — the binary is a Node.js script with a shebang (not a native exe)
  $NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $NodeExe) {
    Write-Error "opengrok-mcp: node.js not found in PATH. Install Node.js >= 18 from https://nodejs.org/"
    exit 1
  }

  # Load non-secret config
  Import-ConfigJson -Path $ConfigFile

  # 1. Already in environment
  if ($env:OPENGROK_PASSWORD) {
    & $NodeExe $BinaryPath @PassThru
    exit $LASTEXITCODE
  }

  # 2. Windows Credential Manager
  $pw = Read-FromCredentialManager -Username ($env:OPENGROK_USERNAME ?? $env:USERNAME)
  if ($pw) {
    $env:OPENGROK_PASSWORD = $pw
    & $NodeExe $BinaryPath @PassThru
    exit $LASTEXITCODE
  }

  # 3. DPAPI encrypted file
  if (Test-Path $EncFile) {
    try {
      $pw = Unprotect-Secret -InPath $EncFile
      if ($pw) {
        $env:OPENGROK_PASSWORD = $pw
        & $NodeExe $BinaryPath @PassThru
        exit $LASTEXITCODE
      }
    } catch {}
  }

  # 4. .env fallback
  if (Test-Path $DotEnvFile) {
    # Warn if .env file is older than 30 days
    $fileAge = (Get-Date) - (Get-Item $DotEnvFile).LastWriteTime
    if ($fileAge.TotalDays -ge 30) {
      Write-Warning "opengrok-mcp: Plaintext .env file is $([int]$fileAge.TotalDays) days old. Consider running --setup with a proper credential store."
    }
    Import-DotEnv -Path $DotEnvFile
    if ($env:OPENGROK_PASSWORD) {
      & $NodeExe $BinaryPath @PassThru
      exit $LASTEXITCODE
    }
  }

  # 5. Nothing found
  $scriptCmd = $MyInvocation.MyCommand.Path -replace '\.ps1$', '.cmd'
  Write-Error @"
opengrok-mcp: No credentials found.
Run once in your terminal to set up credentials:
  $scriptCmd --setup
"@
  exit 1
}

# ──────────────────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────────────────

if ($Help) {
  Write-Host "Usage: opengrok-mcp-wrapper.cmd [--setup | --version | --help]"
  Write-Host ""
  Write-Host "  --setup    Interactive credential setup (run once in your terminal)"
  Write-Host "  --version  Print server version and exit"
  Write-Host "  --help     Show this help"
  Write-Host "  (no args)  Resolve credentials and start the MCP server (spawned by client)"
  exit 0
}

if ($Version) {
  $NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $NodeExe) { Write-Error "node.js not found in PATH."; exit 1 }
  & $NodeExe $BinaryPath --version
  exit $LASTEXITCODE
}

if ($Setup) {
  Start-Setup
  exit 0
}

Start-Server
