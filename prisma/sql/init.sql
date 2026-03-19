-- ============================================================================
-- PRUEBA DIGITAL - SQL DDL COMPLETO
-- Sistema de Evidencia Digital con Cadena de Custodia
-- Version: 1.1 (Homologado con schema.prisma)
-- Fecha: 2026-01-24
-- Stack: PostgreSQL 15+
-- NOTA: Este archivo es un espejo fiel de schema.prisma.
--       La fuente de verdad es schema.prisma + migration.sql
-- ============================================================================

-- Limpiar si existe (solo para desarrollo)
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;

-- ============================================================================
-- TIPOS ENUMERADOS (ENUMs) - Nombres con prefijo enum_ (Prisma convention)
-- ============================================================================

-- Roles del sistema
CREATE TYPE "enum_role_name" AS ENUM ('SUPER_ADMIN', 'CLIENT');

-- Tipos de fuente de evidencia
CREATE TYPE "enum_source_type" AS ENUM ('PDF', 'IMAGE', 'VIDEO', 'AUDIO', 'CHAT', 'ZIP', 'OTHER');

-- Estados de evidencia (maquina de estados)
CREATE TYPE "enum_evidence_status" AS ENUM (
    'RECEIVED',
    'SCANNED_OK',
    'HASHED',
    'CLONED_BITCOPY',
    'SEALED',
    'ANALYZED',
    'READY_FOR_EXPORT',
    'EXPORTED',
    'ERROR'
);

-- Roles de archivo
CREATE TYPE "enum_file_role" AS ENUM (
    'ORIGINAL',
    'BITCOPY',
    'WORKING_COPY',
    'SEALED',
    'CERT_PDF',
    'CERT_JSON',
    'METADATA_REPORT',
    'RISK_REPORT',
    'EXPORT_ZIP'
);

-- Algoritmo de hash
CREATE TYPE "enum_hash_algorithm" AS ENUM ('SHA256');

-- Tipo de actor
CREATE TYPE "enum_actor_type" AS ENUM ('USER', 'SYSTEM', 'PUBLIC');

-- Tipos de evento de custodia
CREATE TYPE "enum_custody_event_type" AS ENUM (
    'UPLOAD',
    'SCAN_OK',
    'SCAN_FAILED',
    'HASH_COMPUTED',
    'BITCOPY_CREATED',
    'SEAL_CREATED',
    'CRYPTO_SEAL_CREATED',
    'METADATA_CREATED',
    'RISK_REPORT_CREATED',
    'READY_FOR_EXPORT',
    'EXPORT_CREATED',
    'DOWNLOAD',
    'PUBLIC_VERIFY',
    'REGENERATE_VERSION',
    'ERROR',
    'VISIBILITY_CHANGE',
    'DELETE',
    'EXPORT',
    'EXPORT_CUSTODY'
);

-- Scope de exportacion
CREATE TYPE "enum_export_scope" AS ENUM ('SINGLE_EVIDENCE', 'CASE', 'MULTIPLE_EVIDENCE');

-- Estado de exportacion
CREATE TYPE "enum_export_status" AS ENUM ('CREATING', 'READY', 'ERROR');

-- ============================================================================
-- TBL-01: users - Usuarios del sistema
-- ============================================================================
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "full_name" VARCHAR(255) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- ============================================================================
-- TBL-02: roles - Roles del sistema
-- ============================================================================
CREATE TABLE "roles" (
    "id" SERIAL NOT NULL,
    "name" "enum_role_name" NOT NULL,
    "description" VARCHAR(255),
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- ============================================================================
-- TBL-03: user_roles - Relacion usuarios-roles (M:N) - PK compuesta
-- ============================================================================
CREATE TABLE "user_roles" (
    "user_id" INTEGER NOT NULL,
    "role_id" INTEGER NOT NULL,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- ============================================================================
-- TBL-04: client_profiles - Perfiles de cliente (1:1 con users)
-- ============================================================================
CREATE TABLE "client_profiles" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "dni" VARCHAR(20),
    "ruc" VARCHAR(20),
    "phone" VARCHAR(20),
    "address" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "client_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_profiles_user_id_key" ON "client_profiles"("user_id");

-- ============================================================================
-- TBL-05: cases - Casos/Expedientes
-- ============================================================================
CREATE TABLE "cases" (
    "id" SERIAL NOT NULL,
    "owner_user_id" INTEGER NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),
    "internal_code" VARCHAR(50),

    CONSTRAINT "cases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cases_internal_code_key" ON "cases"("internal_code");

-- ============================================================================
-- TBL-06: evidence - Evidencias digitales
-- ============================================================================
CREATE TABLE "evidence" (
    "id" SERIAL NOT NULL,
    "owner_user_id" INTEGER NOT NULL,
    "case_id" INTEGER,
    "title" VARCHAR(255),
    "description" TEXT,
    "source_type" "enum_source_type" NOT NULL DEFAULT 'OTHER',
    "status" "enum_evidence_status" NOT NULL DEFAULT 'RECEIVED',
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "evidence_owner_user_id_idx" ON "evidence"("owner_user_id");
CREATE INDEX "evidence_case_id_idx" ON "evidence"("case_id");
CREATE INDEX "evidence_status_idx" ON "evidence"("status");

-- ============================================================================
-- TBL-07: evidence_files - Archivos de evidencia
-- ============================================================================
CREATE TABLE "evidence_files" (
    "id" SERIAL NOT NULL,
    "evidence_id" INTEGER NOT NULL,
    "file_role" "enum_file_role" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "storage_key" VARCHAR(500) NOT NULL,
    "original_filename" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "is_encrypted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "evidence_files_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "evidence_files_evidence_id_idx" ON "evidence_files"("evidence_id");
CREATE INDEX "evidence_files_file_role_idx" ON "evidence_files"("file_role");

-- ============================================================================
-- TBL-08: hash_records - Registros de hash SHA-256
-- ============================================================================
CREATE TABLE "hash_records" (
    "id" SERIAL NOT NULL,
    "evidence_file_id" INTEGER NOT NULL,
    "algorithm" "enum_hash_algorithm" NOT NULL DEFAULT 'SHA256',
    "hash_hex" VARCHAR(64) NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "hash_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "hash_records_hash_hex_idx" ON "hash_records"("hash_hex");

-- ============================================================================
-- TBL-09: custody_events - Eventos de cadena de custodia (append-only)
-- ============================================================================
CREATE TABLE "custody_events" (
    "id" SERIAL NOT NULL,
    "evidence_id" INTEGER NOT NULL,
    "actor_user_id" INTEGER,
    "actor_type" "enum_actor_type" NOT NULL DEFAULT 'USER',
    "event_type" "enum_custody_event_type" NOT NULL,
    "event_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" JSONB,
    "prev_event_hash" VARCHAR(64),
    "event_hash" VARCHAR(64) NOT NULL,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "custody_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "custody_events_evidence_id_idx" ON "custody_events"("evidence_id");
CREATE INDEX "custody_events_event_at_idx" ON "custody_events"("event_at");

-- ============================================================================
-- TBL-10: exports - Exportaciones ZIP forense
-- ============================================================================
CREATE TABLE "exports" (
    "id" SERIAL NOT NULL,
    "requested_by_user_id" INTEGER NOT NULL,
    "scope" "enum_export_scope" NOT NULL,
    "evidence_id" INTEGER,
    "case_id" INTEGER,
    "status" "enum_export_status" NOT NULL DEFAULT 'CREATING',
    "export_file_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "exports_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- TBL-11: export_items - Items de exportacion (M:N) - PK compuesta
-- ============================================================================
CREATE TABLE "export_items" (
    "export_id" INTEGER NOT NULL,
    "evidence_id" INTEGER NOT NULL,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "export_items_pkey" PRIMARY KEY ("export_id","evidence_id")
);

-- ============================================================================
-- TBL-12: audit_log - Log de auditoria general
-- ============================================================================
CREATE TABLE "audit_log" (
    "id" SERIAL NOT NULL,
    "actor_user_id" INTEGER,
    "action" VARCHAR(100) NOT NULL,
    "entity_type" VARCHAR(50) NOT NULL,
    "entity_id" INTEGER,
    "performed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_address" VARCHAR(45),
    "user_agent" TEXT,
    "metadata" JSONB,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_log_actor_user_id_idx" ON "audit_log"("actor_user_id");
CREATE INDEX "audit_log_performed_at_idx" ON "audit_log"("performed_at");
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- ============================================================================
-- TBL-13: metadata_reports - Reportes de metadata tecnica
-- ============================================================================
CREATE TABLE "metadata_reports" (
    "id" SERIAL NOT NULL,
    "evidence_id" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "report_json" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "metadata_reports_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- TBL-14: risk_reports - Reportes de indicios
-- ============================================================================
CREATE TABLE "risk_reports" (
    "id" SERIAL NOT NULL,
    "evidence_id" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "rules_triggered" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "risk_reports_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- TBL-15: sessions - Sesiones de usuario
-- ============================================================================
CREATE TABLE "sessions" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token" VARCHAR(500) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ip_address" VARCHAR(45),
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sessions_token_idx" ON "sessions"("token");
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- ============================================================================
-- TBL-16: permissions - Permisos del sistema (RBAC)
-- ============================================================================
CREATE TABLE "permissions" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(100) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "resource" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- ============================================================================
-- TBL-17: role_permissions - Relacion roles-permisos (M:N) - PK compuesta
-- ============================================================================
CREATE TABLE "role_permissions" (
    "role_id" INTEGER NOT NULL,
    "permission_id" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "user_id_registration" INTEGER,
    "date_time_registration" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id_modification" INTEGER,
    "date_time_modification" TIMESTAMPTZ(6),

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- ============================================================================
-- FOREIGN KEYS
-- ============================================================================

-- user_roles
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- client_profiles
ALTER TABLE "client_profiles" ADD CONSTRAINT "client_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- cases
ALTER TABLE "cases" ADD CONSTRAINT "cases_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- evidence
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- evidence_files
ALTER TABLE "evidence_files" ADD CONSTRAINT "evidence_files_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- hash_records
ALTER TABLE "hash_records" ADD CONSTRAINT "hash_records_evidence_file_id_fkey" FOREIGN KEY ("evidence_file_id") REFERENCES "evidence_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- custody_events
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "custody_events" ADD CONSTRAINT "custody_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- exports
ALTER TABLE "exports" ADD CONSTRAINT "exports_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "exports" ADD CONSTRAINT "exports_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "exports" ADD CONSTRAINT "exports_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "exports" ADD CONSTRAINT "exports_export_file_id_fkey" FOREIGN KEY ("export_file_id") REFERENCES "evidence_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- export_items
ALTER TABLE "export_items" ADD CONSTRAINT "export_items_export_id_fkey" FOREIGN KEY ("export_id") REFERENCES "exports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "export_items" ADD CONSTRAINT "export_items_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- audit_log
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- metadata_reports
ALTER TABLE "metadata_reports" ADD CONSTRAINT "metadata_reports_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- risk_reports
ALTER TABLE "risk_reports" ADD CONSTRAINT "risk_reports_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- sessions
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- role_permissions
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- COMENTARIOS DE DOCUMENTACION
-- ============================================================================
COMMENT ON TABLE "users" IS 'Usuarios del sistema - clientes y administradores';
COMMENT ON TABLE "roles" IS 'Roles disponibles: SUPER_ADMIN, CLIENT';
COMMENT ON TABLE "user_roles" IS 'Relacion M:N entre usuarios y roles (PK compuesta)';
COMMENT ON TABLE "client_profiles" IS 'Perfiles extendidos de clientes (DNI, RUC, telefono)';
COMMENT ON TABLE "cases" IS 'Casos/expedientes que agrupan evidencias';
COMMENT ON TABLE "evidence" IS 'Evidencias digitales con estado de pipeline';
COMMENT ON TABLE "evidence_files" IS 'Archivos fisicos: original, bitcopy, sellado, certificados, reportes';
COMMENT ON TABLE "hash_records" IS 'Registros SHA-256 de cada archivo';
COMMENT ON TABLE "custody_events" IS 'Cadena de custodia inmutable (append-only) con hash encadenado';
COMMENT ON TABLE "exports" IS 'Exportaciones ZIP forense';
COMMENT ON TABLE "export_items" IS 'Evidencias incluidas en cada exportacion (PK compuesta)';
COMMENT ON TABLE "audit_log" IS 'Log general de acciones del sistema';
COMMENT ON TABLE "metadata_reports" IS 'Reportes de metadata tecnica por evidencia';
COMMENT ON TABLE "risk_reports" IS 'Reportes de indicios (nunca afirma manipulacion)';
COMMENT ON TABLE "sessions" IS 'Sesiones activas de usuarios';
COMMENT ON TABLE "permissions" IS 'Permisos del sistema RBAC';
COMMENT ON TABLE "role_permissions" IS 'Asignacion de permisos a roles (PK compuesta)';

-- ============================================================================
-- FIN DEL DDL
-- ============================================================================
