# Media inspection

Agents use `view_media` for images, PDFs, audio, and video up to 25 MiB anywhere the user running Rika can read; media outside the Workspace is sent to the configured analyzer like any other. PNG, JPEG, GIF, and WebP return image metadata; PDF, MP3, Ogg, WAV, and MP4 use the configured media analyzer and return bounded text.

Missing or oversized files, unsupported formats, unavailable analysis, and analyzer failures are reported as distinct tool errors. Inspection never changes the source file.
