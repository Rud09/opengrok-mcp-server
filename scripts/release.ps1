# OpenGrok MCP Release Script
# Usage: .\scripts\release.ps1 -Version [patch|minor|major] [-Dry]

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('patch', 'minor', 'major')]
    [string]$Version,
    
    [switch]$Dry = $false
)

$ErrorActionPreference = "Stop"

# Colors for output
function Write-Step([string]$Message) {
    Write-Host "===> $Message" -ForegroundColor Cyan
}

function Write-Success([string]$Message) {
    Write-Host "Success: $Message" -ForegroundColor Green
}

function Write-Fail([string]$Message) {
    Write-Host "Error: $Message" -ForegroundColor Red
}

# Check if working directory is clean
Write-Step "Checking Git status..."
$gitStatus = git status --porcelain
if ($gitStatus -and !$Dry) {
    Write-Fail "Working directory has uncommitted changes. Please commit or stash them first."
    exit 1
}
Write-Success "Working directory is clean"

# Get current version
Write-Step "Reading current version..."
$packageJson = Get-Content "package.json" -Raw | ConvertFrom-Json
$currentVersion = $packageJson.version
Write-Host "Current version: $currentVersion" -ForegroundColor Yellow

# Bump version
Write-Step "Bumping $Version version..."
if ($Dry) {
    Write-Host "[DRY RUN] Would run: npm version $Version --no-git-tag-version" -ForegroundColor Yellow
} else {
    npm version $Version --no-git-tag-version
}

# Get new version
$packageJson = Get-Content "package.json" -Raw | ConvertFrom-Json
$newVersion = $packageJson.version
Write-Success "New version: $newVersion"

# Run tests
Write-Step "Running tests..."
if ($Dry) {
    Write-Host "[DRY RUN] Would run: npm test" -ForegroundColor Yellow
} else {
    npm test
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Tests failed. Aborting release."
        exit 1
    }
    Write-Success "Tests passed"
}

# Build extension
Write-Step "Building extension..."
if ($Dry) {
    Write-Host "[DRY RUN] Would run: npm run compile" -ForegroundColor Yellow
} else {
    npm run compile
    Write-Success "Extension compiled"
}

# Package standalone server archives
Write-Step "Packaging standalone server archives..."
if ($Dry) {
    Write-Host "[DRY RUN] Would run: npm run package-server" -ForegroundColor Yellow
} else {
    npm run package-server
    Write-Success "Standalone archives created"
}

# Package VSIX
Write-Step "Packaging VSIX..."
if ($Dry) {
    Write-Host "[DRY RUN] Would run: npm run vsix" -ForegroundColor Yellow
} else {
    npm run vsix
    Write-Success "VSIX packaged: opengrok-mcp-$newVersion.vsix"
}

# Sync server.json version
Write-Step "Syncing server.json version..."
if ($Dry) {
    Write-Host "[DRY RUN] Would update server.json version to $newVersion" -ForegroundColor Yellow
} else {
    $serverJson = Get-Content "server.json" -Raw | ConvertFrom-Json
    $serverJson.version = $newVersion
    $serverJson.packages[0].version = $newVersion
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText("$PWD\server.json", ($serverJson | ConvertTo-Json -Depth 10), $utf8NoBom)
    Write-Success "server.json updated to $newVersion"
}

# Git commit and tag
Write-Step "Creating Git commit and tag..."
if ($Dry) {
    Write-Host "[DRY RUN] Would run:" -ForegroundColor Yellow
    Write-Host "  git add package.json CHANGELOG.md" -ForegroundColor Yellow
    Write-Host "  git commit -m 'chore: release v$newVersion'" -ForegroundColor Yellow
    Write-Host "  git tag v$newVersion" -ForegroundColor Yellow
} else {
    git add package.json CHANGELOG.md server.json
    git commit -m "chore: release v$newVersion"
    git tag "v$newVersion"
    Write-Success "Created commit and tag v$newVersion"
}

# Summary
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "Release Summary" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host "Version: $currentVersion -> $newVersion"
Write-Host "Tag: v$newVersion"
Write-Host "VSIX: opengrok-mcp-$newVersion.vsix"
Write-Host "Archives: opengrok-mcp-$newVersion-linux.tar.gz, -darwin.tar.gz, -win.zip"
Write-Host ""

if ($Dry) {
    Write-Host "[DRY RUN] No changes were made" -ForegroundColor Yellow
} else {
    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "1. Review the changes: git log -1"
    Write-Host "2. Push to GitHub:"
    Write-Host "   git push origin $((git branch --show-current))"
    Write-Host "   git push origin v$newVersion"
    Write-Host ""
    Write-Host "3. GitHub Actions will automatically:" -ForegroundColor Yellow
    Write-Host "   - Run tests on the tag"
    Write-Host "   - Build the VSIX + standalone server archives"
    Write-Host "   - Create a GitHub Release"
    Write-Host "   - Attach the VSIX and platform archives as downloadable artifacts"
    Write-Host ""
    Write-Host "4. Check the release at:" -ForegroundColor Cyan
    Write-Host "   https://github.com/IcyHot09/opengrok-mcp-server/releases"
}
