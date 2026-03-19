-- ============================================================================
-- MIGRACION: Cadena de Custodia Forense
-- Cambios: UUID evidence, sequence/eventUuid en custody_events, tabla signing_keys
-- Compatibilidad: Datos existentes se marcan como LEGACY
-- ============================================================================

-- 1. Agregar UUID a evidence
ALTER TABLE "evidence" ADD COLUMN "uuid" UUID;

-- Backfill UUIDs para registros existentes
UPDATE "evidence" SET "uuid" = gen_random_uuid() WHERE "uuid" IS NULL;

-- Hacer NOT NULL y UNIQUE despues del backfill
ALTER TABLE "evidence" ALTER COLUMN "uuid" SET NOT NULL;
ALTER TABLE "evidence" ALTER COLUMN "uuid" SET DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX "evidence_uuid_key" ON "evidence"("uuid");

-- 2. Agregar campos forenses a custody_events
ALTER TABLE "custody_events" ADD COLUMN "event_uuid" UUID;
ALTER TABLE "custody_events" ADD COLUMN "sequence" INTEGER;
ALTER TABLE "custody_events" ADD COLUMN "event_hash_algorithm" VARCHAR(20) NOT NULL DEFAULT 'LEGACY';
ALTER TABLE "custody_events" ADD COLUMN "event_canonicalization" VARCHAR(30) NOT NULL DEFAULT 'LEGACY';

-- Backfill event_uuid para registros existentes
UPDATE "custody_events" SET "event_uuid" = gen_random_uuid() WHERE "event_uuid" IS NULL;

-- Backfill sequence usando ROW_NUMBER particionado por evidence_id
UPDATE "custody_events" ce
SET "sequence" = sub.row_num
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY evidence_id ORDER BY event_at, id) as row_num
  FROM "custody_events"
) sub
WHERE ce.id = sub.id AND ce."sequence" IS NULL;

-- Hacer NOT NULL despues del backfill
ALTER TABLE "custody_events" ALTER COLUMN "event_uuid" SET NOT NULL;
ALTER TABLE "custody_events" ALTER COLUMN "event_uuid" SET DEFAULT gen_random_uuid();
ALTER TABLE "custody_events" ALTER COLUMN "sequence" SET NOT NULL;

-- Cambiar default de nuevos registros a JCS
ALTER TABLE "custody_events" ALTER COLUMN "event_hash_algorithm" SET DEFAULT 'SHA-256';
ALTER TABLE "custody_events" ALTER COLUMN "event_canonicalization" SET DEFAULT 'JCS-RFC8785';

-- Indices y constraints
CREATE UNIQUE INDEX "custody_events_event_uuid_key" ON "custody_events"("event_uuid");
CREATE UNIQUE INDEX "custody_events_evidence_id_sequence_key" ON "custody_events"("evidence_id", "sequence");

-- 3. Crear tabla signing_keys para Ed25519
CREATE TABLE "signing_keys" (
    "id" SERIAL NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "algorithm" VARCHAR(30) NOT NULL,
    "public_key_pem" TEXT NOT NULL,
    "private_key_enc" TEXT NOT NULL,
    "private_key_iv" VARCHAR(32) NOT NULL,
    "private_key_auth_tag" VARCHAR(32) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signing_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "signing_keys_fingerprint_key" ON "signing_keys"("fingerprint");
