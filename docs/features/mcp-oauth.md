# MCP OAuth

Users can log in to an OAuth-enabled MCP server through the system browser and a fixed loopback callback. Rika exchanges the callback authorization, stores the resulting credential in a user-only local file, reports whether the server is authenticated, and removes the credential on logout.

Callback bind failures, browser launch failures, malformed credential storage, provider rejection, and token exchange failures are explicit errors. Credentials remain local and are never included in extension fingerprints or model context.
