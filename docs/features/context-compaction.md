# Context compaction

Baton compacts an Execution when its pinned route approaches the context window, reserving the route's output allowance. The TUI context meter measures the latest exact root input against that usable budget, changes tone as pressure rises, and animates while the execution is active. It first bounds old tool output, then keeps a recent token range, then creates a structured summary with the fixed GPT-5.6 Sol/xhigh summary route.

Compaction preserves the current prompt and durable transcript. The pinned policy and summary route pass through the Baton execution contract, so durable execution owns compaction state across restart and replay. Conversational and specialist agents can selectively call ReadThread to recover exact pre-compaction context from the retained transcript.
