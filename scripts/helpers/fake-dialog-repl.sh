#!/usr/bin/env bash
# Emulates the claude adapter's fixture markers well enough to drive the
# facade's mid-turn dialog path without a real CLI: idle footer at boot,
# trust-dialog markers on demand, then an answer line after the operator key.
printf '  ? for shortcuts\n'
while IFS= read -r line; do
  case "$line" in
    DIALOG)
      printf ' Quick safety check: Is this a project you created or one you trust?\n'
      printf ' %s 1. Yes, I trust this folder\n' '❯'
      IFS= read -r _answer
      printf 'dialog answered\n'
      # Emit enough follow-up lines that the two trust-dialog marker lines
      # scroll out of the detector's viewportTail(8) window — this mirrors a
      # real CLI whose response pushes the dialog off-screen, so isAwaitingInput
      # stops matching and the detector re-settles to idle. Append-only on
      # purpose: clearing the screen would break the transcript-diff extraction
      # the facade relies on.
      for i in 1 2 3 4 5 6 7 8; do printf 'settled line %s\n' "$i"; done
      printf '  ? for shortcuts\n'
      ;;
    *)
      printf 'plain reply to: %s\n' "$line"
      printf '  ? for shortcuts\n'
      ;;
  esac
done
