// Shared multiline-safe prompt writer (spec: "Multiline input").
// Order of strategies for text containing '\n':
//   1. adapter.multiline === 'raw'      → legacy pass-through (generic only)
//   2. bracketed paste (default)        → \x1b[200~ … \x1b[201~
//   3. adapter.newlineKey               → join lines with the key sequence
//   4. reject                           → MultilineUnsupportedError
export class MultilineUnsupportedError extends Error {}

export function writePromptText(session, adapter, text) {
  if (!text.includes('\n')) { session.write(text); return; }
  if (adapter.multiline === 'raw') { session.write(text); return; }
  if (adapter.supportsBracketedPaste !== false) {
    session.write(`\x1b[200~${text}\x1b[201~`);
    return;
  }
  if (adapter.newlineKey) { session.write(text.split('\n').join(adapter.newlineKey)); return; }
  throw new MultilineUnsupportedError('multiline input not supported by this profile');
}

// Gap between the prompt text write and the submit keystroke. Codex 0.134.0
// (observed live 2026-07-24) intermittently coalesces a same-burst text+\r
// into one pasted blob: the \r becomes a composer newline instead of a
// submit and the prompt strands unsent with 0 tokens used. 50ms is
// imperceptible per turn and empirically reliable.
export const SUBMIT_DELAY_MS = 50;

export async function writeAndSubmitPrompt(session, adapter, text, submit = true) {
  writePromptText(session, adapter, text);
  if (!submit) return;
  await new Promise((r) => setTimeout(r, SUBMIT_DELAY_MS));
  session.write(adapter.keySeq('submit'));
}
