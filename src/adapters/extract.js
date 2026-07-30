// src/adapters/extract.js
// Shared transcript cleaner for extractResponse (all real-CLI adapters).
// Phase 1 dropped ALL blank lines, collapsing multi-paragraph replies into a
// run-on block; the facade returns this text to API clients, so paragraph
// structure must survive. Rules: drop chrome lines entirely; collapse runs of
// blank lines to a single blank; trim leading/trailing blanks; finally strip
// the adapter's per-block transcript marker.
export function cleanTranscript(lines, { chrome = [], blockMarker = null } = {}) {
  const kept = lines.filter((l) => !chrome.some((re) => re.test(l)));
  const out = [];
  let pendingBlank = false;
  for (const l of kept) {
    if (l.trim() === '') { pendingBlank = out.length > 0; continue; }
    if (pendingBlank) out.push('');
    pendingBlank = false;
    out.push(l);
  }
  let text = out.join('\n');
  if (blockMarker) text = text.replace(blockMarker, '');
  return text.trim();
}
