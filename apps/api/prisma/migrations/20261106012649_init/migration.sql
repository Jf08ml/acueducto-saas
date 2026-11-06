-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "platform";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "tenant";

-- CreateEnum
CREATE TYPE "platform"."OrgStatus" AS ENUM ('onboarding', 'active', 'suspended', 'deactivated');

-- CreateEnum
CREATE TYPE "platform"."SubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'suspended', 'cancelled');

-- CreateTable
CREATE TABLE "platform"."organizations" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "nit" TEXT NOT NULL,
    "nit_dv" INTEGER NOT NULL,
    "department" TEXT NOT NULL,
    "municipality" TEXT NOT NULL,
    "organization_type" TEXT NOT NULL,
    "legal_nature" TEXT,
    "provider_type" TEXT,
    "estimated_subscribers" INTEGER NOT NULL DEFAULT 0,
    "contact_email" TEXT NOT NULL,
    "contact_phone" TEXT NOT NULL,
    "status" "platform"."OrgStatus" NOT NULL DEFAULT 'onboarding',
    "branding" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "is_platform_admin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."memberships" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price_monthly_cop" INTEGER NOT NULL DEFAULT 0,
    "price_yearly_cop" INTEGER NOT NULL DEFAULT 0,
    "trial_days" INTEGER NOT NULL DEFAULT 0,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."plan_features" (
    "plan_id" UUID NOT NULL,
    "feature_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "plan_features_pkey" PRIMARY KEY ("plan_id","feature_key")
);

-- CreateTable
CREATE TABLE "platform"."plan_limits" (
    "plan_id" UUID NOT NULL,
    "limit_key" TEXT NOT NULL,
    "value" INTEGER NOT NULL,

    CONSTRAINT "plan_limits_pkey" PRIMARY KEY ("plan_id","limit_key")
);

-- CreateTable
CREATE TABLE "platform"."org_entitlement_overrides" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "org_entitlement_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."subscriptions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "platform"."SubscriptionStatus" NOT NULL,
    "billing_cycle" TEXT NOT NULL DEFAULT 'monthly',
    "trial_ends_at" TIMESTAMP(3),
    "current_period_start" TIMESTAMP(3) NOT NULL,
    "current_period_end" TIMESTAMP(3) NOT NULL,
    "grace_ends_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."support_access_grants" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "approved_by_id" UUID,
    "reason" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'read',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_access_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" UUID,
    "organization_id" UUID,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entity_id" TEXT,
    "data" JSONB,
    "ip" TEXT,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant"."subscribers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "document_number" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "stratum" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscribers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "platform"."organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_nit_key" ON "platform"."organizations"("nit");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "platform"."users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_user_id_organization_id_key" ON "platform"."memberships"("user_id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "platform"."plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "org_entitlement_overrides_organization_id_key_key" ON "platform"."org_entitlement_overrides"("organization_id", "key");

-- CreateIndex
CREATE INDEX "subscriptions_organization_id_status_idx" ON "platform"."subscriptions"("organization_id", "status");

-- CreateIndex
CREATE INDEX "support_access_grants_organization_id_status_idx" ON "platform"."support_access_grants"("organization_id", "status");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_occurred_at_idx" ON "platform"."audit_logs"("organization_id", "occurred_at");

-- CreateIndex
CREATE INDEX "subscribers_organization_id_document_number_idx" ON "tenant"."subscribers"("organization_id", "document_number");

-- CreateIndex
CREATE UNIQUE INDEX "subscribers_organization_id_code_key" ON "tenant"."subscribers"("organization_id", "code");

-- AddForeignKey
ALTER TABLE "platform"."memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "platform"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "platform"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."plan_features" ADD CONSTRAINT "plan_features_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "platform"."plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."plan_limits" ADD CONSTRAINT "plan_limits_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "platform"."plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."org_entitlement_overrides" ADD CONSTRAINT "org_entitlement_overrides_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "platform"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."subscriptions" ADD CONSTRAINT "subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "platform"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "platform"."plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant"."subscribers" ADD CONSTRAINT "subscribers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "platform"."organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
