import { describe, expect, it } from "vitest"
import { defaults } from "../src/config-contract"
import {
  dataPaths,
  globalDirectory,
  globalPaths,
  relayEventHistoryFor,
  workspaceDirectory,
  workspacePaths,
} from "../src/paths"

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

  it("derives one stable Relay event history directory in the data root that holds relay.db", () => {
    const paths = dataPaths("/home/ada")
    expect(paths.relayDatabase).toBe("/home/ada/.rika/relay.db")
    expect(relayEventHistoryFor(paths.relayDatabase)).toBe("/home/ada/.rika/relay-event-history")
    expect(relayEventHistoryFor(paths.relayDatabase)).toBe(relayEventHistoryFor(paths.relayDatabase))
    expect(relayEventHistoryFor(dataPaths("/home/ada/").relayDatabase)).toBe(relayEventHistoryFor(paths.relayDatabase))
    expect(relayEventHistoryFor("/relay.db")).toBe("/relay-event-history")
    expect(relayEventHistoryFor("relay.db")).toBe("./relay-event-history")
  })

  it("keeps the shipped extension roots on the same layout", () => {
    expect(defaults.extensionRoots).toEqual([`~/${globalDirectory}/extensions`, `${workspaceDirectory}/extensions`])
  })
})
