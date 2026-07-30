#!/usr/bin/env bash
# Deterministic fake REPL for facade tests (generic profile). It models a
# COALESCING CLI — one that ingests a whole submitted prompt (even a multi-line
# pasted one) as a single turn, which is what facade seeding targets and how the
# real claude/codex/etc. binaries behave via bracketed paste (an assumption
# about those external tools, not something a bash `read` loop demonstrates).
# The facade writes a seed preamble + the user text in one multi-line write,
# landing here as a burst; we drain the burst and reply ONCE to its last
# non-empty line. The drain window (120ms) is bounded on BOTH sides: it must
# exceed promptWriter's SUBMIT_DELAY_MS (50ms) — the final line of a logical
# turn is only completed by the delayed submit \r, and expiring mid-gap
# would split one turn into two replies — and it must stay below the tests'
# QUIESCENCE_MS (200ms), or the silent drain reads as a settled turn before
# the reply prints. Both margins are ~70-80ms so loaded-CI scheduling jitter
# can't cross either bound. (A genuinely line-oriented raw CLI would instead
# reply per line — a documented limitation of the generic/raw profile as a
# stateful backend; see turnRunner.)
# The reply counter is session-lifetime, so tests can tell whether two turns hit
# the same session (counter continues) or a fresh seeded one (counter restarts).
# The seed lines are still echoed by the PTY, so a test can confirm the seed
# text reached the process.
n=0
while IFS= read -r first; do
  lines=("$first")
  # Drain the rest of this burst (SUBMIT_DELAY_MS < window < QUIESCENCE_MS).
  while IFS= read -r -t 0.12 more; do lines+=("$more"); done
  last=""
  for l in "${lines[@]}"; do [ -n "$l" ] && last="$l"; done
  [ -z "$last" ] && continue
  n=$((n+1))
  case "$last" in
    PARA) printf 'first paragraph\n\nsecond paragraph\n' ;;
    SPAM) i=0; while [ "$i" -lt 12 ]; do printf 'spam %d\n' "$i"; sleep 0.1; i=$((i+1)); done; printf 'spam done\n' ;;
    EXIT) exit 0 ;;
    *) printf 'reply %d to: %s\n' "$n" "$last" ;;
  esac
done
