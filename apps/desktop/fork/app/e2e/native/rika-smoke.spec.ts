import { expect, test } from "@playwright/test"
import { fileURLToPath } from "node:url"

const workspace = fileURLToPath(new URL("../..", import.meta.url))

test("submits a prompt through the native Rika WebSocket", async ({ page }) => {
  await page.addInitScript((workspace) => {
    localStorage.setItem("settings", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem(
      "rika.global.dat:server",
      JSON.stringify({
        list: [],
        projects: { local: [{ worktree: workspace, expanded: true }] },
        lastProject: { local: workspace },
        recentlyClosed: {},
      }),
    )
  }, workspace)
  await page.goto("/")
  await page.locator('[data-component="home-project-row"]').click()
  await page.locator('[data-action="home-new-session"]').click()
  const prompt = page.getByRole("textbox", { name: "Prompt" })
  await expect(prompt).toBeVisible()
  await prompt.fill("Reply exactly RIKA_OK")
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.getByText("RIKA_OK", { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole("banner").getByRole("button", { name: "New session" }).click()
  await expect(page.getByRole("textbox", { name: "Prompt" })).toBeVisible()
})
