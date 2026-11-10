-- AlterTable
ALTER TABLE "platform"."support_access_grants" ADD COLUMN     "approved_at" TIMESTAMP(3),
ADD COLUMN     "decided_by_id" UUID,
ADD COLUMN     "decision_note" TEXT,
ADD COLUMN     "duration_hours" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "revoked_at" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "platform"."support_access_grants" ADD CONSTRAINT "support_access_grants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "platform"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE platform.support_access_grants ADD CONSTRAINT support_grants_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'revoked'));
ALTER TABLE platform.support_access_grants ADD CONSTRAINT support_grants_scope_check CHECK (scope IN ('read', 'write'));
ALTER TABLE platform.support_access_grants ADD CONSTRAINT support_grants_duration_check CHECK (duration_hours BETWEEN 1 AND 72);
