# MCP OAuth

Users can log in to an OAuth-enabled MCP server through the system browser and a fixed loopback callback on the Executor device. Rika exchanges the callback authorization, stores the resulting credential in the operating-system credential store, reports whether the server is authenticated, and removes the credential on logout. Hosted clients and the control plane never receive an Executor's local MCP credential.

Callback bind failures, browser launch failures, malformed credential storage, provider rejection, and token exchange failures are explicit errors. Credentials remain local and are never included in extension fingerprints or model context.
