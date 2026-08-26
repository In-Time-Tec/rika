import { Schema } from "effect"

export const Diagnostic = Schema.Struct({
  _tag: Schema.Literals(["PathOutsideWorkspace", "ReferenceNotFound", "ReferenceReadFailed"]),
  path: Schema.String,
  message: Schema.String,
})
export type Diagnostic = typeof Diagnostic.Type

export const Source = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["guidance", "reference"]),
  content: Schema.String,
  digest: Schema.String,
})
export type Source = typeof Source.Type

export interface Result {
  readonly sources: ReadonlyArray<Source>
  readonly diagnostics: ReadonlyArray<Diagnostic>
  readonly digest: string
}

export interface Input {
  readonly workspace: string
  readonly targetPaths?: ReadonlyArray<string>
  readonly references?: ReadonlyArray<string>
}
