#!/usr/bin/env bash
# xcodit installer for Linux and macOS.
# Puts the CLI in ~/.xcodit (no sudo) and adds ~/.xcodit/bin to PATH.
set -euo pipefail

PREFIX="${XCODIT_HOME:-$HOME/.xcodit}"
BIN="$PREFIX/bin"
PKG="xcodit-ai"

info() { printf '==> %s\n' "$*"; }
err() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || err "Node.js 22+ is required. Install from https://nodejs.org"
command -v npm >/dev/null 2>&1 || err "npm is required (it ships with Node.js)."

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  err "Node.js 22+ is required (found $(node -v))."
fi

mkdir -p "$PREFIX"
info "Installing $PKG into $PREFIX"
npm install -g "$PKG" --prefix "$PREFIX"

if [ "$PREFIX" = "$HOME/.xcodit" ]; then
  PATH_LINE='export PATH="$HOME/.xcodit/bin:$PATH"'
else
  PATH_LINE="export PATH=\"$PREFIX/bin:\$PATH\""
fi

append_path() {
  _file="$1"
  mkdir -p "$(dirname "$_file")"
  if [ ! -f "$_file" ]; then
    touch "$_file"
  fi
  if grep -F "$PREFIX/bin" "$_file" >/dev/null 2>&1; then
    return 0
  fi
  printf '\n# xcodit\n%s\n' "$PATH_LINE" >> "$_file"
  info "Added PATH to $_file"
}

OS="$(uname -s)"
SHELL_NAME="$(basename "${SHELL:-/bin/sh}")"

case "$SHELL_NAME" in
  zsh)
    append_path "$HOME/.zshrc"
    # macOS Terminal.app is a login shell; Homebrew often uses .zprofile too.
    if [ "$OS" = Darwin ]; then
      append_path "$HOME/.zprofile"
    fi
    ;;
  bash)
    append_path "$HOME/.bashrc"
    if [ "$OS" = Darwin ]; then
      append_path "$HOME/.bash_profile"
    else
      append_path "$HOME/.profile"
    fi
    ;;
  fish)
    FISH_FILE="$HOME/.config/fish/config.fish"
    mkdir -p "$(dirname "$FISH_FILE")"
    if [ ! -f "$FISH_FILE" ]; then
      touch "$FISH_FILE"
    fi
    if ! grep -F "$PREFIX/bin" "$FISH_FILE" >/dev/null 2>&1; then
      printf '\n# xcodit\nfish_add_path -g %s\n' "$BIN" >> "$FISH_FILE"
      info "Added PATH to $FISH_FILE"
    fi
    ;;
  *)
    append_path "$HOME/.profile"
    ;;
esac

# Ubuntu/Debian often already put ~/.local/bin on PATH.
if [ "$OS" = Linux ]; then
  mkdir -p "$HOME/.local/bin"
  ln -sf "$BIN/xcodit" "$HOME/.local/bin/xcodit"
fi

info "Installed $($BIN/xcodit --version 2>/dev/null || echo xcodit) → $BIN/xcodit"
case ":$PATH:" in
  *":$BIN:"*)
    info "Ready. Run:  xcodit"
    ;;
  *)
    info "Restart your terminal, or run:"
    printf '    %s\n    xcodit\n' "$PATH_LINE"
    ;;
esac
