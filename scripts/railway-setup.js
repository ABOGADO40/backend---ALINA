// ============================================================================
// RAILWAY DATABASE SETUP
// Ejecuta migraciones + seed directamente usando pg (no Prisma engine)
// Uso: node scripts/railway-setup.js
// ============================================================================

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

const DATABASE_URL = process.env.DATABASE_URL ||
  'postgresql://postgres:HNkxFRhOjPSFkGIaQMwAziaStixZydKB@autorack.proxy.rlwy.net:17914/railway';

const client = new Client({
  connectionString: DATABASE_URL,
  ssl: false
});

// Orden de migraciones
const MIGRATIONS = [
  '20260118231712_migracion',
  '20260124000000_custody_forensic_upgrade',
  '20260124010000_add_crypto_seal_event_type',
  '20260125000000_normalize_actor_display_name',
  '20260127000000_add_contributor_actas',
  '20260319000000_add_upload_google_drive_event_type',
  '20260324000000_add_contact_fields_to_evidence',
  '20260325000000_add_missing_custody_event_types',
  '20260325010000_add_remaining_missing_enum_values'
];

// Valores de enum que existen en schema.prisma pero no en las migraciones
const EXTRA_ENUM_VALUES = [
  { type: 'enum_custody_event_type', value: 'READY_EXPORT' },
  { type: 'enum_custody_event_type', value: 'MANIFEST_SIGNED' },
  { type: 'enum_custody_event_type', value: 'SCAN' },
  { type: 'enum_custody_event_type', value: 'HASH_CALCULATED' },
  { type: 'enum_custody_event_type', value: 'SEALED_DOC_CREATED' },
  { type: 'enum_custody_event_type', value: 'METADATA_EXTRACTED' },
  { type: 'enum_export_status', value: 'DOWNLOADED' },
  { type: 'enum_file_role', value: 'CERT_TXT' },
];

// Valores de enum_contributor_condition que necesitan sincronizarse con schema.prisma
// Schema tiene: TESTIGO, AGRAVIADO, DENUNCIANTE, TERCERO, OTRO
// Migración crea: VICTIMA, TESTIGO, DENUNCIANTE, PERITO, FUNCIONARIO, REPRESENTANTE_LEGAL, OTRO
const CONTRIBUTOR_ENUM_EXTRA = [
  { type: 'enum_contributor_condition', value: 'AGRAVIADO' },
  { type: 'enum_contributor_condition', value: 'TERCERO' },
];

async function main() {
  await client.connect();
  console.log('Conectado a Railway PostgreSQL\n');

  // Verificar que la BD está vacía (o casi)
  const { rows: tables } = await client.query(`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `);
  console.log(`Tablas existentes: ${tables.length}`);
  if (tables.length > 0) {
    console.log('  -', tables.map(t => t.tablename).join(', '));
  }

  // 1. Crear tabla _prisma_migrations si no existe
  console.log('\n1. Creando tabla _prisma_migrations...');
  await client.query(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" VARCHAR(36) NOT NULL PRIMARY KEY,
      "checksum" VARCHAR(64) NOT NULL,
      "finished_at" TIMESTAMPTZ,
      "migration_name" VARCHAR(255) NOT NULL,
      "logs" TEXT,
      "rolled_back_at" TIMESTAMPTZ,
      "started_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    );
  `);
  console.log('   OK');

  // 2. Ejecutar cada migración
  for (const migName of MIGRATIONS) {
    console.log(`\n2. Ejecutando migración: ${migName}...`);

    // Verificar si ya fue aplicada
    const { rows: existing } = await client.query(
      `SELECT id FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`,
      [migName]
    );

    if (existing.length > 0) {
      console.log('   SKIP (ya aplicada)');
      continue;
    }

    // Leer SQL
    const sqlPath = path.join(__dirname, '..', 'prisma', 'migrations', migName, 'migration.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    // Registrar inicio
    const migId = crypto.randomUUID ? crypto.randomUUID() : require('crypto').randomUUID();
    const startedAt = new Date();

    try {
      await client.query(sql);

      // Registrar éxito
      await client.query(`
        INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
        VALUES ($1, $2, NOW(), $3, $4, 1)
        ON CONFLICT (id) DO NOTHING
      `, [migId, 'manual-' + migName, migName, startedAt]);

      console.log('   OK');
    } catch (err) {
      // Si el error es "already exists", marcar como aplicada
      if (err.code === '42710' || err.code === '42P07' || err.code === '42701') {
        console.log(`   WARN: ${err.message}`);
        console.log('   Marcando como aplicada (objetos ya existen)...');

        await client.query(`
          INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
          VALUES ($1, $2, NOW(), $3, $4, 1)
          ON CONFLICT (id) DO NOTHING
        `, [migId, 'manual-' + migName, migName, startedAt]);
      } else {
        console.error(`   ERROR: ${err.message}`);
        throw err;
      }
    }
  }

  // 3. Agregar valores de enum faltantes
  console.log('\n3. Sincronizando valores de enum con schema.prisma...');
  const allExtraEnums = [...EXTRA_ENUM_VALUES, ...CONTRIBUTOR_ENUM_EXTRA];

  for (const { type, value } of allExtraEnums) {
    try {
      // Verificar si ya existe
      const { rows } = await client.query(`
        SELECT 1 FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid
        WHERE t.typname = $1 AND e.enumlabel = $2
      `, [type, value]);

      if (rows.length === 0) {
        await client.query(`ALTER TYPE "${type}" ADD VALUE '${value}'`);
        console.log(`   + ${type}.${value}`);
      } else {
        console.log(`   = ${type}.${value} (ya existe)`);
      }
    } catch (err) {
      if (err.code === '42710') {
        console.log(`   = ${type}.${value} (ya existe)`);
      } else {
        console.error(`   ERROR: ${type}.${value}: ${err.message}`);
      }
    }
  }

  // 4. Fix: is_public default should be true (schema says true, migration says false)
  console.log('\n4. Ajustando defaults del schema...');
  try {
    await client.query(`ALTER TABLE evidence ALTER COLUMN is_public SET DEFAULT true`);
    console.log('   evidence.is_public DEFAULT = true');
  } catch (err) {
    console.log(`   WARN: ${err.message}`);
  }

  // 5. Verificar unique constraint en custody_events(evidence_id, event_hash)
  console.log('\n5. Verificando constraints adicionales...');
  try {
    const { rows } = await client.query(`
      SELECT 1 FROM pg_indexes WHERE indexname = 'custody_events_evidence_id_event_hash_key'
    `);
    if (rows.length === 0) {
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS "custody_events_evidence_id_event_hash_key"
        ON "custody_events"("evidence_id", "event_hash")
      `);
      console.log('   + custody_events(evidence_id, event_hash) UNIQUE');
    } else {
      console.log('   = custody_events(evidence_id, event_hash) (ya existe)');
    }
  } catch (err) {
    console.log(`   WARN: ${err.message}`);
  }

  // 6. Agregar campos contact_email y contact_phone a evidence si no existen
  try {
    await client.query(`ALTER TABLE evidence ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255)`);
    await client.query(`ALTER TABLE evidence ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(50)`);
    console.log('   + evidence.contact_email, evidence.contact_phone');
  } catch (err) {
    console.log(`   WARN: ${err.message}`);
  }

  // ============================================================================
  // SEED
  // ============================================================================
  console.log('\n============================================');
  console.log('EJECUTANDO SEED');
  console.log('============================================\n');

  // Seed: Roles
  console.log('6. Creando roles...');
  const roles = [
    { name: 'SUPER_ADMIN', description: 'Administrador del sistema con acceso total' },
    { name: 'CLIENT', description: 'Cliente que puede subir y gestionar sus propias evidencias' }
  ];

  const createdRoles = {};
  for (const role of roles) {
    const { rows } = await client.query(`
      INSERT INTO roles (name, description)
      VALUES ($1, $2)
      ON CONFLICT (name) DO UPDATE SET description = $2
      RETURNING id, name
    `, [role.name, role.description]);
    createdRoles[role.name] = rows[0];
    console.log(`   - ${role.name} (ID: ${rows[0].id})`);
  }

  // Seed: Permisos
  console.log('\n7. Creando permisos...');
  const permissions = [
    { code: 'dashboard:view', name: 'Ver Dashboard', type: 'read', resource: 'dashboard' },
    { code: 'dashboard:admin', name: 'Dashboard Administrativo', type: 'read', resource: 'dashboard' },
    { code: 'users:list', name: 'Listar Usuarios', type: 'read', resource: 'users' },
    { code: 'users:view', name: 'Ver Usuario', type: 'read', resource: 'users' },
    { code: 'users:create', name: 'Crear Usuario', type: 'write', resource: 'users' },
    { code: 'users:update', name: 'Actualizar Usuario', type: 'write', resource: 'users' },
    { code: 'users:delete', name: 'Eliminar Usuario', type: 'delete', resource: 'users' },
    { code: 'cases:list', name: 'Listar Casos', type: 'read', resource: 'cases' },
    { code: 'cases:view', name: 'Ver Caso', type: 'read', resource: 'cases' },
    { code: 'cases:create', name: 'Crear Caso', type: 'write', resource: 'cases' },
    { code: 'cases:update', name: 'Actualizar Caso', type: 'write', resource: 'cases' },
    { code: 'cases:delete', name: 'Eliminar Caso', type: 'delete', resource: 'cases' },
    { code: 'cases:list_all', name: 'Listar Todos los Casos', type: 'read', resource: 'cases' },
    { code: 'evidence:list', name: 'Listar Evidencias', type: 'read', resource: 'evidence' },
    { code: 'evidence:view', name: 'Ver Evidencia', type: 'read', resource: 'evidence' },
    { code: 'evidence:upload', name: 'Subir Evidencia', type: 'write', resource: 'evidence' },
    { code: 'evidence:update', name: 'Actualizar Evidencia', type: 'write', resource: 'evidence' },
    { code: 'evidence:download', name: 'Descargar Evidencia', type: 'read', resource: 'evidence' },
    { code: 'evidence:delete', name: 'Eliminar Evidencia', type: 'delete', resource: 'evidence' },
    { code: 'evidence:list_all', name: 'Listar Todas las Evidencias', type: 'read', resource: 'evidence' },
    { code: 'evidence:toggle_public', name: 'Cambiar Visibilidad Publica', type: 'write', resource: 'evidence' },
    { code: 'exports:create', name: 'Crear Exportacion ZIP', type: 'write', resource: 'exports' },
    { code: 'exports:download', name: 'Descargar Exportacion', type: 'read', resource: 'exports' },
    { code: 'exports:list', name: 'Listar Exportaciones', type: 'read', resource: 'exports' },
    { code: 'exports:view', name: 'Ver Detalle de Exportacion', type: 'read', resource: 'exports' },
    { code: 'exports:list_all', name: 'Listar Todas las Exportaciones', type: 'read', resource: 'exports' },
    { code: 'custody:view', name: 'Ver Cadena de Custodia', type: 'read', resource: 'custody' },
    { code: 'custody:export', name: 'Exportar Cadena de Custodia', type: 'read', resource: 'custody' },
    { code: 'custody:view_all', name: 'Ver Toda la Cadena de Custodia', type: 'read', resource: 'custody' },
    { code: 'verification:public', name: 'Verificacion Publica por Hash', type: 'read', resource: 'verification' },
    { code: 'audit:view', name: 'Ver Auditoria', type: 'read', resource: 'audit' },
    { code: 'audit:view_all', name: 'Ver Toda la Auditoria', type: 'read', resource: 'audit' },
    { code: 'reports:metadata', name: 'Ver Reportes de Metadata', type: 'read', resource: 'reports' },
    { code: 'reports:risk', name: 'Ver Reportes de Indicios', type: 'read', resource: 'reports' },
    { code: 'config:roles', name: 'Gestionar Roles', type: 'admin', resource: 'config' },
    { code: 'config:permissions', name: 'Gestionar Permisos', type: 'admin', resource: 'config' }
  ];

  const createdPermissions = {};
  for (const p of permissions) {
    const { rows } = await client.query(`
      INSERT INTO permissions (code, name, type, resource)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (code) DO UPDATE SET name = $2, type = $3, resource = $4
      RETURNING id, code
    `, [p.code, p.name, p.type, p.resource]);
    createdPermissions[p.code] = rows[0];
  }
  console.log(`   ${permissions.length} permisos creados/actualizados`);

  // Seed: Asignar permisos a SUPER_ADMIN (todos)
  console.log('\n8. Asignando permisos a SUPER_ADMIN...');
  for (const p of permissions) {
    await client.query(`
      INSERT INTO role_permissions (role_id, permission_id, is_active)
      VALUES ($1, $2, true)
      ON CONFLICT (role_id, permission_id) DO UPDATE SET is_active = true
    `, [createdRoles['SUPER_ADMIN'].id, createdPermissions[p.code].id]);
  }
  console.log(`   ${permissions.length} permisos asignados`);

  // Seed: Asignar permisos a CLIENT
  console.log('\n9. Asignando permisos a CLIENT...');
  const clientPerms = [
    'dashboard:view', 'cases:list', 'cases:view', 'cases:create', 'cases:update', 'cases:delete',
    'evidence:list', 'evidence:view', 'evidence:upload', 'evidence:download', 'evidence:update',
    'evidence:toggle_public', 'exports:create', 'exports:download', 'exports:list', 'exports:view',
    'custody:view', 'custody:export', 'reports:metadata', 'reports:risk'
  ];
  for (const code of clientPerms) {
    await client.query(`
      INSERT INTO role_permissions (role_id, permission_id, is_active)
      VALUES ($1, $2, true)
      ON CONFLICT (role_id, permission_id) DO UPDATE SET is_active = true
    `, [createdRoles['CLIENT'].id, createdPermissions[code].id]);
  }
  console.log(`   ${clientPerms.length} permisos asignados`);

  // Seed: Usuario admin
  console.log('\n10. Creando usuario administrador...');
  const adminPassword = 'Admin2026$Secure!';
  const hashedPassword = await bcrypt.hash(adminPassword, 12);

  const { rows: adminRows } = await client.query(`
    INSERT INTO users (email, password_hash, full_name, is_active)
    VALUES ($1, $2, $3, true)
    ON CONFLICT (email) DO UPDATE SET password_hash = $2, full_name = $3, is_active = true
    RETURNING id
  `, ['admin@pruebadigital.com', hashedPassword, 'Administrador del Sistema']);

  const adminId = adminRows[0].id;
  console.log(`   admin@pruebadigital.com (ID: ${adminId})`);

  // Asignar rol SUPER_ADMIN
  console.log('\n11. Asignando rol SUPER_ADMIN al admin...');
  await client.query(`
    INSERT INTO user_roles (user_id, role_id)
    VALUES ($1, $2)
    ON CONFLICT (user_id, role_id) DO NOTHING
  `, [adminId, createdRoles['SUPER_ADMIN'].id]);
  console.log('   OK');

  // Actualizar campos de auditoria
  await client.query(`
    UPDATE users SET user_id_registration = $1, user_id_modification = $1, date_time_modification = NOW()
    WHERE id = $1
  `, [adminId]);

  // Resumen
  console.log('\n============================================');
  console.log('SETUP COMPLETADO EXITOSAMENTE');
  console.log('============================================');
  console.log(`  - 5 migraciones aplicadas`);
  console.log(`  - ${Object.keys(createdRoles).length} roles`);
  console.log(`  - ${permissions.length} permisos`);
  console.log(`  - ${clientPerms.length} permisos CLIENT`);
  console.log(`  - Usuario admin: admin@pruebadigital.com`);
  console.log(`  - Password: ${adminPassword}`);
  console.log('============================================\n');

  await client.end();
}

main().catch(async (err) => {
  console.error('\nERROR FATAL:', err);
  await client.end();
  process.exit(1);
});
