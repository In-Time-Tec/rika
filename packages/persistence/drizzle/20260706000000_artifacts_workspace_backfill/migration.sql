UPDATE artifacts
SET workspace_id = (
  SELECT thread_projections.workspace_id
  FROM thread_projections
  WHERE thread_projections.thread_id = artifacts.thread_id
)
WHERE workspace_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM thread_projections
    WHERE thread_projections.thread_id = artifacts.thread_id
  );
