export interface GlobOptions {
  readonly pageIndex?: number
  readonly pageSize?: number
}
export interface SearchOptions {
  readonly pageSize?: number
}
export interface GrepOptions {
  readonly mode?: "plain" | "regex"
  readonly smartCase?: boolean
  readonly maxMatchesPerFile?: number
  readonly pageSize?: number
  readonly cursor?: string | null
}
export interface PathItem {
  readonly relativePath: string
  readonly fileName: string
}
export interface SearchResult {
  readonly items: ReadonlyArray<PathItem>
  readonly scores: ReadonlyArray<number>
  readonly totalMatched: number
  readonly totalFiles: number
}
