const boundedPrefix = (text: string, limit: number): string => {
  const prefix = text.slice(0, Math.max(0, limit))
  const final = prefix.charCodeAt(prefix.length - 1)
  return final >= 0xd800 && final <= 0xdbff ? prefix.slice(0, -1) : prefix
}

const boundedText = <Result extends { readonly text: string; readonly truncated: boolean }>(
  text: string,
  limit: number,
): Result => ({ text: boundedPrefix(text, limit), truncated: text.length > limit }) as Result

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
  boundedPrefix,
  boundedText,
  boundedDiff,
  lineWindow,
  replaceText,
}
