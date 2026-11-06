-- Rol de la aplicación: no es superusuario y no puede saltarse RLS.
CREATE ROLE aguamata_app LOGIN PASSWORD 'app_dev_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE aguamata TO aguamata_app;

-- Plano de control (plataforma SaaS) y plano de datos (acueductos).
CREATE SCHEMA IF NOT EXISTS platform AUTHORIZATION aguamata_owner;
CREATE SCHEMA IF NOT EXISTS tenant AUTHORIZATION aguamata_owner;
GRANT USAGE ON SCHEMA platform, tenant TO aguamata_app;

ALTER DEFAULT PRIVILEGES FOR ROLE aguamata_owner IN SCHEMA platform
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aguamata_app;
ALTER DEFAULT PRIVILEGES FOR ROLE aguamata_owner IN SCHEMA tenant
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aguamata_app;
ALTER DEFAULT PRIVILEGES FOR ROLE aguamata_owner IN SCHEMA platform
  GRANT USAGE, SELECT ON SEQUENCES TO aguamata_app;
ALTER DEFAULT PRIVILEGES FOR ROLE aguamata_owner IN SCHEMA tenant
  GRANT USAGE, SELECT ON SEQUENCES TO aguamata_app;
