# Thread summaries

Thread summaries combine Thread metadata with projected activity. They provide Workspace, title, pin and archive state, `idle`, `queued`, `running`, or `waiting` status, unread state, last activity time, and edit totals when every Turn has projection activity.

Summaries are ordered by pinned state and recent activity, omit archived Threads unless requested, and become read when the Thread is opened. Missing activity, a cursor mismatch, or an incomplete terminal projection makes the Turn a repair candidate; Rika repairs the summary from Generalist-derived projection data instead of guessing partial edit totals.
