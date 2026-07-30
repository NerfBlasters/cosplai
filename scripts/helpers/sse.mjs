// Parse a fetch() Response carrying an SSE stream into ordered frames.
// data is left as the raw string so tests can assert on '[DONE]' as-is.
export async function readSse(response) {
  const text = await response.text();
  const frames = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    let event = null;
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
    }
    if (event !== null || dataLines.length) frames.push({ event, data: dataLines.join('\n') });
  }
  return frames;
}
