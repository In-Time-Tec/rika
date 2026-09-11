CREATE TABLE rika_box_assignment_bindings (
  assignment_id text NOT NULL,
  generation bigint NOT NULL,
  box_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT rika_box_assignment_bindings_pkey PRIMARY KEY (assignment_id, generation),
  CONSTRAINT rika_box_assignment_bindings_assignment_id_fkey
    FOREIGN KEY (assignment_id)
    REFERENCES rika_hosted_executor_assignments (id)
    ON DELETE CASCADE,
  CONSTRAINT rika_box_assignment_bindings_generation_check CHECK (generation >= 1),
  CONSTRAINT rika_box_assignment_bindings_box_id_check
    CHECK (box_id ~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$')
);
