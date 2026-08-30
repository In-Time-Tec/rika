import type { GlobOptions, PathItem, SearchOptions, SearchResult } from "./options"

const globExpression = (pattern: string): RegExp => {
  let expression = "^"
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!
    if (character === "*") {
      if (pattern[index + 1] !== "*") {
        expression += "[^/]*"
        continue
      }
      index += 1
      if (pattern[index + 1] === "/") {
        index += 1
        expression += "(?:.*/)?"
      } else expression += ".*"
      continue
    }
    if (character === "?") {
      expression += "[^/]"
      continue
    }
    if (character === "[") {
      const closing = pattern.indexOf("]", index + 1)
      if (closing >= 0) {
        const content = pattern.slice(index + 1, closing)
        expression += `[${content.startsWith("!") ? `^${content.slice(1)}` : content}]`
        index = closing
        continue
      }
    }
    expression += /[\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character
  }
  return new RegExp(`${expression}$`)
}

const pathItem = (relativePath: string): PathItem => ({
  relativePath,
  fileName: relativePath.includes("/") ? relativePath.slice(relativePath.lastIndexOf("/") + 1) : relativePath,
})

const levenshtein = (left: string, right: string): number => {
  if (left === right) return 0
  if (left.length === 0) return right.length
  if (right.length === 0) return left.length
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  const current = Array.from({ length: right.length + 1 }, () => 0)
  for (let i = 0; i < left.length; i += 1) {
    current[0] = i + 1
    for (let j = 0; j < right.length; j += 1) {
      const cost = left[i] === right[j] ? 0 : 1
      current[j + 1] = Math.min(current[j]! + 1, previous[j + 1]! + 1, previous[j]! + cost)
    }
    for (let j = 0; j <= right.length; j += 1) previous[j] = current[j]!
  }
  return previous[right.length]!
}

const fuzzyScore = (query: string, relativePath: string): number => {
  const normalizedQuery = query.toLowerCase()
  const normalizedPath = relativePath.toLowerCase()
  const fileName = pathItem(normalizedPath).fileName
  if (normalizedPath === normalizedQuery) return 1_000
  if (fileName === normalizedQuery) return 950
  if (normalizedPath.endsWith(normalizedQuery)) return 900
  if (fileName.includes(normalizedQuery)) return 850 - (fileName.length - normalizedQuery.length)
  if (normalizedPath.includes(normalizedQuery)) return 700 - (normalizedPath.length - normalizedQuery.length)
  const basenameQuery = pathItem(normalizedQuery).fileName
  const distance = Math.min(
    levenshtein(normalizedQuery, normalizedPath),
    levenshtein(normalizedQuery, fileName),
    levenshtein(basenameQuery, fileName),
  )
  const limit = Math.max(basenameQuery.length, fileName.length, 1)
  if (distance > Math.ceil(limit * 0.5)) return Number.NEGATIVE_INFINITY
  return 500 - distance * 40 - Math.abs(fileName.length - basenameQuery.length)
}

const paginatePaths = (relativePaths: ReadonlyArray<string>, options?: GlobOptions | SearchOptions): SearchResult => {
  const pageSize = Math.max(1, options?.pageSize ?? 50)
  const pageIndex = options !== undefined && "pageIndex" in options ? Math.max(0, options.pageIndex ?? 0) : 0
  const page = relativePaths.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize)
  const items = page.map(pathItem)
  return {
    items,
    scores: items.map(() => 1),
    totalMatched: relativePaths.length,
    totalFiles: relativePaths.length,
  }
}

export const Ranking = { globExpression, pathItem, fuzzyScore, paginatePaths }
