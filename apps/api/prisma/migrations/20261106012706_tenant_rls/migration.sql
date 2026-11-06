-- Seguridad multi-tenant. Requiere que exista el rol aguamata_app (ver infra/postgres/init).

-- 1) Privilegios del rol de la aplicación (sin BYPASSRLS).
GRANT USAGE ON SCHEMA platform, tenant TO aguamata_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA platform, tenant TO aguamata_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA platform, tenant TO aguamata_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aguamata_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA tenant GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aguamata_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform GRANT USAGE, SELECT ON SEQUENCES TO aguamata_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA tenant GRANT USAGE, SELECT ON SEQUENCES TO aguamata_app;

-- 2) Bitácora de auditoría append-only para la app.
REVOKE UPDATE, DELETE, TRUNCATE ON platform.audit_logs FROM aguamata_app;

-- 3) Tenant actual de la transacción. '' o ausente => NULL => ninguna fila coincide (falla cerrado).
CREATE OR REPLACE FUNCTION tenant.current_org() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.current_org', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION tenant.current_org() TO aguamata_app;

-- 4) Helper para activar RLS en cada tabla nueva de tenant. Uso en futuras migraciones:
--    SELECT tenant.enable_rls('tenant.meters');
CREATE OR REPLACE FUNCTION tenant.enable_rls(tbl regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (organization_id = tenant.current_org()) WITH CHECK (organization_id = tenant.current_org())',
    tbl);
END $$;

SELECT tenant.enable_rls('tenant.subscribers');

-- 5) Métrica agregada para el Superadmin: solo conteos, nunca filas.
--    SECURITY DEFINER: corre como el dueño (que no está sujeto a RLS) pero solo devuelve números.
CREATE OR REPLACE FUNCTION platform.subscriber_counts()
  RETURNS TABLE (organization_id uuid, total bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, tenant
  AS $$ SELECT s.organization_id, count(*) FROM tenant.subscribers s GROUP BY s.organization_id $$;
REVOKE ALL ON FUNCTION platform.subscriber_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.subscriber_counts() TO aguamata_app;
