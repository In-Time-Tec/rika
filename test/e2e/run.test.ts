import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { binary, run as runProcess, sandbox } from "./process"

const run = (product: string, relay: string, args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync([binary, ...args], {
    env: {
      ...process.env,
      RIKA_DATABASE: product,
      RIKA_RELAY_DATABASE: relay,
      RIKA_TEST_MODEL_RESPONSE: "deterministic response",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

test("packaged deterministic execution persists thread and turn cursors", async () => {
  const directory = (await Bun.$`mktemp -d`.text()).trim()
  const product = `${directory}/rika/rika.db`
  const relay = `${directory}/rika/relay.db`
  expect(run(product, relay, ["run", "hello"])).toContain("deterministic response")
  const threads = JSON.parse(run(product, relay, ["threads", "list"]))
  expect(threads).toHaveLength(1)
  const events = run(product, relay, ["run", "--thread", threads[0].id, "--stream-json", "second"])
    .split("\n")
    .map(JSON.parse)
  expect(events.map((event) => event.type)).toContain("model.output.completed")
  expect(events.map((event) => event.type)).toContain("execution.completed")
  const database = new Database(product)
  const turns = database.query("SELECT status, last_cursor FROM rika_turns ORDER BY created_at").all()
  database.close()
  expect(turns).toHaveLength(2)
  expect(turns.every((turn) => turn.status === "completed" && typeof turn.last_cursor === "string")).toBe(true)
}, 20_000)

test("packaged normal prompt registers the non-empty tool catalog with Crypto", async () => {
  const context = await sandbox()
  try {
    const result = await runProcess(context, ["run", "--ephemeral", "say hi"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("deterministic response")
    expect(result.stderr).not.toContain("TypeError: members.map is not a function")
    expect(result.stderr).not.toContain("Tool input schema digest computation requires Crypto")
    expect(result.stderr).not.toContain("Tool input schema digest validation requires Crypto")
  } finally {
    await context.dispose()
  }
}, 20_000)
