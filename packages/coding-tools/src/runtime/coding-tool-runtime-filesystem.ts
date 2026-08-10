const encoder = new TextEncoder()

const byteLength = (text: string): number => encoder.encode(text).byteLength

const boundedPrefix = (text: string, limit: number): string => {
  const budget = Math.max(0, limit)
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (byteLength(text.slice(0, middle)) <= budget) low = middle
    else high = middle - 1
  }
  const prefix = text.slice(0, low)
  const final = prefix.charCodeAt(prefix.length - 1)
  return final >= 0xd800 && final <= 0xdbff ? prefix.slice(0, -1) : prefix
}

const boundedText = <Result extends { readonly text: string; readonly truncated: boolean }>(
  text: string,
  limit: number,
  recovery: string,
  knownTotalBytes?: number,
): Result => {
  const totalBytes = knownTotalBytes ?? byteLength(text)
  if (totalBytes <= limit && byteLength(text) === totalBytes) return { text, truncated: false } as Result
  const longestMarker = `[truncated: kept first ${totalBytes} of ${totalBytes} bytes — ${recovery}]`
  const kept = boundedPrefix(text, Math.max(0, limit - byteLength(longestMarker) - 1))
  const keptBytes = byteLength(kept)
  const marker = `[truncated: kept first ${keptBytes} of ${totalBytes} bytes — ${recovery}]`
  const separator = kept.length === 0 || kept.endsWith("\n") ? "" : "\n"
  return { text: `${kept}${separator}${marker}`, truncated: true } as Result
}

const boundedDiff = (patch: string | undefined): { readonly diff?: string } =>
  patch === undefined ? {} : { diff: patch }

const lineWindow = (text: string, start: number, end: number): string =>
  text
    .split("\n")
    .slice(start - 1, end)
    .map((line, index) => `${start + index}: ${line}`)
    .join("\n")

const replaceText = (content: string, oldText: string, newText: string, replaceAll = false): string =>
  replaceAll
    ? content.split(oldText).join(newText)
    : content.slice(0, content.indexOf(oldText)) + newText + content.slice(content.indexOf(oldText) + oldText.length)

export const RuntimeFilesystem = {
  byteLength,
  boundedPrefix,
  boundedText,
  boundedDiff,
  lineWindow,
  replaceText,
}
