-- Roles de la base de datos en PRODUCCIÓN (la carpeta init/ es solo para el Docker de desarrollo).
-- Córrelo UNA vez, conectado como administrador de la base, ANTES de `prisma migrate deploy`:
--
--   psql "postgresql://<admin>@<host>:5432/aguamata" \
--     -v owner_password='<clave fuerte 1>' -v app_password='<clave fuerte 2>' \
--     -f infra/postgres/production-roles.sql
--
-- Resultado:
--   aguamata_owner → dueño de las tablas. Solo para migraciones y seed (DIRECT_DATABASE_URL).
--   aguamata_app   → el que usa la API (DATABASE_URL). NO puede saltarse RLS: es lo que aísla a los acueductos.

-- El dueño necesita BYPASSRLS: las tablas tienen FORCE ROW LEVEL SECURITY, que también aplica a su dueño
-- (funciones de métricas SECURITY DEFINER, seed y migraciones de datos). Crear este rol requiere un superusuario.
CREATE ROLE aguamata_owner LOGIN PASSWORD :'owner_password' NOSUPERUSER BYPASSRLS NOCREATEROLE;
CREATE ROLE aguamata_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

GRANT CONNECT ON DATABASE aguamata TO aguamata_owner, aguamata_app;
GRANT CREATE ON DATABASE aguamata TO aguamata_owner;

CREATE SCHEMA IF NOT EXISTS platform AUTHORIZATION aguamata_owner;
CREATE SCHEMA IF NOT EXISTS tenant AUTHORIZATION aguamata_owner;
-- Prisma guarda su historial de migraciones en public.
GRANT USAGE, CREATE ON SCHEMA public TO aguamata_owner;
GRANT USAGE ON SCHEMA platform, tenant TO aguamata_app;

ALTER DEFAULT PRIVILEGES FOR ROLE aguamata_owner IN SCHEMA platform GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aguamata_app;
ALTER DEFAULT PRIVILEGES FOR ROLE aguamata_owner IN SCHEMA tenant GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aguamata_app;
ALTER DEFAULT PRIVILEGES FOR ROLE aguamata_owner IN SCHEMA platform GRANT USAGE, SELECT ON SEQUENCES TO aguamata_app;
ALTER DEFAULT PRIVILEGES FOR ROLE aguamata_owner IN SCHEMA tenant GRANT USAGE, SELECT ON SEQUENCES TO aguamata_app;
