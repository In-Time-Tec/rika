import { describe, expect, it } from "vitest"
import { defaults } from "../settings/configuration-defaults"
import { dataPaths, executionEventHistoryFor, resolveProfileDataPaths } from "./profile-data-paths"
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

  it("keeps the isolated execution schema generation and its event history together", () => {
    const paths = dataPaths("/home/ada")
    expect(paths.executionDatabase).toBe("/home/ada/.rika/execution-v2.db")
    expect(executionEventHistoryFor(paths.executionDatabase)).toBe("/home/ada/.rika/execution-v2-event-history")
    expect(executionEventHistoryFor(paths.executionDatabase)).toBe(executionEventHistoryFor(paths.executionDatabase))
    expect(executionEventHistoryFor(dataPaths("/home/ada/").executionDatabase)).toBe(
      executionEventHistoryFor(paths.executionDatabase),
    )
    expect(executionEventHistoryFor("/execution.db")).toBe("/execution-event-history")
    expect(executionEventHistoryFor("execution.db")).toBe("./execution-event-history")
  })

  it("resolves host roots and explicit database precedence through one owner", () => {
    expect(
      resolveProfileDataPaths({
        home: "/home/ada",
        hostDataRoot: "/host/data",
        productDatabase: "/explicit/product.db",
        executionDatabase: "/explicit/execution.db",
      }),
    ).toEqual({
      dataRoot: "/host/data",
      database: "/host/data/rika.db",
      executionDatabase: "/host/data/execution-v2.db",
    })
    expect(
      resolveProfileDataPaths({
        home: "/home/ada",
        productDatabase: "/explicit/product.db",
        executionDatabase: "/explicit/execution.db",
      }),
    ).toEqual({
      dataRoot: "/home/ada/.rika",
      database: "/explicit/product.db",
      executionDatabase: "/explicit/execution.db",
    })
  })

  it("keeps the shipped extension roots on the same layout", () => {
    expect(defaults.extensionRoots).toEqual([`~/${globalDirectory}/extensions`, `${workspaceDirectory}/extensions`])
  })
})
