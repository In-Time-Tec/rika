export interface GrepMatch {
  readonly relativePath: string
  readonly lineNumber: number
  readonly lineContent: string
}
export interface GrepResult {
  readonly items: ReadonlyArray<GrepMatch>
  readonly totalMatched: number
  readonly totalFilesSearched: number
  readonly totalFiles: number
  readonly filteredFileCount: number
  readonly nextCursor: string | null
  readonly regexFallbackError?: string
  readonly deadlineReached?: boolean
}
