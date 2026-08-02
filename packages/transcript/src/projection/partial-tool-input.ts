const isWhitespace = (character: string): boolean =>
  character === " " || character === "\n" || character === "\r" || character === "\t"

const escapes: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
}

interface Reader {
  readonly input: string
  cursor: number
}

interface Fragment<A> {
  readonly value: A
  readonly complete: boolean
}

const readString = (reader: Reader): Fragment<string> => {
  const { input } = reader
  const length = input.length
  let cursor = reader.cursor + 1
  let value = ""
  while (cursor < length) {
    const character = input[cursor]!
    if (character === '"') {
      reader.cursor = cursor + 1
      return { value, complete: true }
    }
    if (character === "\\") {
      const escaped = input[cursor + 1]
      if (escaped === undefined) break
      if (escaped === "u") {
        const hex = input.slice(cursor + 2, cursor + 6)
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break
        value += String.fromCharCode(parseInt(hex, 16))
        cursor += 6
        continue
      }
      const replacement = escapes[escaped]
      if (replacement === undefined) break
      value += replacement
      cursor += 2
      continue
    }
    value += character
    cursor += 1
  }
  reader.cursor = length
  return { value, complete: false }
}

const scalar = (raw: string): unknown => {
  if (raw === "true") return true
  if (raw === "false") return false
  if (raw === "null") return null
  const numeric = Number(raw)
  return /^-?\d/.test(raw) && Number.isFinite(numeric) ? numeric : undefined
}

const readNested = (reader: Reader): Fragment<unknown> | undefined => {
  const { input } = reader
  const length = input.length
  const start = reader.cursor
  let depth = 0
  while (reader.cursor < length) {
    const character = input[reader.cursor]!
    if (character === '"') {
      if (!readString(reader).complete) return undefined
      continue
    }
    if (character === "{" || character === "[") depth += 1
    else if (character === "}" || character === "]") {
      depth -= 1
      if (depth === 0) {
        reader.cursor += 1
        try {
          return { value: JSON.parse(input.slice(start, reader.cursor)) as unknown, complete: true }
        } catch {
          return undefined
        }
      }
    }
    reader.cursor += 1
  }
  return undefined
}

const readValue = (reader: Reader): Fragment<unknown> | undefined => {
  const character = reader.input[reader.cursor]
  if (character === undefined) return undefined
  if (character === '"') return readString(reader)
  if (character === "{" || character === "[") return readNested(reader)
  const start = reader.cursor
  const length = reader.input.length
  while (
    reader.cursor < length &&
    !isWhitespace(reader.input[reader.cursor]!) &&
    !",}]".includes(reader.input[reader.cursor]!)
  )
    reader.cursor += 1
  if (reader.cursor >= length) return undefined
  const parsed = scalar(reader.input.slice(start, reader.cursor))
  return parsed === undefined ? undefined : { value: parsed, complete: true }
}

const skipWhitespace = (reader: Reader): void => {
  while (reader.cursor < reader.input.length && isWhitespace(reader.input[reader.cursor]!)) reader.cursor += 1
}

export const partialInputRecord = (input: string): Record<string, unknown> => {
  const reader: Reader = { input, cursor: 0 }
  const result: Record<string, unknown> = {}
  skipWhitespace(reader)
  if (input[reader.cursor] !== "{") return result
  reader.cursor += 1
  while (reader.cursor < input.length) {
    skipWhitespace(reader)
    const character = input[reader.cursor]
    if (character === undefined || character === "}") break
    if (character === ",") {
      reader.cursor += 1
      continue
    }
    if (character !== '"') break
    const key = readString(reader)
    if (!key.complete) break
    skipWhitespace(reader)
    if (input[reader.cursor] !== ":") break
    reader.cursor += 1
    skipWhitespace(reader)
    const value = readValue(reader)
    if (value === undefined) break
    result[key.value] = value.value
    if (!value.complete) break
  }
  return result
}
