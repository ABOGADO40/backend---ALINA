-- ============================================================================
-- Migration: add_contributor_actas
-- Sistema PRUEBA DIGITAL
-- Sincronizacion de tablas faltantes en Railway
-- ============================================================================

-- 1. Agregar columna entity a users (si no existe)
ALTER TABLE users
ADD COLUMN IF NOT EXISTS entity VARCHAR(500);

-- 2. Crear enum para condicion del aportante
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enum_contributor_condition') THEN
        CREATE TYPE enum_contributor_condition AS ENUM (
            'VICTIMA',
            'TESTIGO',
            'DENUNCIANTE',
            'PERITO',
            'FUNCIONARIO',
            'REPRESENTANTE_LEGAL',
            'OTRO'
        );
    END IF;
END$$;

-- 3. Crear tabla evidence_contributor_records
CREATE TABLE IF NOT EXISTS evidence_contributor_records (
    id SERIAL PRIMARY KEY,
    evidence_id INTEGER NOT NULL,
    acta_lugar VARCHAR(500) NOT NULL,
    acta_entidad_interviniente VARCHAR(500) NOT NULL,
    usuario_entidad VARCHAR(500),
    aportante_nombre_completo VARCHAR(255) NOT NULL,
    aportante_documento_tipo VARCHAR(50) DEFAULT 'DNI',
    aportante_documento_numero VARCHAR(50) NOT NULL,
    aportante_condicion enum_contributor_condition NOT NULL,
    aportante_condicion_otro VARCHAR(255),
    aportante_domicilio VARCHAR(500),
    aportante_telefono VARCHAR(50),
    aportante_correo VARCHAR(255),
    dispositivo_origen VARCHAR(500),
    fecha_obtencion_archivo DATE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    user_id_registration INTEGER,
    date_time_registration TIMESTAMPTZ DEFAULT NOW(),
    user_id_modification INTEGER,
    date_time_modification TIMESTAMPTZ,
    CONSTRAINT fk_contributor_evidence FOREIGN KEY (evidence_id)
        REFERENCES evidence(id) ON DELETE CASCADE ON UPDATE NO ACTION
);

-- 4. Crear indice para evidence_contributor_records
CREATE INDEX IF NOT EXISTS idx_contributor_evidence_id
ON evidence_contributor_records(evidence_id);

-- 5. Crear tabla generated_actas
CREATE TABLE IF NOT EXISTS generated_actas (
    id SERIAL PRIMARY KEY,
    evidence_id INTEGER NOT NULL,
    contributor_record_id INTEGER NOT NULL,
    acta_uuid UUID DEFAULT gen_random_uuid() UNIQUE,
    acta_numero VARCHAR(50),
    pdf_hash_sha256 VARCHAR(64),
    pdf_storage_key VARCHAR(500),
    pdf_size_bytes BIGINT,
    generated_at TIMESTAMPTZ DEFAULT NOW(),
    generated_by_user_id INTEGER,
    user_id_registration INTEGER,
    date_time_registration TIMESTAMPTZ DEFAULT NOW(),
    user_id_modification INTEGER,
    date_time_modification TIMESTAMPTZ,
    CONSTRAINT fk_acta_evidence FOREIGN KEY (evidence_id)
        REFERENCES evidence(id) ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT fk_acta_contributor FOREIGN KEY (contributor_record_id)
        REFERENCES evidence_contributor_records(id) ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT fk_acta_user FOREIGN KEY (generated_by_user_id)
        REFERENCES users(id) ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- 6. Crear indices para generated_actas
CREATE INDEX IF NOT EXISTS idx_generated_actas_evidence
ON generated_actas(evidence_id);

CREATE INDEX IF NOT EXISTS idx_generated_actas_contributor
ON generated_actas(contributor_record_id);

CREATE INDEX IF NOT EXISTS idx_generated_actas_uuid
ON generated_actas(acta_uuid);

-- 7. Crear tabla de backup (opcional, ignorada por Prisma)
CREATE TABLE IF NOT EXISTS custody_events_details_backup (
    id INTEGER,
    event_uuid UUID,
    details JSONB,
    backed_up_at TIMESTAMPTZ
);

-- 8. Agregar comentarios descriptivos
COMMENT ON TABLE evidence_contributor_records IS 'Registros de aportantes de evidencia para actas';
COMMENT ON TABLE generated_actas IS 'Actas generadas en PDF para evidencias';
COMMENT ON COLUMN users.entity IS 'Entidad u organizacion del usuario';

-- 9. Crear secuencia para numeracion de actas
CREATE SEQUENCE IF NOT EXISTS acta_numero_seq
START WITH 1
INCREMENT BY 1
NO MINVALUE
NO MAXVALUE
CACHE 1;
