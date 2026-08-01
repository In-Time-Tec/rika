#!/usr/bin/env bun
import { start } from "./resident/process/resident-process-launch"

if (import.meta.main) start()
