-- CreateTable
CREATE TABLE "platform"."organization_domains" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "verification_token" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMP(3),
    "last_checked_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."meters" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "subscriber_id" UUID NOT NULL,
    "serial" TEXT NOT NULL,
    "brand" TEXT,
    "diameter" TEXT,
    "installed_at" DATE NOT NULL,
    "initial_reading" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "removed_at" DATE,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."meter_readings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "meter_id" UUID NOT NULL,
    "subscriber_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "reading_date" DATE NOT NULL,
    "value" DECIMAL(12,2),
    "previous_value" DECIMAL(12,2) NOT NULL,
    "consumption_m3" DECIMAL(12,2) NOT NULL,
    "is_estimated" BOOLEAN NOT NULL DEFAULT false,
    "observation" TEXT,
    "anomaly" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "reader_user_id" UUID,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meter_readings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_domains_hostname_key" ON "platform"."organization_domains"("hostname");

-- CreateIndex
CREATE INDEX "organization_domains_organization_id_idx" ON "platform"."organization_domains"("organization_id");

-- CreateIndex
CREATE INDEX "meters_organization_id_subscriber_id_idx" ON "tenant"."meters"("organization_id", "subscriber_id");

-- CreateIndex
CREATE UNIQUE INDEX "meters_organization_id_serial_key" ON "tenant"."meters"("organization_id", "serial");

-- CreateIndex
CREATE INDEX "meter_readings_organization_id_period_idx" ON "tenant"."meter_readings"("organization_id", "period");

-- CreateIndex
CREATE UNIQUE INDEX "meter_readings_organization_id_meter_id_period_key" ON "tenant"."meter_readings"("organization_id", "meter_id", "period");

-- AddForeignKey
ALTER TABLE "platform"."organization_domains" ADD CONSTRAINT "organization_domains_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "platform"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."meters" ADD CONSTRAINT "meters_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "platform"."organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."meters" ADD CONSTRAINT "meters_subscriber_id_fkey" FOREIGN KEY ("subscriber_id") REFERENCES "tenant"."subscribers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."meter_readings" ADD CONSTRAINT "meter_readings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "platform"."organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."meter_readings" ADD CONSTRAINT "meter_readings_meter_id_fkey" FOREIGN KEY ("meter_id") REFERENCES "tenant"."meters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."meter_readings" ADD CONSTRAINT "meter_readings_subscriber_id_fkey" FOREIGN KEY ("subscriber_id") REFERENCES "tenant"."subscribers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Seguridad multi-tenant ───────────────────────────────────────────────
SELECT tenant.enable_rls('tenant.meters');
SELECT tenant.enable_rls('tenant.meter_readings');

-- Las FK no pasan por RLS: con FK compuestas (id, organization_id) es imposible
-- enlazar una fila con un registro de OTRO acueducto aunque se conozca su id.
ALTER TABLE tenant.subscribers ADD CONSTRAINT subscribers_id_org_key UNIQUE (id, organization_id);
ALTER TABLE tenant.meters ADD CONSTRAINT meters_id_org_key UNIQUE (id, organization_id);
ALTER TABLE tenant.meters
  ADD CONSTRAINT meters_subscriber_same_org_fkey FOREIGN KEY (subscriber_id, organization_id)
  REFERENCES tenant.subscribers (id, organization_id) ON DELETE RESTRICT;
ALTER TABLE tenant.meter_readings
  ADD CONSTRAINT readings_meter_same_org_fkey FOREIGN KEY (meter_id, organization_id)
  REFERENCES tenant.meters (id, organization_id) ON DELETE RESTRICT;
ALTER TABLE tenant.meter_readings
  ADD CONSTRAINT readings_subscriber_same_org_fkey FOREIGN KEY (subscriber_id, organization_id)
  REFERENCES tenant.subscribers (id, organization_id) ON DELETE RESTRICT;

-- Un solo medidor activo por suscriptor.
CREATE UNIQUE INDEX meters_one_active_per_subscriber
  ON tenant.meters (organization_id, subscriber_id) WHERE status = 'active';

-- Los nombres de host se guardan siempre en minúscula.
ALTER TABLE platform.organization_domains
  ADD CONSTRAINT organization_domains_hostname_lower CHECK (hostname = lower(hostname));
