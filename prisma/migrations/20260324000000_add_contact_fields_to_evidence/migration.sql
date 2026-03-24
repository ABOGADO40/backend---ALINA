-- AddColumns
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "contact_email" VARCHAR(255);
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "contact_phone" VARCHAR(50);
