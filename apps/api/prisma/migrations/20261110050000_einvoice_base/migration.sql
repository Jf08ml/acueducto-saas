-- CreateTable
CREATE TABLE "tenant"."einvoice_configs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT NOT NULL DEFAULT 'simulated',
    "environment" TEXT NOT NULL DEFAULT 'habilitacion',
    "document_type" TEXT NOT NULL DEFAULT 'documento_equivalente_spd',
    "resolution_number" TEXT NOT NULL,
    "resolution_date" DATE NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "range_from" INTEGER NOT NULL,
    "range_to" INTEGER NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE NOT NULL,
    "technical_key_encrypted" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "einvoice_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."einvoice_documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "document_type" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "document_key" TEXT,
    "qr_url" TEXT,
    "provider_ref" TEXT,
    "payload" JSONB NOT NULL,
    "response" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "einvoice_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "einvoice_configs_organization_id_key" ON "tenant"."einvoice_configs"("organization_id");

-- CreateIndex
CREATE INDEX "einvoice_documents_organization_id_period_status_idx" ON "tenant"."einvoice_documents"("organization_id", "period", "status");

-- CreateIndex
CREATE UNIQUE INDEX "einvoice_documents_invoice_id_organization_id_key" ON "tenant"."einvoice_documents"("invoice_id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "einvoice_documents_organization_id_prefix_number_key" ON "tenant"."einvoice_documents"("organization_id", "prefix", "number");

-- AddForeignKey
ALTER TABLE "tenant"."einvoice_configs" ADD CONSTRAINT "einvoice_configs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "platform"."organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."einvoice_documents" ADD CONSTRAINT "einvoice_documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "platform"."organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."einvoice_documents" ADD CONSTRAINT "einvoice_documents_invoice_same_org_fkey" FOREIGN KEY ("invoice_id", "organization_id") REFERENCES "tenant"."invoices"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Aislamiento por acueducto.
SELECT tenant.enable_rls('tenant.einvoice_configs');
SELECT tenant.enable_rls('tenant.einvoice_documents');
ALTER TABLE tenant.einvoice_configs ADD CONSTRAINT einvoice_configs_env_check CHECK (environment IN ('habilitacion', 'produccion'));
ALTER TABLE tenant.einvoice_configs ADD CONSTRAINT einvoice_configs_range_check CHECK (range_to >= range_from AND range_from >= 1);
ALTER TABLE tenant.einvoice_documents ADD CONSTRAINT einvoice_documents_status_check CHECK (status IN ('pending', 'accepted', 'rejected', 'error', 'void', 'requires_credit_note'));
