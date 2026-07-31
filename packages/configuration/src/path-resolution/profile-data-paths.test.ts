import { describe, expect, it } from "vitest"
import { defaults } from "../settings/configuration-defaults"
import { dataPaths, executionEventHistoryFor } from "./profile-data-paths"
import { globalDirectory, globalPaths, workspaceDirectory, workspacePaths } from "./configuration-paths"

describe("on-disk layout", () => {
  it("puts every workspace file under one directory", () => {
    const paths = workspacePaths("/w")
    for (const value of Object.values(paths)) expect(value.startsWith(`/w/${workspaceDirectory}/`)).toBe(true)
    expect(paths.settings).toBe("/w/.rika/settings.json")
  })

  it("puts every global file under one directory", () => {
    const paths = globalPaths("/home/ada")
    for (const value of Object.values(paths)) expect(value.startsWith(`/home/ada/${globalDirectory}/`)).toBe(true)
    expect(paths.settings).toBe("/home/ada/.config/rika/settings.json")
  })

  it("tolerates a trailing slash on the root", () => {
    expect(workspacePaths("/w/").settings).toBe(workspacePaths("/w").settings)
    expect(dataPaths("/home/ada/").database).toBe(dataPaths("/home/ada").database)
  })

  it("derives one stable event history directory in the data root that holds execution.db", () => {
    const paths = dataPaths("/home/ada")
    expect(paths.executionDatabase).toBe("/home/ada/.rika/execution.db")
    expect(executionEventHistoryFor(paths.executionDatabase)).toBe("/home/ada/.rika/execution-event-history")
    expect(executionEventHistoryFor(paths.executionDatabase)).toBe(executionEventHistoryFor(paths.executionDatabase))
    expect(executionEventHistoryFor(dataPaths("/home/ada/").executionDatabase)).toBe(
      executionEventHistoryFor(paths.executionDatabase),
    )
    expect(executionEventHistoryFor("/execution.db")).toBe("/execution-event-history")
    expect(executionEventHistoryFor("execution.db")).toBe("./execution-event-history")
  })

  it("keeps the shipped extension roots on the same layout", () => {
    expect(defaults.extensionRoots).toEqual([`~/${globalDirectory}/extensions`, `${workspaceDirectory}/extensions`])
  })
})
