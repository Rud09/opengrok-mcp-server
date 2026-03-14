#!/usr/bin/env bash
# opengrok-mcp-wrapper.sh
#
# Credential wrapper for the OpenGrok MCP server.
# Resolves credentials from OS keychain or encrypted file, then exec's the server.
#
# Usage:
#   opengrok-mcp-wrapper.sh --setup   # Interactive one-time credential setup
#   opengrok-mcp-wrapper.sh           # Silent mode — spawned by MCP clients
#
# Environment overrides:
#   OPENGROK_BIN          Path to opengrok-mcp binary (default: same dir as this script)
#   OPENGROK_CONFIG_DIR   Config directory (default: ~/.config/opengrok-mcp)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENGROK_BIN="${OPENGROK_BIN:-$SCRIPT_DIR/opengrok-mcp}"
CONFIG_DIR="${OPENGROK_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opengrok-mcp}"
CONFIG_FILE="$CONFIG_DIR/config"
ENC_FILE="$CONFIG_DIR/credentials.enc"
DOTENV_FILE="$CONFIG_DIR/.env"
SALT_FILE="$CONFIG_DIR/.salt"

# ── Encryption helpers ────────────────────────────────────────────────────────

# Ensure a random salt file exists (created once, reused for key derivation)
_ensure_salt() {
  if [[ ! -f "$SALT_FILE" ]] || [[ ! -s "$SALT_FILE" ]]; then
    mkdir -p "$CONFIG_DIR"
    dd if=/dev/urandom bs=16 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n' > "$SALT_FILE"
    chmod 600 "$SALT_FILE"
    if [[ ! -s "$SALT_FILE" ]]; then
      echo "opengrok-mcp: ⚠ Failed to generate cryptographic salt — encryption will use weaker key material." >&2
      rm -f "$SALT_FILE"
      return 1
    fi
  fi
}

# Derive a passphrase from machine-id + username + random salt (unique per install)
_key_material() {
  local machine_id salt
  machine_id="$(cat /etc/machine-id 2>/dev/null || hostname 2>/dev/null || echo 'default')"
  salt="$(cat "$SALT_FILE" 2>/dev/null || echo '')"
  printf '%s%s%s' "$machine_id" "$USER" "$salt"
}

encrypt_credentials() {
  local password="$1"
  local out_file="$2"
  local kmat
  _ensure_salt
  kmat="$(_key_material)"
  printf '%s' "$password" \
    | openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -pass "pass:${kmat}" -out "$out_file" 2>/dev/null \
    || { echo "opengrok-mcp: openssl encryption failed." >&2; return 1; }
  chmod 600 "$out_file"
}

decrypt_credentials() {
  local in_file="$1"
  local kmat
  kmat="$(_key_material)"
  openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -d \
    -pass "pass:${kmat}" -in "$in_file" 2>/dev/null
}

# Legacy key material (without salt) for migration from pre-salt encrypted files
_key_material_legacy() {
  local machine_id
  machine_id="$(cat /etc/machine-id 2>/dev/null || hostname 2>/dev/null || echo 'default')"
  printf '%s%s' "$machine_id" "$USER"
}

# Migrate encrypted credentials from legacy (no salt) to salted key derivation
_migrate_credentials() {
  if [[ -f "$ENC_FILE" ]] && [[ ! -f "$SALT_FILE" ]] && command -v openssl >/dev/null 2>&1; then
    local legacy_kmat pw
    legacy_kmat="$(_key_material_legacy)"
    pw="$(openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -d \
          -pass "pass:${legacy_kmat}" -in "$ENC_FILE" 2>/dev/null)" || return 0
    if [[ -n "$pw" ]]; then
      # Re-encrypt with salted key (encrypt_credentials calls _ensure_salt)
      encrypt_credentials "$pw" "$ENC_FILE" || true
    fi
  fi
}

# ── Keychain helpers ──────────────────────────────────────────────────────────

_macos_keychain_store() {
  local username="$1" password="$2"
  # Delete existing entry first (ignore failure if not found)
  security delete-generic-password -s opengrok-mcp -a "$username" 2>/dev/null || true
  security add-generic-password -s opengrok-mcp -a "$username" -w "$password" 2>/dev/null
}

_macos_keychain_read() {
  local username="$1"
  security find-generic-password -s opengrok-mcp -a "$username" -w 2>/dev/null
}

_secrettool_available() {
  # Return 0 only if secret-tool is installed AND D-Bus/keyring is reachable
  command -v secret-tool >/dev/null 2>&1 || return 1
  # Probe: a failed lookup returns exit 1; a D-Bus error returns exit >1
  secret-tool lookup service opengrok-mcp-probe username probe 2>/dev/null
  local rc=$?
  [[ $rc -eq 0 || $rc -eq 1 ]]  # 0=found, 1=not found — both mean D-Bus works
}

_secrettool_store() {
  local username="$1" password="$2"
  printf '%s' "$password" \
    | secret-tool store --label="OpenGrok MCP credentials" \
        service opengrok-mcp username "$username" 2>/dev/null
}

_secrettool_read() {
  local username="$1"
  secret-tool lookup service opengrok-mcp username "$username" 2>/dev/null
}

# ── Safe .env / config file parser ───────────────────────────────────────────
# Does NOT use `source` — prevents arbitrary code execution.
_load_file_vars() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  while IFS='=' read -r key value; do
    # Trim whitespace from key
    key="${key#"${key%%[! ]*}"}"
    key="${key%"${key##*[! ]}"}"
    # Skip comments and blank lines
    [[ -z "$key" || "$key" == \#* ]] && continue
    # Only export safe variable names (alphanumeric + underscore, starts with letter)
    if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      export "$key"="$value"
    fi
  done < "$file"
}

# ═════════════════════════════════════════════════════════════════════════════
# --setup mode: interactive credential setup
# ═════════════════════════════════════════════════════════════════════════════

_run_setup() {
  echo ""
  echo "╔════════════════════════════════════════════╗"
  echo "║   OpenGrok MCP — Credential Setup         ║"
  echo "╚════════════════════════════════════════════╝"
  echo ""

  # Prompt for configuration
  local default_url="https://opengrok.example.com/source/"
  read -r -p "OpenGrok Base URL [${default_url}]: " input_url
  local base_url="${input_url:-$default_url}"

  read -r -p "Username [${USER}]: " input_user
  local username="${input_user:-$USER}"

  local password=""
  while [[ -z "$password" ]]; do
    read -r -s -p "Password: " password
    echo ""
    if [[ -z "$password" ]]; then
      echo "Password cannot be empty. Please try again."
    fi
  done

  read -r -p "Verify SSL certificates? [Y/n]: " input_ssl
  local verify_ssl="true"
  if [[ "${input_ssl,,}" == "n" || "${input_ssl,,}" == "no" ]]; then
    verify_ssl="false"
  fi

  echo ""
  echo "Testing connection..."

  # Quick connectivity test using curl (avoid depending on the server itself)
  local test_url="${base_url%/}/api/v1/projects"
  local curl_args=(-fsSL --max-time 10 -u "${username}:${password}" -o /dev/null -w "%{http_code}")
  if [[ "$verify_ssl" == "false" ]]; then
    curl_args+=(-k)
  fi
  local http_code
  http_code="$(curl "${curl_args[@]}" "$test_url" 2>/dev/null)" || http_code="000"

  case "$http_code" in
    200|201) echo "  ✓ Connection successful (HTTP $http_code)" ;;
    401|403) echo "  ✗ Authentication failed (HTTP $http_code). Check username and password." ; return 1 ;;
    000)     echo "  ✗ Could not reach $test_url. Check the URL and your network." ; return 1 ;;
    *)       echo "  ! Unexpected response (HTTP $http_code). Proceeding anyway." ;;
  esac

  # ── Store credentials in the most secure available store ──────────────────
  echo ""
  echo "Storing credentials..."

  local stored=false

  case "$(uname -s)" in
    Darwin)
      if _macos_keychain_store "$username" "$password"; then
        echo "  ✓ Stored in macOS Keychain"
        stored=true
      else
        echo "  ! Keychain write failed, falling back to encrypted file."
      fi
      ;;
    Linux)
      if _secrettool_available; then
        if _secrettool_store "$username" "$password"; then
          echo "  ✓ Stored in GNOME Keyring / KDE Wallet via secret-tool"
          stored=true
        else
          echo "  ! secret-tool write failed, falling back to encrypted file."
        fi
      else
        echo "  ℹ No desktop keychain available (headless/SSH session)."
      fi
      ;;
  esac

  if [[ "$stored" == "false" ]]; then
    if command -v openssl >/dev/null 2>&1; then
      mkdir -p "$CONFIG_DIR"
      if encrypt_credentials "$password" "$ENC_FILE"; then
        echo "  ✓ Stored in encrypted file: $ENC_FILE"
        echo "    (AES-256-CBC, key derived from machine-id + username)"
        stored=true
      else
        echo "  ! Encryption failed."
      fi
    fi
  fi

  if [[ "$stored" == "false" ]]; then
    # Last resort: plaintext .env (warn user)
    mkdir -p "$CONFIG_DIR"
    printf '# Created: %s\nOPENGROK_PASSWORD=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$password" > "$DOTENV_FILE"
    chmod 600 "$DOTENV_FILE"
    echo "  ⚠ Fallback: password saved to $DOTENV_FILE (plaintext)"
    echo "    Consider installing openssl or configuring a keychain for better security."
  fi

  # ── Store non-secret config (URL, username, SSL) ──────────────────────────
  mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_FILE" <<EOF
# OpenGrok MCP non-secret configuration
# Generated by: opengrok-mcp-wrapper.sh --setup
OPENGROK_BASE_URL=${base_url}
OPENGROK_USERNAME=${username}
OPENGROK_VERIFY_SSL=${verify_ssl}
EOF
  chmod 644 "$CONFIG_FILE"
  echo "  ✓ Saved config: $CONFIG_FILE"

  echo ""
  echo "╔═══════════════════════════════════════════════════════╗"
  echo "║   Setup complete! Add opengrok to your MCP client.   ║"
  echo "╚═══════════════════════════════════════════════════════╝"
  echo ""
  echo "Example client config (Claude Code, Cursor, Windsurf):"
  echo ""
  echo '  { "mcpServers": { "opengrok": { "command": "'"${BASH_SOURCE[0]}"'" } } }'
  echo ""
  echo "  For OpenCode (opencode.ai):"
  echo '  { "mcp": { "opengrok": { "type": "local", "command": ["'"${BASH_SOURCE[0]}"'"] } } }'
  echo ""
  echo "See MCP_CLIENTS.md for all client configurations."
  echo ""
}

# ═════════════════════════════════════════════════════════════════════════════
# Server mode: silent credential resolution, then exec the server
# ═════════════════════════════════════════════════════════════════════════════

_run_server() {
  # Verify the binary exists
  if [[ ! -x "$OPENGROK_BIN" ]]; then
    echo "opengrok-mcp: binary not found or not executable: $OPENGROK_BIN" >&2
    echo "Set OPENGROK_BIN or ensure opengrok-mcp is in the same directory." >&2
    exit 1
  fi

  # Load non-secret config (URL, username, SSL verify)
  _load_file_vars "$CONFIG_FILE"

  # ── Credential resolution chain ────────────────────────────────────────────

  # 1. Already in environment → use it (backward compat / CI override)
  if [[ -n "${OPENGROK_PASSWORD:-}" ]]; then
    exec "$OPENGROK_BIN" "$@"
  fi

  # 2. OS Keychain
  local pw=""
  case "$(uname -s)" in
    Darwin)
      pw="$(_macos_keychain_read "${OPENGROK_USERNAME:-$USER}")" || pw=""
      if [[ -n "$pw" ]]; then
        export OPENGROK_PASSWORD="$pw"
        exec "$OPENGROK_BIN" "$@"
      fi
      ;;
    Linux)
      if _secrettool_available 2>/dev/null; then
        pw="$(_secrettool_read "${OPENGROK_USERNAME:-$USER}")" || pw=""
        if [[ -n "$pw" ]]; then
          export OPENGROK_PASSWORD="$pw"
          exec "$OPENGROK_BIN" "$@"
        fi
      fi
      ;;
  esac

  # 3. Encrypted credential file (migrate legacy unsalted credentials if needed)
  _migrate_credentials
  if [[ -f "$ENC_FILE" ]]; then
    if command -v openssl >/dev/null 2>&1; then
      pw="$(decrypt_credentials "$ENC_FILE")" || pw=""
      if [[ -n "$pw" ]]; then
        export OPENGROK_PASSWORD="$pw"
        exec "$OPENGROK_BIN" "$@"
      fi
    fi
  fi

  # 4. Plaintext .env fallback
  if [[ -f "$DOTENV_FILE" ]]; then
    # Warn if .env file is older than 30 days
    local file_age_days=0
    if command -v stat >/dev/null 2>&1; then
      local mod_epoch
      mod_epoch="$(stat -c %Y "$DOTENV_FILE" 2>/dev/null || stat -f %m "$DOTENV_FILE" 2>/dev/null || echo 0)"
      if [[ "$mod_epoch" -gt 0 ]]; then
        file_age_days=$(( ($(date +%s) - mod_epoch) / 86400 ))
      fi
    fi
    if [[ "$file_age_days" -ge 30 ]]; then
      echo "opengrok-mcp: ⚠ Plaintext .env file is ${file_age_days} days old. Consider running --setup with openssl installed." >&2
    fi
    _load_file_vars "$DOTENV_FILE"
    if [[ -n "${OPENGROK_PASSWORD:-}" ]]; then
      exec "$OPENGROK_BIN" "$@"
    fi
  fi

  # 5. Nothing found — fail with clear message
  echo "opengrok-mcp: No credentials found." >&2
  echo "Run once in your terminal to set up credentials:" >&2
  echo "  ${BASH_SOURCE[0]} --setup" >&2
  exit 1
}

# ═════════════════════════════════════════════════════════════════════════════
# Entry point
# ═════════════════════════════════════════════════════════════════════════════

case "${1:-}" in
  --setup|-s)
    _run_setup
    ;;
  --version|-v)
    exec "$OPENGROK_BIN" --version
    ;;
  --help|-h)
    echo "Usage: $(basename "${BASH_SOURCE[0]}") [--setup | --version | --help]"
    echo ""
    echo "  --setup    Interactive credential setup (run once in your terminal)"
    echo "  --version  Print server version and exit"
    echo "  --help     Show this help"
    echo "  (no args)  Resolve credentials and start the MCP server (spawned by client)"
    ;;
  *)
    _run_server "$@"
    ;;
esac
