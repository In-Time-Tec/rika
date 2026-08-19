# Terminal selection and clipboard

Users can select rendered terminal text across transcript content. When a non-empty selection completes, Rika trims trailing whitespace, copies the text through OSC 52, and shows a confirmation toast.

Selection remains a terminal interaction and does not alter transcript state, expansion, or the composer draft.
