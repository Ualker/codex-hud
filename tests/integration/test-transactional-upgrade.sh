#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_ROOT="$(mktemp -d /tmp/codex-hud-transactional-upgrade-XXXXXX)"
REMOTE="$TEST_ROOT/remote.git"
SEED="$TEST_ROOT/seed"
PUBLISHER="$TEST_ROOT/publisher"
FAKE_BIN="$TEST_ROOT/fake-bin"
HOME_DIR="$TEST_ROOT/home"
NPM_LOG="$TEST_ROOT/npm.log"
TRACKING_BRANCH="integrate/v1"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

mkdir -p "$SEED/bin" "$FAKE_BIN" "$HOME_DIR"
git init --bare --quiet "$REMOTE"
git -C "$SEED" init --quiet -b "$TRACKING_BRANCH"
git -C "$SEED" config user.email codex-hud-transaction-test@example.com
git -C "$SEED" config user.name 'Codex HUD Transaction Test'
cp "$ROOT_DIR/install.sh" "$SEED/install.sh"
mkdir -p "$SEED/scripts"
cp "$ROOT_DIR/scripts/shell-rc.sh" "$SEED/scripts/shell-rc.sh"
for name in codex-hud codex-hud-install codex-hud-sync codex-hud-upgrade codex-hud-uninstall; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$SEED/bin/$name"
done
chmod +x "$SEED/install.sh" "$SEED/bin/"*
printf '{"name":"transaction-fixture","version":"0.1.0"}\n' > "$SEED/package.json"
printf 'node_modules/\ndist/\n' > "$SEED/.gitignore"
mkdir -p "$SEED/node_modules"
printf 'tracked-dependency\n' > "$SEED/node_modules/tracked.txt"
printf 'base\n' > "$SEED/version.txt"
git -C "$SEED" add install.sh scripts bin package.json version.txt .gitignore
git -C "$SEED" add -f node_modules/tracked.txt
git -C "$SEED" commit --quiet -m base
git -C "$SEED" remote add origin "$REMOTE"
git -C "$SEED" push --quiet --set-upstream origin "$TRACKING_BRANCH"
git --git-dir="$REMOTE" symbolic-ref HEAD "refs/heads/$TRACKING_BRANCH"

for case_name in install-fail build-fail tracked-dirty success tracked-target untracked-collision; do
  git clone --quiet "$REMOTE" "$TEST_ROOT/$case_name"
done
git clone --quiet "$REMOTE" "$PUBLISHER"
git -C "$PUBLISHER" config user.email codex-hud-transaction-test@example.com
git -C "$PUBLISHER" config user.name 'Codex HUD Transaction Test'
printf 'target\n' > "$PUBLISHER/version.txt"
git -C "$PUBLISHER" commit --quiet -am target
git -C "$PUBLISHER" push --quiet origin "$TRACKING_BRANCH"
TARGET_HEAD="$(git -C "$PUBLISHER" rev-parse HEAD)"

cat > "$FAKE_BIN/node" <<'EOF_NODE'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  echo v20.11.0
  exit 0
fi
exit 0
EOF_NODE

cat > "$FAKE_BIN/npm" <<'EOF_NPM'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--version" ]]; then
  echo 10.2.4
  exit 0
fi
printf '%s %s\n' "$PWD" "$*" >> "${NPM_LOG:?}"
case "${1:-}" in
  install)
    if [[ "${FAKE_NPM_FAIL:-}" == "install" ]]; then
      echo 'simulated dependency installation failure' >&2
      exit 41
    fi
    mkdir -p node_modules
    git rev-parse HEAD > node_modules/commit
    ;;
  run)
    if [[ "${2:-}" != "build" ]]; then
      echo "unexpected npm run target: ${2:-}" >&2
      exit 2
    fi
    if [[ "${FAKE_NPM_FAIL:-}" == "build" ]]; then
      echo 'simulated TypeScript build failure' >&2
      exit 42
    fi
    if [[ "${FAKE_NPM_FAIL:-}" == "tracked" ]]; then
      printf 'build-mutated-tracked-file\n' > version.txt
    fi
    mkdir -p dist
    git rev-parse HEAD > dist/commit
    ;;
  *)
    echo "unexpected npm command: $*" >&2
    exit 2
    ;;
esac
EOF_NPM

cat > "$FAKE_BIN/tmux" <<'EOF_TMUX'
#!/usr/bin/env bash
if [[ "${1:-}" == "-V" ]]; then
  echo 'tmux 3.4'
  exit 0
fi
exit 0
EOF_TMUX

chmod +x "$FAKE_BIN/node" "$FAKE_BIN/npm" "$FAKE_BIN/tmux"

prepare_checkout() {
  local checkout="$1"
  mkdir -p "$HOME_DIR/$(basename "$checkout")"
  mkdir -p "$checkout/node_modules" "$checkout/dist"
  printf 'old-dependencies\n' > "$checkout/node_modules/commit"
  printf 'old-build\n' > "$checkout/dist/commit"
  printf 'keep-untracked\n' > "$checkout/local-note.txt"
}

run_failure_case() {
  local case_name="$1"
  local failure="$2"
  local checkout="$TEST_ROOT/$case_name"
  prepare_checkout "$checkout"
  local before_head
  before_head="$(git -C "$checkout" rev-parse HEAD)"
  set +e
  (
    cd "$checkout"
    HOME="$HOME_DIR/$case_name" \
      ZDOTDIR="$HOME_DIR/$case_name" \
      SHELL=/bin/bash \
      PATH="$FAKE_BIN:$PATH" \
      NPM_LOG="$NPM_LOG" \
      FAKE_NPM_FAIL="$failure" \
      ./install.sh --upgrade
  ) > "$TEST_ROOT/$case_name.log" 2>&1
  local status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    echo "$case_name unexpectedly succeeded" >&2
    exit 1
  fi
  local after_head
  after_head="$(git -C "$checkout" rev-parse HEAD)"
  if [[ "$after_head" != "$before_head" ]]; then
    echo "$case_name changed HEAD before the failing dependency/build step" >&2
    cat "$TEST_ROOT/$case_name.log" >&2
    exit 1
  fi
  if [[ "$(cat "$checkout/node_modules/commit")" != 'old-dependencies' ]]; then
    echo "$case_name changed active node_modules on failure" >&2
    exit 1
  fi
  if [[ "$(cat "$checkout/node_modules/tracked.txt")" != 'tracked-dependency' ]]; then
    echo "$case_name changed a tracked dependency on failure" >&2
    exit 1
  fi
  if [[ "$(cat "$checkout/dist/commit")" != 'old-build' ]]; then
    echo "$case_name changed active dist on failure" >&2
    exit 1
  fi
  if [[ -n "$(git -C "$checkout" status --porcelain --untracked-files=no)" ]]; then
    echo "$case_name left the tracked worktree dirty" >&2
    git -C "$checkout" status --short >&2
    exit 1
  fi
  if [[ "$(cat "$checkout/local-note.txt")" != 'keep-untracked' ]]; then
    echo "$case_name changed an unrelated untracked file" >&2
    exit 1
  fi
}

run_failure_case install-fail install
run_failure_case build-fail build
run_failure_case tracked-dirty tracked

SUCCESS_CHECKOUT="$TEST_ROOT/success"
prepare_checkout "$SUCCESS_CHECKOUT"
(
  cd "$SUCCESS_CHECKOUT"
  HOME="$HOME_DIR/success" \
    ZDOTDIR="$HOME_DIR/success" \
    SHELL=/bin/bash \
    PATH="$FAKE_BIN:$PATH" \
    NPM_LOG="$NPM_LOG" \
    FAKE_NPM_FAIL='' \
    ./install.sh --upgrade
) > "$TEST_ROOT/success.log" 2>&1

if [[ "$(git -C "$SUCCESS_CHECKOUT" rev-parse HEAD)" != "$TARGET_HEAD" ]]; then
  echo 'successful upgrade did not reach the fetched target commit' >&2
  exit 1
fi
if [[ "$(git -C "$SUCCESS_CHECKOUT" branch --show-current)" != "$TRACKING_BRANCH" ]]; then
  echo 'successful upgrade changed the active branch' >&2
  exit 1
fi
if [[ "$(cat "$SUCCESS_CHECKOUT/node_modules/commit")" != "$TARGET_HEAD" ]]; then
  echo 'successful upgrade did not activate target dependencies' >&2
  exit 1
fi
if [[ "$(cat "$SUCCESS_CHECKOUT/node_modules/tracked.txt")" != 'tracked-dependency' ]]; then
  echo 'successful upgrade did not preserve the target tracked dependency' >&2
  exit 1
fi
if [[ "$(cat "$SUCCESS_CHECKOUT/dist/commit")" != "$TARGET_HEAD" ]]; then
  echo 'successful upgrade did not activate the target build' >&2
  exit 1
fi
if [[ "$(cat "$SUCCESS_CHECKOUT/local-note.txt")" != 'keep-untracked' ]]; then
  echo 'successful upgrade changed an unrelated untracked file' >&2
  exit 1
fi
if [[ -n "$(git -C "$SUCCESS_CHECKOUT" status --porcelain --untracked-files=no)" ]]; then
  echo 'successful upgrade left tracked files dirty' >&2
  git -C "$SUCCESS_CHECKOUT" status --short >&2
  exit 1
fi

printf 'tracked-dependency-v2\n' > "$PUBLISHER/node_modules/tracked.txt"
git -C "$PUBLISHER" add -f node_modules/tracked.txt
git -C "$PUBLISHER" commit --quiet -m tracked-target
git -C "$PUBLISHER" push --quiet origin "$TRACKING_BRANCH"
TRACKED_TARGET_HEAD="$(git -C "$PUBLISHER" rev-parse HEAD)"

TRACKED_TARGET_CHECKOUT="$TEST_ROOT/tracked-target"
prepare_checkout "$TRACKED_TARGET_CHECKOUT"
set +e
(
  cd "$TRACKED_TARGET_CHECKOUT"
  HOME="$HOME_DIR/tracked-target" \
    ZDOTDIR="$HOME_DIR/tracked-target" \
    SHELL=/bin/bash \
    PATH="$FAKE_BIN:$PATH" \
    NPM_LOG="$NPM_LOG" \
    FAKE_NPM_FAIL='' \
    ./install.sh --upgrade
) > "$TEST_ROOT/tracked-target.log" 2>&1
tracked_target_status=$?
set -e
if [[ "$tracked_target_status" -ne 0 ]]; then
  echo 'tracked dependency upgrade failed' >&2
  cat "$TEST_ROOT/tracked-target.log" >&2
  exit 1
fi

if [[ "$(git -C "$TRACKED_TARGET_CHECKOUT" rev-parse HEAD)" != "$TRACKED_TARGET_HEAD" ]]; then
  echo 'tracked dependency upgrade did not reach the fetched target commit' >&2
  cat "$TEST_ROOT/tracked-target.log" >&2
  exit 1
fi
if [[ "$(cat "$TRACKED_TARGET_CHECKOUT/node_modules/tracked.txt")" != 'tracked-dependency-v2' ]]; then
  echo 'tracked dependency upgrade did not activate the target tracked dependency' >&2
  exit 1
fi
if [[ "$(cat "$TRACKED_TARGET_CHECKOUT/node_modules/commit")" != "$TRACKED_TARGET_HEAD" ]]; then
  echo 'tracked dependency upgrade did not activate the verified dependency tree' >&2
  exit 1
fi
if [[ "$(cat "$TRACKED_TARGET_CHECKOUT/dist/commit")" != "$TRACKED_TARGET_HEAD" ]]; then
  echo 'tracked dependency upgrade did not activate the verified build' >&2
  exit 1
fi
if [[ "$(cat "$TRACKED_TARGET_CHECKOUT/local-note.txt")" != 'keep-untracked' ]]; then
  echo 'tracked dependency upgrade changed an unrelated untracked file' >&2
  exit 1
fi
if [[ -n "$(git -C "$TRACKED_TARGET_CHECKOUT" status --porcelain --untracked-files=no)" ]]; then
  echo 'tracked dependency upgrade left tracked files dirty' >&2
  git -C "$TRACKED_TARGET_CHECKOUT" status --short >&2
  exit 1
fi

printf 'remote-collision\n' > "$PUBLISHER/collision.txt"
git -C "$PUBLISHER" add collision.txt
git -C "$PUBLISHER" commit --quiet -m untracked-collision-target
git -C "$PUBLISHER" push --quiet origin "$TRACKING_BRANCH"

COLLISION_CHECKOUT="$TEST_ROOT/untracked-collision"
prepare_checkout "$COLLISION_CHECKOUT"
printf 'keep-local-collision\n' > "$COLLISION_CHECKOUT/collision.txt"
COLLISION_ORIGINAL_HEAD="$(git -C "$COLLISION_CHECKOUT" rev-parse HEAD)"
set +e
(
  cd "$COLLISION_CHECKOUT"
  HOME="$HOME_DIR/untracked-collision" \
    ZDOTDIR="$HOME_DIR/untracked-collision" \
    SHELL=/bin/bash \
    PATH="$FAKE_BIN:$PATH" \
    NPM_LOG="$NPM_LOG" \
    FAKE_NPM_FAIL='' \
    ./install.sh --upgrade
) > "$TEST_ROOT/untracked-collision.log" 2>&1
collision_status=$?
set -e
if [[ "$collision_status" -eq 0 ]]; then
  echo 'upgrade unexpectedly overwrote an untracked path added by the target' >&2
  exit 1
fi
if [[ "$(git -C "$COLLISION_CHECKOUT" rev-parse HEAD)" != "$COLLISION_ORIGINAL_HEAD" ]]; then
  echo 'untracked collision moved HEAD before merge rejection' >&2
  cat "$TEST_ROOT/untracked-collision.log" >&2
  exit 1
fi
if [[ "$(cat "$COLLISION_CHECKOUT/collision.txt")" != 'keep-local-collision' ]]; then
  echo 'untracked collision content was overwritten' >&2
  exit 1
fi
if [[ "$(cat "$COLLISION_CHECKOUT/node_modules/commit")" != 'old-dependencies' ]] \
  || [[ "$(cat "$COLLISION_CHECKOUT/dist/commit")" != 'old-build' ]]; then
  echo 'untracked collision changed active runtime artifacts' >&2
  exit 1
fi
if [[ -n "$(git -C "$COLLISION_CHECKOUT" status --porcelain --untracked-files=no)" ]]; then
  echo 'untracked collision left tracked files dirty' >&2
  git -C "$COLLISION_CHECKOUT" status --short >&2
  exit 1
fi

SUCCESS_ZSHRC="$HOME_DIR/success/.zshrc"
if [[ ! -f "$SUCCESS_ZSHRC" ]] \
  || ! grep -Fqx "alias cx='$SUCCESS_CHECKOUT/bin/codex-hud'  # codex-hud alias" "$SUCCESS_ZSHRC"; then
  echo 'successful upgrade did not write the cx alias to the isolated ZDOTDIR' >&2
  cat "$SUCCESS_ZSHRC" 2>/dev/null >&2 || true
  exit 1
fi

install_runs="$(grep -c ' install$' "$NPM_LOG" || true)"
build_runs="$(grep -c ' run build$' "$NPM_LOG" || true)"
if [[ "$install_runs" -ne 6 || "$build_runs" -ne 5 ]]; then
  echo "unexpected staged npm counts: install=$install_runs build=$build_runs" >&2
  cat "$NPM_LOG" >&2
  exit 1
fi

echo "test-transactional-upgrade: PASS tracking_branch=$TRACKING_BRANCH install_fail_head_unchanged=1 build_fail_head_unchanged=1 tracked_dirty_head_unchanged=1 success_target=1 tracked_target=1 untracked_collision_head_unchanged=1 install_runs=$install_runs build_runs=$build_runs"
