#!/usr/bin/env bun

import { Effect } from "effect"
import { applyManagedDaemonEnv, ensureManagedDaemon, getManagedDaemonStatus, stopManagedDaemon } from "./daemon.js"

const [command, ...args] = process.argv.slice(2)

const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect)

switch (command) {
case undefined:
case "tui":
case "ui": {
	await run(applyManagedDaemonEnv)
	await import("./index.js")
	break
}

case "daemon":
case "start": {
	const status = await run(ensureManagedDaemon)
	console.log(JSON.stringify(status, null, 2))
	break
}

case "status": {
	const status = await run(getManagedDaemonStatus)
	console.log(JSON.stringify(status, null, 2))
	break
}

case "stop": {
	const status = await run(stopManagedDaemon)
	console.log(JSON.stringify(status, null, 2))
	break
}

case "restart": {
	// Stop any running managed daemon, then start a fresh one + launch the
	// TUI. Handy during local development when you've rebuilt the server
	// and want the TUI to reconnect to the new binary in one command.
	await run(stopManagedDaemon)
	await run(applyManagedDaemonEnv)
	await import("./index.js")
	break
}

case "server": {
	await run(applyManagedDaemonEnv)
	await import("./server.js")
	break
}

case "mcp": {
	await import("./mcp.js")
	break
}

case "help":
case "--help":
case "-h": {
	console.log(`Usage:
	rika inspect --all
	rika inspect --thread <thread-id>`)
	break
}

default: {
	await run(applyManagedDaemonEnv)
	process.argv = [process.argv[0]!, process.argv[1]!, command, ...args]
	await import("./cli.js")
	break
}
}
