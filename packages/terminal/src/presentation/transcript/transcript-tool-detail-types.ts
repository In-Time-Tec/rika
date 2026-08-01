export interface PathTarget {
  readonly path: string
  readonly line?: number
  readonly column?: number
}
export interface ToolDetail {
  readonly block: number
  readonly label: string
  readonly summary: ToolSummary
  readonly target?: PathTarget
}
export interface ToolSummary {
  readonly primary: string
  readonly secondary?: string
}
