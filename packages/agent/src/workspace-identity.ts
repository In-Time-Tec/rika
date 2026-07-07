import { Ids } from "@rika/schema"

export type ResolveWorkspaceIdInput =
  | {
      readonly workspace_root: string
      readonly project_id?: undefined
    }
  | {
      readonly workspace_root?: string
      readonly project_id: Ids.ProjectId
    }

export const resolveWorkspaceId = (input: ResolveWorkspaceIdInput): Ids.WorkspaceId =>
  input.project_id === undefined
    ? Ids.WorkspaceId.make(input.workspace_root)
    : Ids.WorkspaceId.make(`project:${input.project_id}`)
