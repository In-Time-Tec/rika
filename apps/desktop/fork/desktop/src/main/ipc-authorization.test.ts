import { describe, expect, test } from "bun:test"
import { assertTrustedMainFrame } from "./ipc-authorization"

const sender = { mainFrame: { id: "main" } }
const window = { webContents: sender, isDestroyed: () => false }

describe("privileged IPC authorization", () => {
  test("accepts only the owning BrowserWindow main frame", () => {
    expect(() =>
      assertTrustedMainFrame({ sender, senderFrame: sender.mainFrame }, (candidate) =>
        candidate === sender ? window : null,
      ),
    ).not.toThrow()
  })

  test("rejects a subframe", () => {
    expect(() => assertTrustedMainFrame({ sender, senderFrame: { id: "subframe" } }, () => window)).toThrow(
      "Invalid privileged IPC sender",
    )
  })

  test("rejects detached web contents", () => {
    expect(() => assertTrustedMainFrame({ sender, senderFrame: sender.mainFrame }, () => null)).toThrow(
      "Invalid privileged IPC sender",
    )
  })

  test("rejects a different or destroyed BrowserWindow", () => {
    expect(() =>
      assertTrustedMainFrame({ sender, senderFrame: sender.mainFrame }, () => ({
        webContents: { mainFrame: sender.mainFrame },
        isDestroyed: () => false,
      })),
    ).toThrow("Invalid privileged IPC sender")
    expect(() =>
      assertTrustedMainFrame({ sender, senderFrame: sender.mainFrame }, () => ({
        webContents: sender,
        isDestroyed: () => true,
      })),
    ).toThrow("Invalid privileged IPC sender")
  })
})
