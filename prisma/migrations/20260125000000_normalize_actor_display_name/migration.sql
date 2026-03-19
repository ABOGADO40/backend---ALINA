-- ============================================================================
-- Migration: normalize_actor_display_name
-- Sistema PRUEBA DIGITAL
-- Plan: Opcion B - Normalizacion Completa del Sistema de Eventos Forenses
-- ============================================================================

-- 1. Agregar columna actor_display_name a custody_events
ALTER TABLE custody_events
ADD COLUMN IF NOT EXISTS actor_display_name VARCHAR(255);

-- 2. Migrar datos existentes de details._actor.displayName a la nueva columna
UPDATE custody_events
SET actor_display_name = (details->>'_actor')::jsonb->>'displayName'
WHERE actor_display_name IS NULL
  AND details IS NOT NULL
  AND details ? '_actor'
  AND details->>'_actor' IS NOT NULL;

-- 3. Para eventos con actorUserId, obtener nombre del usuario
UPDATE custody_events ce
SET actor_display_name = u.full_name
FROM users u
WHERE ce.actor_display_name IS NULL
  AND ce.actor_user_id IS NOT NULL
  AND ce.actor_user_id = u.id;

-- 4. Para eventos SYSTEM sin displayName
UPDATE custody_events
SET actor_display_name = 'Sistema PRUEBA DIGITAL'
WHERE actor_display_name IS NULL
  AND actor_type = 'SYSTEM';

-- 5. Para eventos PUBLIC sin displayName
UPDATE custody_events
SET actor_display_name = 'Verificador Publico'
WHERE actor_display_name IS NULL
  AND actor_type = 'PUBLIC';

-- 6. Crear indice para busquedas por actor
CREATE INDEX IF NOT EXISTS idx_custody_events_actor_display_name
ON custody_events(actor_display_name);

-- 7. Agregar EVENTLOG al enum FileRole (si no existe)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'enum_file_role' AND e.enumlabel = 'EVENTLOG') THEN
        ALTER TYPE enum_file_role ADD VALUE 'EVENTLOG';
    END IF;
END$$;
