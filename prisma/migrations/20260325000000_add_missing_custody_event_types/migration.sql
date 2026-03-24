-- AlterEnum: Agregar valores de evento de custodia faltantes
-- Estos valores existen en schema.prisma y en railway-setup.js pero no tenian migracion SQL

ALTER TYPE "enum_custody_event_type" ADD VALUE IF NOT EXISTS 'SCAN';
ALTER TYPE "enum_custody_event_type" ADD VALUE IF NOT EXISTS 'HASH_CALCULATED';
ALTER TYPE "enum_custody_event_type" ADD VALUE IF NOT EXISTS 'SEALED_DOC_CREATED';
ALTER TYPE "enum_custody_event_type" ADD VALUE IF NOT EXISTS 'METADATA_EXTRACTED';
ALTER TYPE "enum_custody_event_type" ADD VALUE IF NOT EXISTS 'READY_EXPORT';
ALTER TYPE "enum_custody_event_type" ADD VALUE IF NOT EXISTS 'MANIFEST_SIGNED';
