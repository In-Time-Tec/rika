ALTER TABLE rika_turn_admission_outbox
  ADD COLUMN prepared_turn_json TEXT,
  ADD COLUMN admission_link_json TEXT,
  ADD COLUMN admitted_at DOUBLE PRECISION,
  ADD COLUMN activation_requested_at DOUBLE PRECISION;

CREATE INDEX rika_turn_admission_outbox_activation
  ON rika_turn_admission_outbox (activation_requested_at, prepared_at, turn_id);
