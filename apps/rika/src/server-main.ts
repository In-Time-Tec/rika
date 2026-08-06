#!/usr/bin/env bun
import { start } from "./server/process/server-process-launch"

if (import.meta.main) start()
