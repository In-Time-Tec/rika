DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM rika_api_migration
    WHERE id LIKE 'product/%'
      AND (id, checksum) NOT IN (
        ('product/0001_hosted_authority', '80916a77e51d551de7d674cac2462378e3fd12d22957083970209957ec9e773c'),
        ('product/0002_hosted_identity_ancestry', '403c10eaa96789db75fd3553ec7f7bdfe439f6ae04989cfee7c355f25a7e4f0a'),
        ('product/0003_hosted_authority_fences', 'bc902e5c1c1ebef9eb2da1d00fcf3f8b4f7e8e1391324f5f65eca1eedd7c171a'),
        ('product/0004_local_executor', '0dd90034c56898a6f66a62b8f4d1849a8a9b540945baf0f66908c8e8a9d7d48f'),
        ('product/0005_local_executor_recovery', '77cbc8ebe19f7eadde8b64f7060f171e082bc6758e1700a7ea969e8a1fe41f74')
      )
  ) THEN
    RAISE EXCEPTION 'hosted authority reset found an unsupported product migration history';
  END IF;
END;
$$;

DO $$
DECLARE
  relation_record RECORD;
BEGIN
  FOR relation_record IN
    SELECT namespace.nspname AS schema_name, class.relname AS relation_name, class.relkind
    FROM pg_class class
    JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
    WHERE namespace.nspname = current_schema()
      AND class.relkind IN ('v', 'm')
      AND (
        class.relname LIKE 'rika_hosted_%'
        OR class.relname IN ('rika_workspaces', 'rika_threads', 'rika_turns', 'rika_goals')
        OR class.relname LIKE 'rika_thread_%'
        OR class.relname LIKE 'rika_turn_%'
        OR class.relname LIKE 'rika_transcript_%'
      )
  LOOP
    EXECUTE format(
      'DROP %s %I.%I CASCADE',
      CASE relation_record.relkind WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'VIEW' END,
      relation_record.schema_name,
      relation_record.relation_name
    );
  END LOOP;

  FOR relation_record IN
    SELECT namespace.nspname AS schema_name, class.relname AS relation_name
    FROM pg_class class
    JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
    WHERE namespace.nspname = current_schema()
      AND class.relkind IN ('r', 'p')
      AND (
        class.relname LIKE 'rika_hosted_%'
        OR class.relname IN ('rika_workspaces', 'rika_threads', 'rika_turns', 'rika_goals')
        OR class.relname LIKE 'rika_thread_%'
        OR class.relname LIKE 'rika_turn_%'
        OR class.relname LIKE 'rika_transcript_%'
      )
  LOOP
    EXECUTE format('DROP TABLE %I.%I CASCADE', relation_record.schema_name, relation_record.relation_name);
  END LOOP;
END;
$$;

DO $$
DECLARE
  function_record RECORD;
BEGIN
  FOR function_record IN
    SELECT namespace.nspname AS schema_name, procedure.proname AS function_name,
      pg_get_function_identity_arguments(procedure.oid) AS arguments
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = current_schema()
      AND (procedure.proname LIKE 'rika_hosted_%' OR procedure.proname LIKE 'rika_product_%')
  LOOP
    EXECUTE format(
      'DROP FUNCTION %I.%I(%s) CASCADE',
      function_record.schema_name,
      function_record.function_name,
      function_record.arguments
    );
  END LOOP;
END;
$$;

DO $$
DECLARE
  type_record RECORD;
BEGIN
  FOR type_record IN
    SELECT namespace.nspname AS schema_name, pg_type.typname AS type_name
    FROM pg_type
    JOIN pg_namespace namespace ON namespace.oid = pg_type.typnamespace
    WHERE namespace.nspname = current_schema()
      AND pg_type.typtype = 'e'
      AND pg_type.typname LIKE 'rika_hosted_%'
  LOOP
    EXECUTE format('DROP TYPE %I.%I CASCADE', type_record.schema_name, type_record.type_name);
  END LOOP;
END;
$$;

ALTER TABLE "member" DROP CONSTRAINT IF EXISTS member_id_organization_unique;
DELETE FROM rika_api_migration WHERE id LIKE 'product/%';
