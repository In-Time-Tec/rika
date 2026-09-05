# Thread browser and preview

The Thread browser lets users filter durable Threads, inspect the selected Thread's metadata and transcript preview, and switch the active terminal view without starting a second client. The preview uses the same semantic transcript presentation as the main view and can be scrolled independently.

Opening the browser refreshes the Thread catalog; Ctrl+R refreshes it without closing the browser or changing the query. Hosted refreshes show a loading indicator and an explicit failure with a retry hint. Previous titles stay visible during loading and after failure. Only the newest requested refresh can publish results or status, and catalog replacement preserves the selected Thread by identity rather than list position.

Changing the query or selected Thread resets preview scroll. Confirming a selection closes the browser and loads that Thread; Escape closes it without switching.
