const ContextOverflowPatterns: ReadonlyArray<RegExp> = [
  /\bcontext_length_exceeded\b/i,
  /\bmaximum context length\b/i,
  /\bmaximum\b.*\btokens\b/i,
  /\bprompt is too long\b/i,
  /\byour messages resulted in \d+ tokens\b/i,
  /\binput\b.*\bexceed(?:s|ed)?\b.*\bcontext window\b/i,
  /\bcontext window\b.*\bexceed(?:s|ed)?\b/i,
  /\btoken limit\b/i,
]

const NonContextOverflowPatterns: ReadonlyArray<RegExp> = [
  /\brequest_too_large\b/i,
  /\brate_limit(?:_exceeded)?\b/i,
  /\binsufficient_quota\b/i,
]

export const isContextOverflow = (value: unknown): boolean => {
  if (isZeroProgressLengthResponse(value)) return true
  const texts = collectText(value)
  if (texts.some((text) => NonContextOverflowPatterns.some((pattern) => pattern.test(text)))) return false
  return texts.some((text) => ContextOverflowPatterns.some((pattern) => pattern.test(text)))
}

export const isZeroProgressLengthResponse = (value: unknown): boolean =>
  isRecord(value) &&
  value.finish_reason === "length" &&
  typeof value.content === "string" &&
  value.content.trim().length === 0

const collectText = (value: unknown, seen = new WeakSet<object>(), depth = 0): ReadonlyArray<string> => {
  if (depth > 8) return []
  if (typeof value === "string") return [value]
  if (typeof value !== "object" || value === null) return []
  if (seen.has(value)) return []
  seen.add(value)

  const texts: Array<string> = []
  if (value instanceof Error) {
    texts.push(value.message)
    if ("cause" in value) texts.push(...collectText(value.cause, seen, depth + 1))
  }

  for (const entry of Object.values(value)) {
    texts.push(...collectText(entry, seen, depth + 1))
  }

  return texts
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
