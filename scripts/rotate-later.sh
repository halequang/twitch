#!/usr/bin/env bash
#
# Run the rental password rotation ONCE, after a delay.
#
#   scripts/rotate-later.sh              # in 1 hour, --db --remote --force
#   scripts/rotate-later.sh 30m          # in 30 minutes
#   scripts/rotate-later.sh 2h -- --yes  # in 2 hours, with --yes instead of --force
#   scripts/rotate-later.sh --status     # is one pending? when does it fire?
#   scripts/rotate-later.sh --cancel     # call it off
#
# The job is detached with nohup, so closing the terminal does not kill it. It is
# NOT launchd: this is a one-shot, and a LaunchAgent would need removing again
# afterwards. For a recurring job see ~/Library/LaunchAgents/shop.fungaming.rotate-passwords.plist.
#
# Two things this handles that a bare `sleep X && python ...` does not:
#
#   1. launchd/cron-style PATH. steam_change_password.py shells out to
#      `npx wrangler` for D1, and node here comes from nvm — a directory that is
#      not on any default PATH. A detached shell that inherits a trimmed PATH
#      fails at the first database read.
#   2. A lock. Two rotations running at once would drive two Chrome sessions at
#      the same accounts, and the loser would write a password the winner already
#      replaced. The lock is an atomic mkdir, so a second run refuses instead.
#
# Caveat worth knowing: `sleep` does not advance while the Mac is asleep, so a
# sleeping machine fires the job late. Prefix with `caffeinate -i` if it has to
# land on time.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The interpreter that actually has selenium — not necessarily `python3` on PATH.
PYTHON="${ROTATE_PYTHON:-/Library/Frameworks/Python.framework/Versions/3.11/bin/python3}"
LOG="${ROTATE_LOG:-$HOME/Library/Logs/fungaming-rotate-once.log}"
STATE="${TMPDIR:-/tmp}/fungaming-rotate-later"
PIDFILE="$STATE.pid"
WHENFILE="$STATE.when"
LOCKDIR="$STATE.lock"

# "1h" / "30m" / "90s" / "3600" -> seconds
parse_delay() {
  local raw="$1" n unit
  n="${raw%[smhSMH]}"
  unit="${raw#"$n"}"
  [[ "$n" =~ ^[0-9]+$ ]] || { echo "bad delay: $raw (try 45m, 2h, 3600)" >&2; exit 2; }
  # `${unit,,}` is bash 4+; macOS ships bash 3.2, so lowercase with tr instead.
  unit="$(printf '%s' "$unit" | tr '[:upper:]' '[:lower:]')"
  case "$unit" in
    h) echo $((n * 3600)) ;;
    m) echo $((n * 60)) ;;
    s|"") echo "$n" ;;
    *) echo "bad delay unit: $unit" >&2; exit 2 ;;
  esac
}

pending_pid() {
  [[ -f "$PIDFILE" ]] || return 1
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && { echo "$pid"; return 0; }
  return 1
}

case "${1:-}" in
  --status)
    if pid="$(pending_pid)"; then
      echo "pending: pid $pid, fires at $(cat "$WHENFILE" 2>/dev/null || echo '?')"
    else
      echo "nothing pending."
    fi
    [[ -d "$LOCKDIR" ]] && echo "a rotation is RUNNING right now (lock held: $LOCKDIR)"
    # Match the python invocation, not this wrapper — the wrapper's own command
    # line contains the script name too, and printing it dumps the whole body.
    if pgrep -f 'python3 scripts/steam_change_password.py' >/dev/null 2>&1; then
      echo "rotation in progress:"
      pgrep -fl 'python3 scripts/steam_change_password.py' | cut -c1-120 | sed 's/^/  /'
    fi
    exit 0
    ;;
  --cancel)
    if pid="$(pending_pid)"; then
      kill "$pid" && echo "cancelled pid $pid (was due $(cat "$WHENFILE" 2>/dev/null || echo '?'))"
      rm -f "$PIDFILE" "$WHENFILE"
    else
      echo "nothing pending to cancel."
      rm -f "$PIDFILE" "$WHENFILE"
    fi
    exit 0
    ;;
  -h|--help)
    sed -n '3,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

DELAY_RAW="${1:-1h}"
shift || true
# Everything after `--` replaces the default rotation flags.
[[ "${1:-}" == "--" ]] && shift || true
ROTATE_ARGS=("$@")
[[ ${#ROTATE_ARGS[@]} -eq 0 ]] && ROTATE_ARGS=(--db --remote --force)

DELAY="$(parse_delay "$DELAY_RAW")"

if pid="$(pending_pid)"; then
  echo "A rotation is already scheduled (pid $pid, fires $(cat "$WHENFILE" 2>/dev/null || echo '?'))." >&2
  echo "Cancel it first:  scripts/rotate-later.sh --cancel" >&2
  exit 1
fi

[[ -x "$PYTHON" ]] || { echo "python not found: $PYTHON (set ROTATE_PYTHON)" >&2; exit 1; }

# node/npx come from nvm; resolve it now, while a normal PATH is still in scope.
NODE_BIN="$(dirname "$(command -v node 2>/dev/null || echo /usr/local/bin/node)")"
RUN_PATH="$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

WHEN="$(date -v+"${DELAY}"S '+%H:%M:%S %d/%m/%Y' 2>/dev/null || date -d "+${DELAY} seconds" '+%H:%M:%S %d/%m/%Y')"

mkdir -p "$(dirname "$LOG")"
nohup bash -c '
  sleep "$1"; shift
  repo="$1"; shift
  py="$1"; shift
  runpath="$1"; shift
  lock="$1"; shift
  # Atomic: mkdir fails if another rotation already holds it.
  if ! mkdir "$lock" 2>/dev/null; then
    echo "[$(date "+%F %T")] another rotation holds the lock ($lock) — skipping this run."
    exit 0
  fi
  trap "rmdir \"$lock\" 2>/dev/null" EXIT
  cd "$repo" || exit 1
  echo "[$(date "+%F %T")] starting: $py scripts/steam_change_password.py $*"
  PATH="$runpath" "$py" scripts/steam_change_password.py "$@"
  echo "[$(date "+%F %T")] finished with status $?"
' _ "$DELAY" "$REPO" "$PYTHON" "$RUN_PATH" "$LOCKDIR" "${ROTATE_ARGS[@]}" >>"$LOG" 2>&1 &

PID=$!
echo "$PID" >"$PIDFILE"
echo "$WHEN" >"$WHENFILE"

printf 'scheduled  pid %s\n' "$PID"
printf 'fires at   %s   (in %s)\n' "$WHEN" "$DELAY_RAW"
printf 'command    %s scripts/steam_change_password.py %s\n' "$PYTHON" "${ROTATE_ARGS[*]}"
printf 'log        %s\n' "$LOG"
printf 'cancel     scripts/rotate-later.sh --cancel\n'
