import { test } from "vitest"

test("worker is killed", () => process.kill(process.pid, "SIGKILL"))
