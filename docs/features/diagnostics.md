# Diagnostics

Clients and the server write private Effect JSON logs below the Profile data root. Records contain bounded operation names, process roles, safe identifiers, state transitions, durations, and typed failure kinds. They exclude prompts, model bodies, tool arguments and output, shell content, headers, credentials, and arbitrary error messages.

Diagnostic path, status, and export commands work without starting the server. Normal shutdown flushes scoped logs; abrupt termination may leave an open file as crash evidence.
