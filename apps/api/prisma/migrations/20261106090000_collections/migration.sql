-- AlterTable
ALTER TABLE "platform"."organizations" ADD COLUMN     "collection_settings" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "tenant"."invoices" ADD COLUMN     "interest_amount" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "tenant"."subscribers" ADD COLUMN     "service_status" TEXT NOT NULL DEFAULT 'connected';

-- CreateTable
CREATE TABLE "tenant"."subscriber_charges" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "subscriber_id" UUID NOT NULL,
    "concept" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "billed_invoice_id" UUID,
    "created_by_id" UUID,
    "voided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriber_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."service_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "subscriber_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "balance_at_event" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "charge_id" UUID,
    "user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subscriber_charges_organization_id_subscriber_id_idx" ON "tenant"."subscriber_charges"("organization_id", "subscriber_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriber_charges_id_org_key" ON "tenant"."subscriber_charges"("id", "organization_id");

-- CreateIndex
CREATE INDEX "service_events_organization_id_subscriber_id_date_idx" ON "tenant"."service_events"("organization_id", "subscriber_id", "date");

-- AddForeignKey
ALTER TABLE "tenant"."subscriber_charges" ADD CONSTRAINT "subscriber_charges_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "platform"."organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."subscriber_charges" ADD CONSTRAINT "charges_subscriber_same_org_fkey" FOREIGN KEY ("subscriber_id", "organization_id") REFERENCES "tenant"."subscribers"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."subscriber_charges" ADD CONSTRAINT "charges_invoice_same_org_fkey" FOREIGN KEY ("billed_invoice_id", "organization_id") REFERENCES "tenant"."invoices"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."service_events" ADD CONSTRAINT "service_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "platform"."organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."service_events" ADD CONSTRAINT "service_events_subscriber_same_org_fkey" FOREIGN KEY ("subscriber_id", "organization_id") REFERENCES "tenant"."subscribers"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."service_events" ADD CONSTRAINT "service_events_charge_same_org_fkey" FOREIGN KEY ("charge_id", "organization_id") REFERENCES "tenant"."subscriber_charges"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Seguridad multi-tenant ───────────────────────────────────────────────
SELECT tenant.enable_rls('tenant.subscriber_charges');
SELECT tenant.enable_rls('tenant.service_events');

ALTER TABLE tenant.subscriber_charges ADD CONSTRAINT subscriber_charges_amount_positive CHECK (amount > 0);
ALTER TABLE tenant.subscriber_charges ADD CONSTRAINT subscriber_charges_concept_check CHECK (concept IN ('reconexion', 'otro'));
ALTER TABLE tenant.service_events ADD CONSTRAINT service_events_type_check CHECK (type IN ('suspension', 'reconnection'));
ALTER TABLE tenant.subscribers ADD CONSTRAINT subscribers_service_status_check CHECK (service_status IN ('connected', 'suspended'));
ALTER TABLE tenant.invoices ADD CONSTRAINT invoices_interest_within_total CHECK (interest_amount >= 0 AND interest_amount <= total);
