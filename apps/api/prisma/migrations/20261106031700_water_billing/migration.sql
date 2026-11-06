-- DropForeignKey
ALTER TABLE "tenant"."meter_readings" DROP CONSTRAINT "meter_readings_meter_id_fkey";

-- DropForeignKey
ALTER TABLE "tenant"."meter_readings" DROP CONSTRAINT "meter_readings_subscriber_id_fkey";

-- DropForeignKey
ALTER TABLE "tenant"."meter_readings" DROP CONSTRAINT "readings_meter_same_org_fkey";

-- DropForeignKey
ALTER TABLE "tenant"."meter_readings" DROP CONSTRAINT "readings_subscriber_same_org_fkey";

-- DropForeignKey
ALTER TABLE "tenant"."meters" DROP CONSTRAINT "meters_subscriber_id_fkey";

-- DropForeignKey
ALTER TABLE "tenant"."meters" DROP CONSTRAINT "meters_subscriber_same_org_fkey";

-- AlterTable
ALTER TABLE "tenant"."subscribers" ADD COLUMN     "usage" TEXT NOT NULL DEFAULT 'residencial';

-- AlterTable
ALTER TABLE "tenant"."tariff_schedules" ADD COLUMN     "sumptuary_from_m3" INTEGER;

-- CreateTable
CREATE TABLE "tenant"."billing_periods" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "tariff_schedule_id" UUID NOT NULL,
    "issue_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "options" JSONB NOT NULL DEFAULT '{}',
    "invoice_count" INTEGER NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "subsidy_amount" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "contribution_amount" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "consumption_m3" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "issued_by_id" UUID,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voided_at" TIMESTAMP(3),
    "void_reason" TEXT,

    CONSTRAINT "billing_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."invoices" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "billing_period_id" UUID NOT NULL,
    "subscriber_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "period" TEXT NOT NULL,
    "issue_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "subscriber_snapshot" JSONB NOT NULL,
    "reading_snapshot" JSONB NOT NULL,
    "consumption_m3" DECIMAL(12,2) NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "subsidy_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "contribution_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."invoice_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "concept" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_periods_id_org_key" ON "tenant"."billing_periods"("id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_periods_organization_id_period_key" ON "tenant"."billing_periods"("organization_id", "period");

-- CreateIndex
CREATE INDEX "invoices_organization_id_period_idx" ON "tenant"."invoices"("organization_id", "period");

-- CreateIndex
CREATE INDEX "invoices_organization_id_subscriber_id_idx" ON "tenant"."invoices"("organization_id", "subscriber_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_id_org_key" ON "tenant"."invoices"("id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_organization_id_number_key" ON "tenant"."invoices"("organization_id", "number");

-- CreateIndex
CREATE INDEX "invoice_lines_organization_id_invoice_id_idx" ON "tenant"."invoice_lines"("organization_id", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "tariff_schedules_id_org_key" ON "tenant"."tariff_schedules"("id", "organization_id");

-- AddForeignKey
ALTER TABLE "tenant"."meters" ADD CONSTRAINT "meters_subscriber_same_org_fkey" FOREIGN KEY ("subscriber_id", "organization_id") REFERENCES "tenant"."subscribers"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."meter_readings" ADD CONSTRAINT "readings_meter_same_org_fkey" FOREIGN KEY ("meter_id", "organization_id") REFERENCES "tenant"."meters"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."meter_readings" ADD CONSTRAINT "readings_subscriber_same_org_fkey" FOREIGN KEY ("subscriber_id", "organization_id") REFERENCES "tenant"."subscribers"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."billing_periods" ADD CONSTRAINT "billing_periods_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "platform"."organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."billing_periods" ADD CONSTRAINT "billing_periods_tariff_same_org_fkey" FOREIGN KEY ("tariff_schedule_id", "organization_id") REFERENCES "tenant"."tariff_schedules"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."invoices" ADD CONSTRAINT "invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "platform"."organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."invoices" ADD CONSTRAINT "invoices_period_same_org_fkey" FOREIGN KEY ("billing_period_id", "organization_id") REFERENCES "tenant"."billing_periods"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."invoices" ADD CONSTRAINT "invoices_subscriber_same_org_fkey" FOREIGN KEY ("subscriber_id", "organization_id") REFERENCES "tenant"."subscribers"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."invoice_lines" ADD CONSTRAINT "invoice_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "platform"."organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_same_org_fkey" FOREIGN KEY ("invoice_id", "organization_id") REFERENCES "tenant"."invoices"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Seguridad multi-tenant ───────────────────────────────────────────────
-- Las FK compuestas (id, organization_id) ahora están declaradas en schema.prisma,
-- así Prisma no intenta borrarlas en migraciones futuras.
SELECT tenant.enable_rls('tenant.billing_periods');
SELECT tenant.enable_rls('tenant.invoices');
SELECT tenant.enable_rls('tenant.invoice_lines');

-- Una sola factura vigente (no anulada) por suscriptor y período.
CREATE UNIQUE INDEX invoices_one_active_per_subscriber_period
  ON tenant.invoices (organization_id, subscriber_id, period) WHERE status <> 'void';

ALTER TABLE tenant.subscribers ADD CONSTRAINT subscribers_usage_check
  CHECK (usage IN ('residencial', 'comercial', 'industrial', 'oficial'));
