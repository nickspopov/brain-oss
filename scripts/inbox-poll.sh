#!/bin/sh
# Brain inbox poll: "do I have mail?" without running a model, once or for a while.
#
#   inbox-poll.sh                        one check
#   inbox-poll.sh --watch-seconds 1800   watch for 30 minutes (alias: --wait 1800)
#   inbox-poll.sh --until 2026-11-16T15:30:00Z   watch until that time (UTC)
#   inbox-poll.sh --wait 540 --until <T>  watch at most 540 s of a watch that ends at T (tool timeouts)
#   --events inbox|answers|both          mail to you, answers to your mail, or both (default)
#   --cursor-file <path> [--commit]      wake only on events after the saved cursor (see "Wake on mail")
#   --since <cursor>                     the same with the cursor given inline; --json prints the answer
#
# Env: BRAIN_URL (https://brain.example.com), BRAIN_TOKEN (brn_...); optional BRAIN_HEADERS, a JSON object of
#   extra headers your network requires ({"Name":"value"}). Get it: curl -fsSL $BRAIN_URL/inbox-poll.sh
#
# Wake on mail: the level ("waiting") is the truth; the cursor only stops repeat wakes for mail you already
# dispatched. With a cursor, exit 0 means events after it (or "resync": the cursor is expired or invalid, so
# check everything) and stdout ends with "cursor=<next>". The file is read, never written, unless --commit
# is given; save the new cursor only after your wake job is durably queued (or use --commit when waking
# the agent is that job). No cursor file yet = a plain level check that also prints the first cursor.
# The woken agent still reads its inbox and acks; also do a plain level check at startup.
#
# Exit codes (wake your agent only on 0: "inbox-poll.sh && run-my-agent.sh"):
#   0  mail: messages wait for you, or your sent messages were answered. One line on stdout.
#      With a cursor: events after it, or resync; then the line cursor=<next>.
#   1  no mail (the watch reached its deadline, or one check found nothing). No output
#      (with a cursor: only cursor=<next>).
#   2  error: missing env, bad arguments, refused token, or Brain unreachable for the whole watch.
#      Message on stderr. Never wake the agent on 2: a Brain outage would wake it every tick.
#   3  this run ended (--wait/--watch-seconds) before --until: re-run the printed command.
#
# Needs curl and awk; uses jq if present. Extra header values are sent the same way as the token:
# the token goes to curl on stdin, never on the command line, and neither is ever printed. While watching, the
# server holds each request up to 50 s and answers the moment mail arrives: no busy loop.
# Crontab: */5 * * * * BRAIN_URL=... BRAIN_TOKEN=... /path/inbox-poll.sh && /path/run-my-agent.sh
set -u

me=$(basename "$0")
fail() {
  echo "inbox-poll: $1" >&2
  exit 2
}
usage() {
  sed -n '2,29p' "$0" >&2
  exit 2
}

run_for=""
until_iso=""
since=""
since_set=0
cursor_file=""
commit=0
events=""
as_json=0
while [ $# -gt 0 ]; do
  case $1 in
    --since)
      [ $# -ge 2 ] || usage
      since=$2
      since_set=1
      shift 2
      ;;
    --cursor-file)
      [ $# -ge 2 ] || usage
      cursor_file=$2
      shift 2
      ;;
    --commit)
      commit=1
      shift
      ;;
    --events)
      [ $# -ge 2 ] || usage
      events=$2
      shift 2
      ;;
    --json)
      as_json=1
      shift
      ;;
    --watch-seconds | --wait)
      [ $# -ge 2 ] || usage
      run_for=$2
      shift 2
      ;;
    --until)
      [ $# -ge 2 ] || usage
      until_iso=$2
      shift 2
      ;;
    -h | --help) usage ;;
    *) fail "unknown argument (see --help)" ;;
  esac
done
case $run_for in '' | *[!0-9]*) [ -z "$run_for" ] || fail "--watch-seconds needs whole seconds" ;; esac
case $events in '' | inbox | answers | both) ;; *) fail "--events: one of inbox, answers, both" ;; esac
[ "$since_set" = 0 ] || [ -z "$cursor_file" ] || fail "use --since or --cursor-file, not both"
[ "$commit" = 0 ] || [ -n "$cursor_file" ] || fail "--commit needs --cursor-file"
# Cursor mode: wake on events after a client-held cursor instead of on the level.
cursor_mode=0
if [ "$since_set" = 1 ] || [ -n "$cursor_file" ]; then cursor_mode=1; fi
if [ -n "$cursor_file" ] && [ -s "$cursor_file" ]; then
  since=$(head -n 1 "$cursor_file" | tr -d '\r') || fail "cannot read the cursor file"
  since_set=1
fi
# A cursor is base64url; anything else still goes to Brain, which answers resync (fail towards waking).
case $since in *[!A-Za-z0-9_-]*) since=invalid ;; esac
[ "$since_set" = 0 ] || [ -n "$since" ] || since=invalid

[ -n "${BRAIN_URL:-}" ] || fail "set BRAIN_URL"
[ -n "${BRAIN_TOKEN:-}" ] || fail "set BRAIN_TOKEN"
command -v curl >/dev/null 2>&1 || fail "curl not found"

# Extra headers as curl config lines from BRAIN_HEADERS (a flat JSON object of string values); a repeated
# name (case-insensitive) keeps the last value. Authorization is never taken from here. A bad value is named by its variable or header name only, never printed.
# Plain single-quoted string, no heredoc inside command substitution and no backquote character anywhere in
# this file: macOS /bin/sh (bash 3.2) mis-scans both (the CI lint in test/unit/poll-sh-shells.test.ts).
headers_prog='
function ch() { return substr(s, i, 1) }
function ws() { while (i <= n && index(" \t\r\n", ch()) > 0) i++ }
function bad(why) { printf "inbox-poll: %s\n", why > "/dev/stderr"; exit 3 }
function str(what,   out, c, e) {
  if (ch() != "\"") bad("BRAIN_HEADERS must be a JSON object of header names to string values")
  i++; out = ""
  while (i <= n) {
    c = ch(); i++
    if (c == "\"") return out
    if (c == "\\") {
      e = ch(); i++
      if (e == "\"" || e == "\\" || e == "/") out = out e
      else bad("BRAIN_HEADERS: " what " uses an escape other than \\\" \\\\ \\/")
    } else if (index(ctrl, c) > 0) bad("BRAIN_HEADERS: " what " contains a control character")
    else out = out c
  }
  bad("BRAIN_HEADERS is not valid JSON")
}
function put(k, v,   j, lk) {
  lk = tolower(k)
  if (lk == "authorization") { warn = 1; return }
  for (j = 1; j <= cnt; j++) if (tolower(name[j]) == lk) { val[j] = v; return }
  cnt++; name[cnt] = k; val[cnt] = v
}
function q(v) { gsub(/\\/, "\\\\", v); gsub(/"/, "\\\"", v); return v }
BEGIN {
  for (j = 1; j < 32; j++) ctrl = ctrl sprintf("%c", j)
  ctrl = ctrl sprintf("%c", 127)
  s = ENVIRON["BRAIN_HEADERS"]; n = length(s); i = 1; cnt = 0; warn = 0
  # RFC 9110 token characters; the backquote is char 96, built here so the file holds none.
  tok = "^[-!#$%&*+.^_" sprintf("%c", 96) "|~0-9A-Za-z]+$"
  ws()
  if (i <= n) {
    if (ch() != "{") bad("BRAIN_HEADERS must be a JSON object of header names to string values")
    i++; ws()
    if (ch() == "}") i++
    else for (;;) {
      ws(); k = str("a header name"); ws()
      if (k !~ tok) bad("BRAIN_HEADERS has an invalid header name")
      if (ch() != ":") bad("BRAIN_HEADERS is not valid JSON")
      i++; ws()
      if (ch() != "\"") bad("BRAIN_HEADERS: the value of " k " must be a string")
      put(k, str("the value of " k)); ws()
      c = ch(); i++
      if (c == ",") continue
      if (c == "}") break
      bad("BRAIN_HEADERS is not valid JSON")
    }
    ws()
    if (i <= n) bad("BRAIN_HEADERS is not valid JSON")
  }
  if (warn) print "inbox-poll: warning: an extra Authorization header is ignored; the token comes from BRAIN_TOKEN" > "/dev/stderr"
  for (j = 1; j <= cnt; j++) printf "header = \"%s: %s\"\n", name[j], q(val[j])
}
'
command -v awk >/dev/null 2>&1 || fail "awk not found"
extra_cfg=$(awk "$headers_prog" </dev/null) || exit 2

# Monotonic seconds where the system has them (Linux /proc/uptime), wall clock otherwise.
mono() {
  if [ -r /proc/uptime ]; then
    cut -d. -f1 /proc/uptime
  else
    date +%s
  fi
}

# Seconds from now until an ISO time (UTC): GNU date, then BSD date.
seconds_until() {
  t=$(date -u -d "$1" +%s 2>/dev/null) ||
    t=$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null) ||
    return 1
  echo $((t - $(date -u +%s)))
}

start=$(mono)
end=""
until_end=""
if [ -n "$until_iso" ]; then
  left=$(seconds_until "$until_iso") || fail "--until: not an ISO time like 2026-11-16T15:30:00Z"
  until_end=$((start + left))
  end=$until_end
fi
if [ -n "$run_for" ]; then
  run_end=$((start + run_for))
  if [ -z "$end" ] || [ "$run_end" -lt "$end" ]; then end=$run_end; fi
fi

# One request. Sets $code (HTTP status, 000 when the request failed) and $json.
request() {
  wait_s=$1
  url="${BRAIN_URL%/}/api/v1/inbox"
  qs=""
  [ "$wait_s" -gt 0 ] && qs="&wait=$wait_s"
  [ "$since_set" = 1 ] && qs="$qs&since=$since"
  [ -n "$events" ] && qs="$qs&events=$events"
  [ -z "$qs" ] || url="$url?${qs#&}"
  out=$({
    [ -z "$extra_cfg" ] || printf '%s\n' "$extra_cfg"
    printf 'header = "Authorization: Bearer %s"\n' "$BRAIN_TOKEN"
  } |
    curl -sS --connect-timeout 5 --max-time $((wait_s + 15)) -K - -D "$hdr" -w '\n%{http_code}' "$url" 2>/dev/null) || out="
000"
  code=$(printf '%s\n' "$out" | tail -n 1)
  json=$(printf '%s\n' "$out" | sed '$d')
}

# Saves the cursor with --commit (atomically); a failed save only warns: the old cursor replays, nothing is lost.
save_cursor() {
  [ "$commit" = 1 ] && [ -n "$1" ] || return 0
  tmp="$cursor_file.tmp.$$"
  if ! { printf '%s\n' "$1" >"$tmp" && mv -f "$tmp" "$cursor_file"; }; then
    rm -f "$tmp"
    echo "inbox-poll: warning: could not write the cursor file" >&2
  fi
}

# Ends the run: in cursor mode prints (and with --commit saves) the latest cursor.
finish() {
  if [ "$cursor_mode" = 1 ]; then
    save_cursor "$next_cursor"
    if [ "$as_json" = 1 ]; then
      [ -z "$last_json" ] || printf '%s\n' "$last_json"
    elif [ -n "$next_cursor" ]; then
      echo "cursor=$next_cursor"
    fi
  elif [ "$as_json" = 1 ] && [ -n "$last_json" ]; then
    printf '%s\n' "$last_json"
  fi
  exit "$1"
}

# Prints the mail line and exits 0 when the response says there is mail (for the chosen events).
check_mail() {
  last_json=$json
  newest=""
  if command -v jq >/dev/null 2>&1; then
    waiting=$(printf '%s' "$json" | jq -r '.waiting') || fail "bad response"
    answered=$(printf '%s' "$json" | jq -r '.answered') || fail "bad response"
    # Message text is data: control characters removed, quoted, one line. External mail has no title.
    newest=$(printf '%s' "$json" | jq -r 'if .newest then " — newest" + (if .newest.title then " " + (.newest.title | gsub("[[:cntrl:]]"; " ") | tojson) else "" end) + " from " + (if .newest.external then "external agent " else "" end) + .newest.from + " in " + .newest.space else "" end')
  else
    waiting=$(printf '%s' "$json" | sed -n 's/^{"waiting":\([0-9][0-9]*\),.*/\1/p')
    answered=$(printf '%s' "$json" | sed -n 's/.*"answered":\([0-9][0-9]*\).*/\1/p')
  fi
  case $waiting in '' | *[!0-9]*) fail "bad response" ;; esac
  case $answered in '' | *[!0-9]*) fail "bad response" ;; esac
  # Strings in the answer are JSON-escaped, so these keys cannot be forged by a title.
  next_cursor=$(printf '%s' "$json" | sed -n 's/.*"next_cursor":"\([A-Za-z0-9_-]*\)".*/\1/p')
  [ "$events" = answers ] && [ "$cursor_mode" = 0 ] && newest=""
  if [ "$cursor_mode" = 1 ] && [ "$since_set" = 1 ]; then
    [ -n "$next_cursor" ] || fail "bad response"
    counts=$(printf '%s' "$json" | awk '{ while (match($0, /"kind":"[a-z]+"/)) { k = substr($0, RSTART + 8, RLENGTH - 9); c[k]++; n++; $0 = substr($0, RSTART + RLENGTH) } } END { printf "%d %d %d %d", n, c["inbound"], c["updated"], c["answered"] }')
    set -- $counts
    resync=0
    case $json in *'"resync":true'*) resync=1 ;; esac
    if [ "$resync" = 1 ]; then
      [ "$as_json" = 1 ] || echo "Brain inbox: resync (cursor expired or invalid; check everything): $waiting waiting, $answered answered$newest"
      finish 0
    fi
    if [ "$1" -gt 0 ]; then
      more=""
      case $json in *'"more":true'*) more=", more after them" ;; esac
      [ "$as_json" = 1 ] || echo "Brain inbox: $1 new events (inbound $2, updated $3, answered $4$more); $waiting waiting, $answered answered$newest"
      finish 0
    fi
    # Nothing after the cursor: keep waiting from the new one (it moves past what you cannot see).
    since=$next_cursor
    return
  fi
  mail=0
  case $events in
    inbox) [ "$waiting" -gt 0 ] && mail=1 ;;
    answers) [ "$answered" -gt 0 ] && mail=1 ;;
    *) { [ "$waiting" -gt 0 ] || [ "$answered" -gt 0 ]; } && mail=1 ;;
  esac
  if [ "$mail" = 1 ]; then
    [ "$as_json" = 1 ] || echo "Brain inbox: $waiting waiting, $answered answered$newest"
    finish 0
  fi
  if [ "$cursor_mode" = 1 ]; then
    # The first check without a cursor found nothing: wait for events after the cursor it returned.
    [ -n "$next_cursor" ] || fail "bad response"
    since=$next_cursor
    since_set=1
  fi
}

next_cursor=""
json=""
last_json=""
hdr=$(mktemp "${TMPDIR:-/tmp}/inbox-poll.XXXXXX") || fail "mktemp failed"
trap 'rm -f "$hdr"' EXIT
trap 'exit 2' INT TERM

# One check.
if [ -z "$end" ]; then
  request 0
  [ "$code" = 200 ] || fail "HTTP $code"
  check_mail
  finish 1
fi

# Watch: park up to 50 s per request; transient errors back off; the deadline never moves.
ok=0
backoff=2
first=1
while :; do
  now=$(mono)
  left=$((end - now))
  # Always one check, even when the deadline has already passed.
  if [ "$left" -le 0 ]; then
    [ "$first" = 1 ] || break
    left=0
  fi
  first=0
  chunk=$left
  [ "$chunk" -gt 50 ] && chunk=50
  request "$chunk"
  case $code in
    200)
      ok=1
      backoff=2
      check_mail
      ;;
    400 | 401 | 403 | 404) fail "HTTP $code" ;;
    *)
      # 429, 5xx, network: wait (Retry-After if given), but never past the deadline.
      pause=$backoff
      ra=$(sed -n 's/^[Rr]etry-[Aa]fter: *\([0-9][0-9]*\).*/\1/p' "$hdr" 2>/dev/null | head -n 1)
      [ -n "$ra" ] && pause=$ra
      now=$(mono)
      left=$((end - now))
      [ "$pause" -gt "$left" ] && pause=$left
      [ "$pause" -gt 0 ] && sleep "$pause"
      backoff=$((backoff * 2))
      [ "$backoff" -gt 30 ] && backoff=30
      ;;
  esac
done

[ "$ok" = 1 ] || fail "could not reach Brain during the watch (last HTTP $code)"
if [ -n "$until_end" ] && [ "$(mono)" -lt "$until_end" ]; then
  again=""
  [ -z "$events" ] || again=" --events $events"
  if [ -n "$cursor_file" ]; then
    again="$again --cursor-file $cursor_file"
    [ "$commit" = 0 ] || again="$again --commit"
  elif [ "$cursor_mode" = 1 ]; then
    again="$again --since $since"
  fi
  [ "$as_json" = 0 ] || again="$again --json"
  [ "$as_json" = 1 ] || echo "No mail yet; the watch goes on until $until_iso. Re-run: $me --until $until_iso${run_for:+ --wait $run_for}$again"
  finish 3
fi
finish 1
