const fastPolling: Readonly<Record<string, string>> = {
  RELAY_EVENT_POLL_INTERVAL_MILLIS: "50",
  RELAY_EVENT_POLL_IDLE_INTERVAL_MILLIS: "250",
  RELAY_SCHEDULER_POLL_INTERVAL_MILLIS: "100",
}

for (const [name, value] of Object.entries(fastPolling)) process.env[name] ??= value
