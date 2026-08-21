import { describe, expect, it } from "@effect/vitest"
import { type AuthorizationAction, type AuthorizationSubject, isAuthorized } from "../../src/hosted/authorization"
import { BetterAuthMemberId, type GrantRole } from "../../src/hosted/model"

const memberId = BetterAuthMemberId.make("member")
const creatorId = BetterAuthMemberId.make("creator")
const roles: ReadonlyArray<GrantRole> = ["viewer", "controller", "operator", "owner"]

const projectActions: ReadonlyArray<AuthorizationAction> = ["project:view", "project:update", "project:grant"]
const threadActions: ReadonlyArray<AuthorizationAction> = [
  "thread:view",
  "thread:control",
  "thread:operate",
  "thread:grant",
  "terminal:view",
  "terminal:input",
  "workspace:file:view",
  "workspace:browser:control",
  "workspace:service:control",
]

const projectExpected: Readonly<Record<GrantRole, ReadonlyArray<boolean>>> = {
  viewer: [true, false, false],
  controller: [true, false, false],
  operator: [true, true, false],
  owner: [true, true, true],
}

const threadExpected: Readonly<Record<GrantRole, ReadonlyArray<boolean>>> = {
  viewer: [true, false, false, false, true, false, true, false, false],
  controller: [true, true, false, false, true, true, true, true, true],
  operator: [true, true, true, false, true, true, true, true, true],
  owner: [true, true, true, true, true, true, true, true, true],
}

describe("hosted authorization policy", () => {
  it("exhaustively applies the project role matrix", () => {
    for (const role of roles) {
      const subject: AuthorizationSubject = { memberId, projectRole: role }
      expect(projectActions.map((action) => isAuthorized(subject, action))).toEqual(projectExpected[role])
    }
  })

  it("exhaustively applies the direct thread role matrix", () => {
    for (const role of roles) {
      const subject: AuthorizationSubject = {
        memberId,
        threadRole: role,
        executorKind: "local_device",
        inheritProjectGrants: false,
      }
      expect(threadActions.map((action) => isAuthorized(subject, action))).toEqual(threadExpected[role])
    }
  })

  it("gives the creator owner authority without duplicating Better Auth principals", () => {
    const subject: AuthorizationSubject = {
      memberId,
      threadCreatorMemberId: memberId,
      executorKind: "local_device",
      inheritProjectGrants: false,
    }
    expect(threadActions.every((action) => isAuthorized(subject, action))).toBe(true)
  })

  it("inherits project grants only for remote threads that opted in", () => {
    const base = { memberId, threadCreatorMemberId: creatorId, projectRole: "operator" as const }
    expect(isAuthorized({ ...base, executorKind: "e2b", inheritProjectGrants: true }, "thread:operate")).toBe(true)
    expect(isAuthorized({ ...base, executorKind: "e2b", inheritProjectGrants: false }, "thread:view")).toBe(false)
    expect(isAuthorized({ ...base, executorKind: "local_device", inheritProjectGrants: true }, "thread:view")).toBe(
      false,
    )
  })
})
