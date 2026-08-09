import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"

const channels = [
  { channel: "dev", appId: "ai.rika.desktop.dev" },
  { channel: "beta", appId: "ai.rika.desktop.beta" },
  { channel: "prod", appId: "ai.rika.desktop" },
] as const

for (const channel of channels) {
  test(`uses one Rika Linux identity for ${channel.channel}`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
    expect(config.protocols?.schemes).toEqual(["rika", "opencode"])
    expect(config.deb?.fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`))
    expect(config.rpm?.fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`))
  })
}

test("retains the legacy Linux launcher path for prod", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "prod"
  const module = await import("./electron-builder.config.ts?legacy-launcher")
  const config = module.default as Configuration
  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(config.deb?.fpm).toContainEqual(
    expect.stringContaining("opencode-desktop.desktop=/usr/share/applications/opencode-desktop.desktop"),
  )
  expect(
    await Bun.file(new URL("./resources/linux/opencode-desktop.desktop", import.meta.url)).exists(),
  ).toBe(true)
})

test("does not bundle a legacy CLI", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "dev"
  const module = await import("./electron-builder.config.ts?native-only")
  const config = module.default as Configuration
  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(config.files).not.toContain(expect.stringContaining("cli"))
  expect(config.extraResources).not.toContainEqual(expect.objectContaining({ from: "resources/" }))
})
