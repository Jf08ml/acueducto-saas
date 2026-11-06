-- AlterTable
ALTER TABLE "tenant"."invoices" ADD COLUMN     "paid_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "previous_balance" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "tenant"."payments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "subscriber_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "paid_at" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'applied',
    "received_by_id" UUID,
    "voided_at" TIMESTAMP(3),
    "void_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."payment_allocations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payments_organization_id_paid_at_idx" ON "tenant"."payments"("organization_id", "paid_at");

-- CreateIndex
CREATE INDEX "payments_organization_id_subscriber_id_idx" ON "tenant"."payments"("organization_id", "subscriber_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_id_org_key" ON "tenant"."payments"("id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_organization_id_number_key" ON "tenant"."payments"("organization_id", "number");

-- CreateIndex
CREATE INDEX "payment_allocations_organization_id_payment_id_idx" ON "tenant"."payment_allocations"("organization_id", "payment_id");

-- CreateIndex
CREATE INDEX "payment_allocations_organization_id_invoice_id_idx" ON "tenant"."payment_allocations"("organization_id", "invoice_id");

-- AddForeignKey
ALTER TABLE "tenant"."payments" ADD CONSTRAINT "payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "platform"."organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."payments" ADD CONSTRAINT "payments_subscriber_same_org_fkey" FOREIGN KEY ("subscriber_id", "organization_id") REFERENCES "tenant"."subscribers"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."payment_allocations" ADD CONSTRAINT "payment_allocations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "platform"."organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."payment_allocations" ADD CONSTRAINT "allocations_payment_same_org_fkey" FOREIGN KEY ("payment_id", "organization_id") REFERENCES "tenant"."payments"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."payment_allocations" ADD CONSTRAINT "allocations_invoice_same_org_fkey" FOREIGN KEY ("invoice_id", "organization_id") REFERENCES "tenant"."invoices"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Seguridad multi-tenant ───────────────────────────────────────────────
SELECT tenant.enable_rls('tenant.payments');
SELECT tenant.enable_rls('tenant.payment_allocations');

-- ── Integridad de montos (defensa en profundidad además de la lógica de la API) ──
ALTER TABLE tenant.payments ADD CONSTRAINT payments_amount_positive CHECK (amount > 0);
ALTER TABLE tenant.payments ADD CONSTRAINT payments_method_check
  CHECK (method IN ('efectivo', 'transferencia', 'consignacion', 'pse', 'otro'));
ALTER TABLE tenant.payment_allocations ADD CONSTRAINT allocations_amount_positive CHECK (amount > 0);
-- Nunca se puede abonar más del total de una factura.
ALTER TABLE tenant.invoices ADD CONSTRAINT invoices_paid_within_total CHECK (paid_amount >= 0 AND paid_amount <= total);
