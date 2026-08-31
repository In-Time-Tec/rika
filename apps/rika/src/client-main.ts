#!/usr/bin/env bun
import { openStartupPreview } from "./platform/client-entry-host"

if (import.meta.main) {
  const preview = openStartupPreview()
  const { startClient } = await import("./client-runtime")
  startClient(preview)
}
