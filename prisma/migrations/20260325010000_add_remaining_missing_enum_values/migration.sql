-- AlterEnum: Agregar valores faltantes a enums restantes
-- Auditoria completa: estos valores existen en schema.prisma pero no tenian migracion SQL

-- enum_file_role: falta CERT_TXT (usado en etapa de Sellado del pipeline)
ALTER TYPE "enum_file_role" ADD VALUE IF NOT EXISTS 'CERT_TXT';

-- enum_export_status: falta DOWNLOADED
ALTER TYPE "enum_export_status" ADD VALUE IF NOT EXISTS 'DOWNLOADED';

-- enum_contributor_condition: faltan AGRAVIADO y TERCERO
ALTER TYPE "enum_contributor_condition" ADD VALUE IF NOT EXISTS 'AGRAVIADO';
ALTER TYPE "enum_contributor_condition" ADD VALUE IF NOT EXISTS 'TERCERO';
