#!/usr/bin/env bun
if (import.meta.main) {
  const { startClient } = await import("./client-runtime")
  startClient()
}
