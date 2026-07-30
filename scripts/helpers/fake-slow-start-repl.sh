#!/usr/bin/env bash
# Models a CLI with a slow startup (banner/trust-dialog era): anything typed
# before the idle footer first appears is consumed by startup — like a real
# CLI's startup dialog eating buffered keystrokes — then a normal marker-led
# reply loop. Drives the claude adapter (marker-based state detection), so the
# session is NOT settled until the footer prints.
sleep 0.7
while IFS= read -r -t 0.05 _swallowed_during_startup; do :; done
printf '  ? for shortcuts\n'
while IFS= read -r line; do
  printf 'reply to: %s\n' "$line"
  printf '  ? for shortcuts\n'
done
