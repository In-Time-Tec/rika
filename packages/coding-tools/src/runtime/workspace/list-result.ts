import { Schema } from "effect"

export interface WorkspaceListFile {
  readonly name: string
  readonly kind: "file"
}

export interface WorkspaceListDirectory {
  readonly name: string
  readonly kind: "directory"
  readonly entries: ReadonlyArray<WorkspaceListEntry>
}

export type WorkspaceListEntry = WorkspaceListFile | WorkspaceListDirectory

export const WorkspaceListEntry: Schema.Codec<WorkspaceListEntry> = Schema.Union([
  Schema.Struct({ name: Schema.String, kind: Schema.Literal("file") }),
  Schema.Struct({
    name: Schema.String,
    kind: Schema.Literal("directory"),
    entries: Schema.Array(Schema.suspend((): Schema.Codec<WorkspaceListEntry> => WorkspaceListEntry)),
  }),
])
