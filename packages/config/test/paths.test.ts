import { describe, expect, it } from "vitest"
import { defaults } from "../src/config-contract"
import { dataPaths, globalDirectory, globalPaths, workspaceDirectory, workspacePaths } from "../src/paths"

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

  it("keeps the shipped extension roots on the same layout", () => {
    expect(defaults.extensionRoots).toEqual([`~/${globalDirectory}/extensions`, `${workspaceDirectory}/extensions`])
  })
})
