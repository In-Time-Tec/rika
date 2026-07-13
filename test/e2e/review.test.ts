import { afterAll, beforeAll, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { run, sandbox, type Sandbox } from "./process"

let context: Sandbox

beforeAll(async () => {
  context = await sandbox()
  Bun.spawnSync(["git", "init", "-q"], { cwd: context.workspace })
  Bun.spawnSync(["git", "config", "user.email", "rika@example.test"], { cwd: context.workspace })
  Bun.spawnSync(["git", "config", "user.name", "Rika Test"], { cwd: context.workspace })
  await writeFile(join(context.workspace, "review.txt"), "before\n")
  Bun.spawnSync(["git", "add", "review.txt"], { cwd: context.workspace })
  Bun.spawnSync(["git", "commit", "-qm", "base"], { cwd: context.workspace })
})

afterAll(async () => context.dispose())

test("packaged review runs durable lanes with stable text and JSON output", async () => {
  expect((await run(context, ["review"])).stdout).toBe("No changes to review.")
  await writeFile(join(context.workspace, "review.txt"), "after\n")
  const output = { summary: "deterministic response", findings: [] }
  context.env.RIKA_TEST_MODEL_SCRIPT = JSON.stringify([
    ...Array.from({ length: 3 }, () => ({ parts: [{ type: "text", text: "deterministic response" }] })),
    ...Array.from({ length: 3 }, () => ({ object: output })),
    ...Array.from({ length: 3 }, () => ({ parts: [{ type: "text", text: "deterministic response" }] })),
    ...Array.from({ length: 3 }, () => ({ object: output })),
  ])
  delete context.env.RIKA_TEST_MODEL_RESPONSE
  const text = await run(context, ["review", "review.txt"], { timeout: 60_000 })
  const laneOutput = `deterministic response${JSON.stringify({ type: "structured", value: output, schema_ref: "rika.agent.review.v1" })}`
  expect(text.exitCode).toBe(0)
  expect(text.stdout).toContain(`## correctness\n${laneOutput}`)
  expect(text.stdout).toContain(`## security\n${laneOutput}`)
  expect(text.stdout).toContain(`## quality\n${laneOutput}`)
  Bun.spawnSync(["git", "add", "review.txt"], { cwd: context.workspace })
  const json = await run(context, ["review", "--staged", "--json"], { timeout: 60_000 })
  expect(json.exitCode).toBe(0)
  expect(JSON.parse(json.stdout)).toMatchObject({
    status: "satisfied",
    lanes: [
      { id: "correctness", status: "completed", output: laneOutput },
      { id: "security", status: "completed", output: laneOutput },
      { id: "quality", status: "completed", output: laneOutput },
    ],
  })
}, 130_000)
