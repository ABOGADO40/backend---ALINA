// ============================================================================
// PRUEBA DIGITAL - SEED.JS
// Datos iniciales REALES para produccion (NO MOCKS)
// Tablas pobladas: Role, Permission, RolePermission, User, UserRole
// Version: 2.0
// Fecha: 2026-03-18
// ============================================================================

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Configuracion
const BCRYPT_SALT_ROUNDS = 12;

// ============================================================================
// DATOS INICIALES - ROLES
// ============================================================================
const roles = [
  {
    name: 'SUPER_ADMIN',
    description: 'Administrador del sistema con acceso total'
  },
  {
    name: 'CLIENT',
    description: 'Cliente que puede subir y gestionar sus propias evidencias'
  }
];

// ============================================================================
// DATOS INICIALES - PERMISOS DEL SISTEMA
// ============================================================================
const permissions = [
  // Permisos de Dashboard
  {
    code: 'dashboard:view',
    name: 'Ver Dashboard',
    type: 'read',
    resource: 'dashboard'
  },
  {
    code: 'dashboard:admin',
    name: 'Dashboard Administrativo',
    type: 'read',
    resource: 'dashboard'
  },

  // Permisos de Usuarios
  {
    code: 'users:list',
    name: 'Listar Usuarios',
    type: 'read',
    resource: 'users'
  },
  {
    code: 'users:view',
    name: 'Ver Usuario',
    type: 'read',
    resource: 'users'
  },
  {
    code: 'users:create',
    name: 'Crear Usuario',
    type: 'write',
    resource: 'users'
  },
  {
    code: 'users:update',
    name: 'Actualizar Usuario',
    type: 'write',
    resource: 'users'
  },
  {
    code: 'users:delete',
    name: 'Eliminar Usuario',
    type: 'delete',
    resource: 'users'
  },

  // Permisos de Casos
  {
    code: 'cases:list',
    name: 'Listar Casos',
    type: 'read',
    resource: 'cases'
  },
  {
    code: 'cases:view',
    name: 'Ver Caso',
    type: 'read',
    resource: 'cases'
  },
  {
    code: 'cases:create',
    name: 'Crear Caso',
    type: 'write',
    resource: 'cases'
  },
  {
    code: 'cases:update',
    name: 'Actualizar Caso',
    type: 'write',
    resource: 'cases'
  },
  {
    code: 'cases:delete',
    name: 'Eliminar Caso',
    type: 'delete',
    resource: 'cases'
  },
  {
    code: 'cases:list_all',
    name: 'Listar Todos los Casos',
    type: 'read',
    resource: 'cases'
  },

  // Permisos de Evidencias
  {
    code: 'evidence:list',
    name: 'Listar Evidencias',
    type: 'read',
    resource: 'evidence'
  },
  {
    code: 'evidence:view',
    name: 'Ver Evidencia',
    type: 'read',
    resource: 'evidence'
  },
  {
    code: 'evidence:upload',
    name: 'Subir Evidencia',
    type: 'write',
    resource: 'evidence'
  },
  {
    code: 'evidence:update',
    name: 'Actualizar Evidencia',
    type: 'write',
    resource: 'evidence'
  },
  {
    code: 'evidence:download',
    name: 'Descargar Evidencia',
    type: 'read',
    resource: 'evidence'
  },
  {
    code: 'evidence:delete',
    name: 'Eliminar Evidencia',
    type: 'delete',
    resource: 'evidence'
  },
  {
    code: 'evidence:list_all',
    name: 'Listar Todas las Evidencias',
    type: 'read',
    resource: 'evidence'
  },
  {
    code: 'evidence:toggle_public',
    name: 'Cambiar Visibilidad Publica',
    type: 'write',
    resource: 'evidence'
  },

  // Permisos de Exportacion
  {
    code: 'exports:create',
    name: 'Crear Exportacion ZIP',
    type: 'write',
    resource: 'exports'
  },
  {
    code: 'exports:download',
    name: 'Descargar Exportacion',
    type: 'read',
    resource: 'exports'
  },
  {
    code: 'exports:list',
    name: 'Listar Exportaciones',
    type: 'read',
    resource: 'exports'
  },
  {
    code: 'exports:view',
    name: 'Ver Detalle de Exportacion',
    type: 'read',
    resource: 'exports'
  },
  {
    code: 'exports:list_all',
    name: 'Listar Todas las Exportaciones',
    type: 'read',
    resource: 'exports'
  },

  // Permisos de Custodia
  {
    code: 'custody:view',
    name: 'Ver Cadena de Custodia',
    type: 'read',
    resource: 'custody'
  },
  {
    code: 'custody:export',
    name: 'Exportar Cadena de Custodia',
    type: 'read',
    resource: 'custody'
  },
  {
    code: 'custody:view_all',
    name: 'Ver Toda la Cadena de Custodia',
    type: 'read',
    resource: 'custody'
  },

  // Permisos de Verificacion Publica
  {
    code: 'verification:public',
    name: 'Verificacion Publica por Hash',
    type: 'read',
    resource: 'verification'
  },

  // Permisos de Auditoria
  {
    code: 'audit:view',
    name: 'Ver Auditoria',
    type: 'read',
    resource: 'audit'
  },
  {
    code: 'audit:view_all',
    name: 'Ver Toda la Auditoria',
    type: 'read',
    resource: 'audit'
  },

  // Permisos de Reportes
  {
    code: 'reports:metadata',
    name: 'Ver Reportes de Metadata',
    type: 'read',
    resource: 'reports'
  },
  {
    code: 'reports:risk',
    name: 'Ver Reportes de Indicios',
    type: 'read',
    resource: 'reports'
  },

  // Permisos de Configuracion
  {
    code: 'config:roles',
    name: 'Gestionar Roles',
    type: 'admin',
    resource: 'config'
  },
  {
    code: 'config:permissions',
    name: 'Gestionar Permisos',
    type: 'admin',
    resource: 'config'
  }
];

// ============================================================================
// ASIGNACION DE PERMISOS POR ROL
// ============================================================================

// Permisos para SUPER_ADMIN (todos)
const superAdminPermissions = permissions.map(p => p.code);

// Permisos para CLIENT (limitados a sus propios recursos)
const clientPermissions = [
  'dashboard:view',
  'cases:list',
  'cases:view',
  'cases:create',
  'cases:update',
  'cases:delete',
  'evidence:list',
  'evidence:view',
  'evidence:upload',
  'evidence:download',
  'evidence:update',
  'evidence:toggle_public',
  'exports:create',
  'exports:download',
  'exports:list',
  'exports:view',
  'custody:view',
  'custody:export',
  'reports:metadata',
  'reports:risk'
];

// ============================================================================
// USUARIO ADMIN INICIAL
// ============================================================================
const adminUser = {
  email: 'admin@pruebadigital.com',
  password: 'Admin2026$Secure!', // Sera hasheada
  fullName: 'Administrador del Sistema'
};

// ============================================================================
// FUNCION PRINCIPAL DE SEED
// ============================================================================
async function main() {
  console.log('============================================');
  console.log('INICIANDO SEED DE BASE DE DATOS');
  console.log('============================================\n');

  try {
    // 1. Crear Roles
    console.log('1. Creando roles...');
    const createdRoles = {};

    for (const roleData of roles) {
      const role = await prisma.role.upsert({
        where: { name: roleData.name },
        update: { description: roleData.description },
        create: roleData
      });
      createdRoles[roleData.name] = role;
      console.log(`   - Rol creado/actualizado: ${roleData.name} (ID: ${role.id})`);
    }
    console.log('   Roles completados.\n');

    // 2. Crear Permisos
    console.log('2. Creando permisos...');
    const createdPermissions = {};

    for (const permData of permissions) {
      const permission = await prisma.permission.upsert({
        where: { code: permData.code },
        update: {
          name: permData.name,
          type: permData.type,
          resource: permData.resource
        },
        create: permData
      });
      createdPermissions[permData.code] = permission;
    }
    console.log(`   - ${permissions.length} permisos creados/actualizados.`);
    console.log('   Permisos completados.\n');

    // 3. Asignar permisos a SUPER_ADMIN
    console.log('3. Asignando permisos a SUPER_ADMIN...');
    const superAdminRole = createdRoles['SUPER_ADMIN'];

    for (const permCode of superAdminPermissions) {
      const permission = createdPermissions[permCode];
      if (permission) {
        await prisma.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: superAdminRole.id,
              permissionId: permission.id
            }
          },
          update: { isActive: true },
          create: {
            roleId: superAdminRole.id,
            permissionId: permission.id,
            isActive: true
          }
        });
      }
    }
    console.log(`   - ${superAdminPermissions.length} permisos asignados a SUPER_ADMIN.`);
    console.log('   Asignacion SUPER_ADMIN completada.\n');

    // 4. Asignar permisos a CLIENT
    console.log('4. Asignando permisos a CLIENT...');
    const clientRole = createdRoles['CLIENT'];

    for (const permCode of clientPermissions) {
      const permission = createdPermissions[permCode];
      if (permission) {
        await prisma.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: clientRole.id,
              permissionId: permission.id
            }
          },
          update: { isActive: true },
          create: {
            roleId: clientRole.id,
            permissionId: permission.id,
            isActive: true
          }
        });
      }
    }
    console.log(`   - ${clientPermissions.length} permisos asignados a CLIENT.`);
    console.log('   Asignacion CLIENT completada.\n');

    // 5. Crear Usuario Admin
    console.log('5. Creando usuario administrador...');

    // Hashear password con bcrypt
    const hashedPassword = await bcrypt.hash(adminUser.password, BCRYPT_SALT_ROUNDS);

    const admin = await prisma.user.upsert({
      where: { email: adminUser.email },
      update: {
        fullName: adminUser.fullName,
        passwordHash: hashedPassword,
        isActive: true
      },
      create: {
        email: adminUser.email,
        passwordHash: hashedPassword,
        fullName: adminUser.fullName,
        isActive: true
      }
    });
    console.log(`   - Usuario admin creado: ${admin.email} (ID: ${admin.id})`);

    // 6. Asignar rol SUPER_ADMIN al usuario admin
    console.log('6. Asignando rol SUPER_ADMIN al usuario admin...');

    await prisma.userRole.upsert({
      where: {
        userId_roleId: {
          userId: admin.id,
          roleId: superAdminRole.id
        }
      },
      update: {},
      create: {
        userId: admin.id,
        roleId: superAdminRole.id
      }
    });
    console.log('   - Rol SUPER_ADMIN asignado al admin.');

    // 7. Actualizar campos de auditoria del admin (auto-referencia)
    console.log('7. Actualizando campos de auditoria...');

    await prisma.user.update({
      where: { id: admin.id },
      data: {
        userIdRegistration: admin.id,
        userIdModification: admin.id,
        dateTimeModification: new Date()
      }
    });
    console.log('   - Campos de auditoria actualizados.\n');

    // Resumen final
    console.log('============================================');
    console.log('SEED COMPLETADO EXITOSAMENTE');
    console.log('============================================');
    console.log('\nResumen:');
    console.log(`  - Roles creados: ${Object.keys(createdRoles).length}`);
    console.log(`  - Permisos creados: ${Object.keys(createdPermissions).length}`);
    console.log(`  - Asignaciones SUPER_ADMIN: ${superAdminPermissions.length}`);
    console.log(`  - Asignaciones CLIENT: ${clientPermissions.length}`);
    console.log(`  - Usuario admin: ${adminUser.email}`);
    if (!IS_PRODUCTION) {
      console.log('\nCredenciales de acceso (solo visible en desarrollo):');
      console.log(`  - Email: ${adminUser.email}`);
      console.log(`  - Password: ${adminUser.password}`);
    }
    console.log('\nIMPORTANTE: Cambie la contrasena despues del primer login.');
    console.log('============================================\n');

  } catch (error) {
    console.error('\nERROR durante el seed:', error);
    throw error;
  }
}

// ============================================================================
// EJECUTAR SEED
// ============================================================================
main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
