-- AlterTable
ALTER TABLE "platform"."memberships" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active';

-- AlterTable
ALTER TABLE "platform"."users" ADD COLUMN     "last_login_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "platform"."invitations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by_id" UUID,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "platform"."invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_organization_id_email_idx" ON "platform"."invitations"("organization_id", "email");

-- AddForeignKey
ALTER TABLE "platform"."invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "platform"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE platform.memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('owner', 'admin', 'operator', 'reader'));
ALTER TABLE platform.memberships ADD CONSTRAINT memberships_status_check CHECK (status IN ('active', 'disabled'));
ALTER TABLE platform.invitations ADD CONSTRAINT invitations_role_check CHECK (role IN ('owner', 'admin', 'operator', 'reader'));
ALTER TABLE platform.invitations ADD CONSTRAINT invitations_email_lower CHECK (email = lower(email));
-- Una sola invitación pendiente por correo y acueducto.
CREATE UNIQUE INDEX invitations_one_pending_per_email
  ON platform.invitations (organization_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
