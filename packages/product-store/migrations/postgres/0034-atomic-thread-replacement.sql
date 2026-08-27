ALTER TABLE rika_hosted_threads
ADD COLUMN archive_source_thread_id text;

ALTER TABLE rika_hosted_threads
ADD CONSTRAINT rika_hosted_threads_archive_source_check
CHECK (archive_source_thread_id IS NULL OR archive_source_thread_id <> id);
