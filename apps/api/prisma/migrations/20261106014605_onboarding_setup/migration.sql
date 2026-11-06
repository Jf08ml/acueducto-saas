-- AlterTable
ALTER TABLE "platform"."organizations" ADD COLUMN     "altitude_masl" INTEGER,
ADD COLUMN     "area_type" TEXT,
ADD COLUMN     "onboarding_completed_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "platform"."regulatory_obligations" (
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "authority" TEXT NOT NULL,
    "legal_basis" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "applies_to" JSONB NOT NULL DEFAULT '{}',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "regulatory_obligations_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "tenant"."compliance_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "obligation_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "due_date" DATE,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."tariff_schedules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "billing_period" TEXT NOT NULL,
    "basic_consumption_m3" INTEGER NOT NULL,
    "fixed_charge" DECIMAL(14,2) NOT NULL,
    "rate_basic" DECIMAL(14,2) NOT NULL,
    "rate_complementary" DECIMAL(14,2) NOT NULL,
    "rate_sumptuary" DECIMAL(14,2) NOT NULL,
    "stratum_factors" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tariff_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "compliance_items_organization_id_obligation_code_key" ON "tenant"."compliance_items"("organization_id", "obligation_code");

-- CreateIndex
CREATE INDEX "tariff_schedules_organization_id_is_active_idx" ON "tenant"."tariff_schedules"("organization_id", "is_active");

-- AddForeignKey
ALTER TABLE "tenant"."compliance_items" ADD CONSTRAINT "compliance_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "platform"."organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."tariff_schedules" ADD CONSTRAINT "tariff_schedules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "platform"."organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Aislamiento por tenant en las tablas nuevas.
SELECT tenant.enable_rls('tenant.compliance_items');
SELECT tenant.enable_rls('tenant.tariff_schedules');
