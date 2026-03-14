#!/usr/bin/env sh
# install.sh — Single-command installer for opengrok-mcp standalone server
#
# Usage:
#   curl -fsSL https://github.com/IcyHot09/opengrok-mcp-server/releases/latest/download/install.sh | sh
#
# Options (via environment variables):
#   OPENGROK_MCP_VERSION      Specific version to install (default: latest)
#   OPENGROK_MCP_INSTALL_DIR  Install directory (default: ~/.local/bin)
#   HTTPS_PROXY               Corporate proxy URL (respected automatically)

set -eu

# ── Configuration ────────────────────────────────────────────────────────────
REPO_URL="https://github.com/IcyHot09/opengrok-mcp-server"
INSTALL_DIR="${OPENGROK_MCP_INSTALL_DIR:-$HOME/.local/bin}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opengrok-mcp"

# ── Helpers ──────────────────────────────────────────────────────────────────
info()  { printf '\033[0;32m  ✓ %s\033[0m\n' "$*"; }
warn()  { printf '\033[0;33m  ! %s\033[0m\n' "$*" >&2; }
error() { printf '\033[0;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }
step()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ── Preflight checks ─────────────────────────────────────────────────────────
step "Checking prerequisites..."

if ! command -v curl >/dev/null 2>&1; then
  error "curl is required but not installed. Install it and try again."
fi

if ! command -v tar >/dev/null 2>&1; then
  error "tar is required but not installed. Install it and try again."
fi

if ! command -v node >/dev/null 2>&1; then
  warn "node not found in PATH. The server requires Node.js >= 18."
  warn "Install Node.js from https://nodejs.org/ or via your package manager."
fi

# ── Detect platform ──────────────────────────────────────────────────────────
step "Detecting platform..."

OS="$(uname -s)"
case "$OS" in
  Linux)  PLATFORM="linux"  ;;
  Darwin) PLATFORM="darwin" ;;
  *)      error "Unsupported OS: $OS. Manual installation required." ;;
esac
info "Platform: $PLATFORM"

# ── Resolve version ──────────────────────────────────────────────────────────
step "Resolving version..."

if [ -n "${OPENGROK_MCP_VERSION:-}" ]; then
  VERSION="$OPENGROK_MCP_VERSION"
  info "Using requested version: $VERSION"
else
  # Fetch latest release tag from GitHub API
  LATEST_URL="https://api.github.com/repos/IcyHot09/opengrok-mcp-server/releases/latest"
  VERSION="$(curl -fsSL --max-time 10 ${HTTPS_PROXY:+--proxy "$HTTPS_PROXY"} \
    -H 'Accept: application/vnd.github+json' \
    "$LATEST_URL" 2>/dev/null \
    | grep -o '"tag_name":"[^"]*"' \
    | head -1 \
    | sed 's/"tag_name":"//;s/"//')" || true

  if [ -z "$VERSION" ]; then
    error "Could not determine latest version. Check your network or set OPENGROK_MCP_VERSION."
  fi
  info "Latest version: $VERSION"
fi

# Strip leading 'v' if present (normalize)
VERSION_NUM="${VERSION#v}"
ARCHIVE="opengrok-mcp-${VERSION_NUM}-${PLATFORM}.tar.gz"
DOWNLOAD_URL="${REPO_URL}/releases/download/${VERSION}/${ARCHIVE}"

# ── Download ──────────────────────────────────────────────────────────────────
step "Downloading $ARCHIVE..."

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT INT TERM

ARCHIVE_PATH="$TMPDIR/$ARCHIVE"

curl -fL --max-time 120 --progress-bar \
  ${HTTPS_PROXY:+--proxy "$HTTPS_PROXY"} \
  -o "$ARCHIVE_PATH" \
  "$DOWNLOAD_URL" \
  || error "Download failed from: $DOWNLOAD_URL\nCheck your network or proxy settings."

info "Download complete"

# ── Extract ───────────────────────────────────────────────────────────────────
step "Extracting..."

EXTRACT_DIR="$TMPDIR/extract"
mkdir -p "$EXTRACT_DIR"
tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR" \
  || error "Failed to extract archive. The download may be corrupt."

info "Extracted successfully"

# ── Install ───────────────────────────────────────────────────────────────────
step "Installing to $INSTALL_DIR..."

mkdir -p "$INSTALL_DIR"
mkdir -p "$CONFIG_DIR"

# Copy and set permissions
cp -f "$EXTRACT_DIR/opengrok-mcp" "$INSTALL_DIR/opengrok-mcp"
cp -f "$EXTRACT_DIR/opengrok-mcp-wrapper.sh" "$INSTALL_DIR/opengrok-mcp-wrapper.sh"
chmod +x "$INSTALL_DIR/opengrok-mcp"
chmod +x "$INSTALL_DIR/opengrok-mcp-wrapper.sh"

info "Installed opengrok-mcp"
info "Installed opengrok-mcp-wrapper.sh"

# ── PATH check ────────────────────────────────────────────────────────────────
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    warn "$INSTALL_DIR is not in your PATH."
    warn "Add it with: export PATH=\"$INSTALL_DIR:\$PATH\""
    warn "Then add that line to your ~/.bashrc or ~/.zshrc"
    ;;
esac

# ── Done ──────────────────────────────────────────────────────────────────────
printf '\n\033[1;32m✓ opengrok-mcp %s installed successfully!\033[0m\n\n' "$VERSION_NUM"
printf 'Next step — configure your credentials:\n\n'
printf '  \033[1m%s/opengrok-mcp-wrapper.sh --setup\033[0m\n\n' "$INSTALL_DIR"
printf 'This will prompt for your OpenGrok URL, username, and password,\n'
printf 'and store credentials securely (OS keychain or encrypted file).\n\n'
printf 'See MCP_CLIENTS.md for client configuration examples.\n'
