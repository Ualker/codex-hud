#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
FAKE_BIN_DIR="$(mktemp -d)"
TEST_HOME="$(mktemp -d)"
LOG_DIR="$(mktemp -d)"
ZDOTDIR_DIR="$TEST_HOME/zdotdir"
FISH_CONFIG_DIR="$TEST_HOME/.config/fish"
FISH_CONFIG="$FISH_CONFIG_DIR/config.fish"
MARKER="# codex-hud alias"
FISH_BIN="$(command -v fish || true)"
PROXY_FIXTURE="$TEST_HOME/proxy.fish"

cleanup() {
  rm -rf "$FAKE_BIN_DIR" "$TEST_HOME" "$LOG_DIR"
}
trap cleanup EXIT

mkdir -p "$ZDOTDIR_DIR" "$FISH_CONFIG_DIR"
touch "$TEST_HOME/.bashrc"
mkdir -p "$TEST_HOME/dotfiles"
printf '# user footer\n' > "$TEST_HOME/dotfiles/zshrc"
chmod 640 "$TEST_HOME/dotfiles/zshrc"
ln -s ../dotfiles/zshrc "$ZDOTDIR_DIR/.zshrc"
touch "$TEST_HOME/dotfiles/profile"
chmod 640 "$TEST_HOME/dotfiles/profile"
ln -s profile "$TEST_HOME/dotfiles/profile-link"
ln -s dotfiles/profile-link "$TEST_HOME/.bash_profile"

cat > "$FISH_CONFIG" <<EOF
alias codex '$ROOT_DIR/bin/codex-hud'
alias cx '$ROOT_DIR/bin/codex-hud'
alias codex-resume '$ROOT_DIR/bin/codex-hud resume'
alias codex-hud-install '$ROOT_DIR/bin/codex-hud-install'
alias codex-hud-sync '$ROOT_DIR/bin/codex-hud-sync'
alias codex-hud-upgrade '$ROOT_DIR/bin/codex-hud-upgrade'
alias codex-hud-uninstall '$ROOT_DIR/bin/codex-hud-uninstall'

alias codex-hud '$ROOT_DIR/bin/codex-hud'  $MARKER
alias codex '$ROOT_DIR/bin/codex-hud'  $MARKER
EOF

cat > "$PROXY_FIXTURE" <<EOF
# User-owned overrides must stay after the managed aliases.
function __codex_hud_test_proxy_run
    env http_proxy=http://127.0.0.1:9897 "$FAKE_BIN_DIR/proxy-target" \$argv
end
function codex
    __codex_hud_test_proxy_run '$ROOT_DIR/bin/codex-hud' \$argv
end
function codex-resume
    __codex_hud_test_proxy_run '$ROOT_DIR/bin/codex-hud' resume \$argv
end
function codex-hud-install
    __codex_hud_test_proxy_run '$ROOT_DIR/bin/codex-hud-install' \$argv
end
# Preserve this unrelated user footer too.
EOF
cat "$PROXY_FIXTURE" >> "$FISH_CONFIG"

cat > "$FAKE_BIN_DIR/proxy-target" <<'FAKE'
#!/usr/bin/env bash
printf 'proxy=%s' "${http_proxy:-missing}"
printf ' <%s>' "$@"
printf '\n'
FAKE
chmod +x "$FAKE_BIN_DIR/proxy-target"

cat > "$FAKE_BIN_DIR/node" <<'FAKE'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  echo "v22.17.0"
  exit 0
fi
exit 0
FAKE

cat > "$FAKE_BIN_DIR/npm" <<FAKE
#!/usr/bin/env bash
echo "npm \$*" >> "$LOG_DIR/npm.log"
exit 0
FAKE

cat > "$FAKE_BIN_DIR/codex" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE

cat > "$FAKE_BIN_DIR/tmux" <<FAKE
#!/usr/bin/env bash
cmd="\${1:-}"
shift || true
case "\$cmd" in
  -V)
    echo "tmux 3.4"
    ;;
  list-sessions|list-panes)
    exit 0
    ;;
  display-message)
    exit 0
    ;;
  kill-session|kill-pane)
    echo "tmux \$cmd \$*" >> "$LOG_DIR/tmux.log"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
FAKE

cat > "$FAKE_BIN_DIR/git" <<FAKE
#!/usr/bin/env bash
echo "git \$*" >> "$LOG_DIR/git.log"
case "\${1:-}" in
  rev-parse)
    if [[ "\${2:-}" == "--is-inside-work-tree" ]]; then
      echo "true"
      exit 0
    fi
    ;;
  status)
    if [[ "\${FAKE_GIT_DIRTY:-}" == "1" ]]; then
      echo " M tracked-file"
    fi
    exit 0
    ;;
esac
exit 0
FAKE

chmod +x "$FAKE_BIN_DIR/node" "$FAKE_BIN_DIR/npm" "$FAKE_BIN_DIR/codex" "$FAKE_BIN_DIR/tmux" "$FAKE_BIN_DIR/git"

export PATH="$FAKE_BIN_DIR:$PATH"
export HOME="$TEST_HOME"
export ZDOTDIR="$ZDOTDIR_DIR"
export SHELL="/bin/bash"

assert_alias_present() {
  local file="$1"
  local alias_name="$2"
  if [[ ! -f "$file" ]]; then
    echo "expected rc file to exist: $file" >&2
    exit 1
  fi
  if ! grep -Eq "^alias $alias_name(=| )" "$file"; then
    echo "expected alias $alias_name in $file" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_alias_absent() {
  local file="$1"
  local alias_name="$2"
  if grep -Eq "^alias $alias_name(=| )" "$file"; then
    echo "expected alias $alias_name to be removed from $file" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_alias_count() {
  local file="$1"
  local alias_name="$2"
  local expected_count="$3"
  local actual_count
  actual_count=$(grep -Ec "^alias $alias_name(=| )" "$file" || true)
  if [[ "$actual_count" != "$expected_count" ]]; then
    echo "expected $expected_count alias $alias_name entries in $file, got $actual_count" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_fish_proxy_overrides() {
  # The user footer must survive verbatim, after every generated alias.
  tail -n "$(wc -l < "$PROXY_FIXTURE" | tr -d ' ')" "$FISH_CONFIG" > "$TEST_HOME/footer.actual"
  if ! cmp -s "$PROXY_FIXTURE" "$TEST_HOME/footer.actual"; then
    echo "expected fish user overrides to remain after the managed aliases" >&2
    exit 1
  fi
  if [[ -n "$FISH_BIN" ]]; then
    local actual expected
    actual=$("$FISH_BIN" --no-config -c '
      set -e http_proxy
      source $argv[1]
      codex "argument with spaces" ""
      codex-resume --last
      codex-hud-install --help
      if set -q http_proxy
        echo "proxy leaked into the calling shell" >&2
        exit 1
      end
    ' -- "$FISH_CONFIG")
    expected=$(printf 'proxy=http://127.0.0.1:9897 <%s> <argument with spaces> <>\nproxy=http://127.0.0.1:9897 <%s> <resume> <--last>\nproxy=http://127.0.0.1:9897 <%s> <--help>' \
      "$ROOT_DIR/bin/codex-hud" "$ROOT_DIR/bin/codex-hud" "$ROOT_DIR/bin/codex-hud-install")
    if [[ "$actual" != "$expected" ]]; then
      echo "fish proxy overrides or argument forwarding changed: $actual" >&2
      exit 1
    fi
  fi
}

"$ROOT_DIR/bin/codex-hud-install" >/tmp/codex-hud-manage-install.log 2>&1
assert_fish_proxy_overrides

for file in "$HOME/.bashrc" "$HOME/.bash_profile" "$ZDOTDIR/.zshrc" "$FISH_CONFIG"; do
  assert_alias_present "$file" "codex-hud"
  assert_alias_present "$file" "codex"
  assert_alias_present "$file" "cx"
  assert_alias_present "$file" "codex-resume"
  assert_alias_present "$file" "codex-hud-install"
  assert_alias_present "$file" "codex-hud-sync"
  assert_alias_present "$file" "codex-hud-upgrade"
  assert_alias_present "$file" "codex-hud-uninstall"
  assert_alias_count "$file" "codex" "1"
  assert_alias_count "$file" "cx" "1"
  assert_alias_count "$file" "codex-resume" "1"
done

cp "$FISH_CONFIG" "$TEST_HOME/installed.fish"
for file in "$HOME/.bashrc" "$HOME/.bash_profile" "$ZDOTDIR/.zshrc"; do
  echo '# user footer after HUD' >> "$file"
  cp "$file" "$LOG_DIR/$(basename "$file").installed"
done
"$ROOT_DIR/bin/codex-hud-install" >"$LOG_DIR/reinstall.log" 2>&1
assert_fish_proxy_overrides
cmp "$TEST_HOME/installed.fish" "$FISH_CONFIG"
for file in "$HOME/.bashrc" "$HOME/.bash_profile" "$ZDOTDIR/.zshrc"; do
  cmp "$file" "$LOG_DIR/$(basename "$file").installed"
done
[[ -L "$ZDOTDIR/.zshrc" ]]
[[ "$(readlink "$ZDOTDIR/.zshrc")" == ../dotfiles/zshrc ]]
mode=$(stat -c %a "$ZDOTDIR/../dotfiles/zshrc" 2>/dev/null || stat -f %Lp "$ZDOTDIR/../dotfiles/zshrc")
[[ "$mode" == 640 ]]

cat > "$HOME/.bashrc" <<EOF
alias codex='$ROOT_DIR/bin/codex-hud'  $MARKER
alias codex-resume='$ROOT_DIR/bin/codex-hud resume'  $MARKER
EOF

"$ROOT_DIR/bin/codex-hud-sync" >/tmp/codex-hud-manage-sync.log 2>&1
assert_fish_proxy_overrides
cmp "$TEST_HOME/installed.fish" "$FISH_CONFIG"

assert_alias_present "$HOME/.bashrc" "codex-hud-sync"
assert_alias_present "$HOME/.bashrc" "codex-hud-upgrade"
assert_alias_present "$HOME/.bashrc" "codex-hud-uninstall"
assert_alias_present "$HOME/.bashrc" "codex-hud"
assert_alias_present "$HOME/.bashrc" "cx"

if FAKE_GIT_DIRTY=1 "$ROOT_DIR/bin/codex-hud-upgrade" >/tmp/codex-hud-manage-upgrade.log 2>&1; then
  echo "expected upgrade wrapper to reject a dirty tracked worktree" >&2
  exit 1
fi
if ! grep -Fq "Upgrade requires a clean tracked worktree" /tmp/codex-hud-manage-upgrade.log; then
  echo "expected upgrade wrapper to delegate to the transactional preflight" >&2
  cat /tmp/codex-hud-manage-upgrade.log >&2
  exit 1
fi
if ! grep -q '^git status --short --untracked-files=no$' "$LOG_DIR/git.log"; then
  echo "expected upgrade preflight to inspect tracked worktree changes" >&2
  cat "$LOG_DIR/git.log" >&2
  exit 1
fi

"$ROOT_DIR/bin/codex-hud-uninstall" >/tmp/codex-hud-manage-uninstall.log 2>&1

for file in "$HOME/.bashrc" "$HOME/.bash_profile" "$ZDOTDIR/.zshrc" "$FISH_CONFIG"; do
  assert_alias_absent "$file" "codex-hud"
  assert_alias_absent "$file" "codex"
  assert_alias_absent "$file" "cx"
  assert_alias_absent "$file" "codex-resume"
  assert_alias_absent "$file" "codex-hud-install"
  assert_alias_absent "$file" "codex-hud-sync"
  assert_alias_absent "$file" "codex-hud-upgrade"
  assert_alias_absent "$file" "codex-hud-uninstall"
done

[[ -L "$ZDOTDIR/.zshrc" ]]
mode=$(stat -c %a "$TEST_HOME/dotfiles/zshrc" 2>/dev/null || stat -f %Lp "$TEST_HOME/dotfiles/zshrc")
[[ "$mode" == 640 ]]
grep -q '# user footer after HUD' "$ZDOTDIR/.zshrc"
[[ -L "$HOME/.bash_profile" ]]
[[ -L "$HOME/dotfiles/profile-link" ]]
mode=$(stat -c %a "$HOME/dotfiles/profile" 2>/dev/null || stat -f %Lp "$HOME/dotfiles/profile")
[[ "$mode" == 640 ]]
echo "test-management-commands: PASS"
