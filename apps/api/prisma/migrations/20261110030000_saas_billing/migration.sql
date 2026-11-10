-- CreateTable
CREATE TABLE "platform"."saas_invoices" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "organization_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "billing_cycle" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "amount_cop" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "due_date" TIMESTAMP(3) NOT NULL,
    "paid_at" TIMESTAMP(3),
    "payment_method" TEXT,
    "payment_reference" TEXT,
    "confirmed_by_id" UUID,
    "voided_at" TIMESTAMP(3),
    "void_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saas_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."saas_payments" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "amount_cop" INTEGER NOT NULL,
    "provider_payment_id" TEXT,
    "provider_preference_id" TEXT,
    "provider_status" TEXT,
    "reference" TEXT,
    "paid_at" TIMESTAMP(3),
    "proof_key" TEXT,
    "proof_type" TEXT,
    "notes" TEXT,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "reject_reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saas_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."platform_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "saas_invoices_number_key" ON "platform"."saas_invoices"("number");

-- CreateIndex
CREATE INDEX "saas_invoices_organization_id_status_idx" ON "platform"."saas_invoices"("organization_id", "status");

-- CreateIndex
CREATE INDEX "saas_invoices_status_due_date_idx" ON "platform"."saas_invoices"("status", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "saas_payments_provider_payment_id_key" ON "platform"."saas_payments"("provider_payment_id");

-- CreateIndex
CREATE INDEX "saas_payments_organization_id_created_at_idx" ON "platform"."saas_payments"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "saas_payments_status_method_idx" ON "platform"."saas_payments"("status", "method");

-- AddForeignKey
ALTER TABLE "platform"."saas_invoices" ADD CONSTRAINT "saas_invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "platform"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."saas_invoices" ADD CONSTRAINT "saas_invoices_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "platform"."subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."saas_invoices" ADD CONSTRAINT "saas_invoices_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "platform"."plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."saas_payments" ADD CONSTRAINT "saas_payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "platform"."saas_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."saas_payments" ADD CONSTRAINT "saas_payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "platform"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Reglas de integridad del cobro del SaaS.
ALTER TABLE platform.saas_invoices ADD CONSTRAINT saas_invoices_status_check CHECK (status IN ('pending', 'in_review', 'paid', 'void'));
ALTER TABLE platform.saas_invoices ADD CONSTRAINT saas_invoices_cycle_check CHECK (billing_cycle IN ('monthly', 'yearly'));
ALTER TABLE platform.saas_invoices ADD CONSTRAINT saas_invoices_amount_check CHECK (amount_cop >= 0);
ALTER TABLE platform.saas_invoices ADD CONSTRAINT saas_invoices_period_check CHECK (period_end > period_start);
-- Una sola factura vigente por suscripción y período.
CREATE UNIQUE INDEX saas_invoices_one_per_period ON platform.saas_invoices (subscription_id, period_start) WHERE status <> 'void';
ALTER TABLE platform.saas_payments ADD CONSTRAINT saas_payments_status_check CHECK (status IN ('pending', 'in_review', 'approved', 'rejected'));
ALTER TABLE platform.saas_payments ADD CONSTRAINT saas_payments_method_check CHECK (method IN ('mercadopago', 'transfer', 'manual'));
ALTER TABLE platform.subscriptions ADD CONSTRAINT subscriptions_cycle_check CHECK (billing_cycle IN ('monthly', 'yearly'));

-- Un solo plan con toda la plataforma. Los planes anteriores quedan inactivos (no se borran: hay historial).
INSERT INTO platform.plans (id, code, name, price_monthly_cop, price_yearly_cop, trial_days, is_public, is_active)
VALUES (gen_random_uuid(), 'plataforma', 'Plataforma completa', 150000, 1500000, 30, true, true)
ON CONFLICT (code) DO NOTHING;
INSERT INTO platform.plan_features (plan_id, feature_key, enabled)
SELECT p.id, f.key, true FROM platform.plans p
CROSS JOIN (VALUES ('subscribers'), ('meters'), ('billing'), ('payments'), ('receivables'), ('accounting'), ('documents'), ('reports'),
                   ('automations'), ('integrations'), ('excel_import'), ('custom_domain')) AS f(key)
WHERE p.code = 'plataforma'
ON CONFLICT DO NOTHING;
INSERT INTO platform.plan_limits (plan_id, limit_key, value)
SELECT p.id, l.key, -1 FROM platform.plans p
CROSS JOIN (VALUES ('max_subscribers'), ('max_admin_users'), ('storage_mb'), ('documents_per_month'), ('automations'), ('integrations')) AS l(key)
WHERE p.code = 'plataforma'
ON CONFLICT DO NOTHING;
UPDATE platform.plans SET is_active = false, is_public = false WHERE code <> 'plataforma';
UPDATE platform.subscriptions SET plan_id = (SELECT id FROM platform.plans WHERE code = 'plataforma');
