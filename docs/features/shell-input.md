# Shell input

A composer input beginning with `$` runs the remaining text as a recorded shell command. `$$` runs it incognito, outside prompt and transcript semantics.

Whitespace after the prefix is ignored. An empty or incomplete shell command remains in the composer instead of being submitted.
