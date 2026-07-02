import { describe, expect, test } from "bun:test"
import { Ids } from "@rika/schema"
import { WorkspaceIdentity } from "../src/index"

describe("workspace identity", () => {
  test("uses project identity across different filesystem roots", () => {
    const projectId = Ids.ProjectId.make("project_shared_identity")
    const local = WorkspaceIdentity.resolveWorkspaceId({
      workspace_root: "/Users/me/rika",
      project_id: projectId,
    })
    const orb = WorkspaceIdentity.resolveWorkspaceId({
      workspace_root: "/home/user/repo",
      project_id: projectId,
    })

    expect(local).toBe(Ids.WorkspaceId.make("project:project_shared_identity"))
    expect(orb).toBe(local)
  })

  test("falls back to path identity without a project", () => {
    const workspaceId = WorkspaceIdentity.resolveWorkspaceId({ workspace_root: "/Users/me/rika" })

    expect(workspaceId).toBe(Ids.WorkspaceId.make("/Users/me/rika"))
  })
})
