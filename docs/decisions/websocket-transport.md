# WebSocket transport

Rika uses Effect Streams inside the server and one authenticated typed WebSocket contract across the local process boundary. Bidirectional interaction, acknowledgements, bounded delivery, and reconnect fit one connection; SSE would split events from steering and cancellation.
