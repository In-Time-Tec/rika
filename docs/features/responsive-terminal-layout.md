# Responsive terminal layout

Transcript Markdown, composer text, queue rows, previews, and sidebars wrap to the available terminal display-cell width, including wide CJK characters, emoji, and combining characters. Composer and queue heights follow wrapped content and remain bounded by terminal height; narrow layouts keep overlays usable.

Sidebars reduce the available content width rather than overlap the transcript. Rapid resize bursts are coalesced at the trailing edge, after which mounted content reflows to the exact final terminal size.
