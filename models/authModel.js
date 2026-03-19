// ============================================================================
// AUTH MODEL - Consultas de autenticacion
// Sistema PRUEBA DIGITAL
// ============================================================================

const { prisma } = require('../config/db');

// ============================================================================
// BUSCAR USUARIO POR EMAIL CON ROL Y PERMISOS
// ============================================================================

/**
 * Buscar usuario por correo con su rol y permisos
 * @param {string} email - Correo del usuario
 * @returns {Promise<Object|null>} Usuario con sus datos, rol y permisos
 */
const findUserByEmail = async (email) => {
  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      userRoles: {
        include: {
          role: {
            include: {
              rolePermissions: {
                where: { isActive: true },
                include: {
                  permission: true
                }
              }
            }
          }
        }
      },
      clientProfile: true
    }
  });

  if (!user) return null;

  // Extraer roles y permisos
  const roles = user.userRoles.map(ur => ur.role.name);
  const permissions = [];
  const permissionCodes = new Set();

  user.userRoles.forEach(ur => {
    ur.role.rolePermissions.forEach(rp => {
      // Filtrar permisos inactivos en JavaScript
      if (rp.permission && rp.permission.isActive && !permissionCodes.has(rp.permission.code)) {
        permissionCodes.add(rp.permission.code);
        permissions.push({
          codigo: rp.permission.code,
          nombre: rp.permission.name,
          tipo: rp.permission.type,
          recurso: rp.permission.resource
        });
      }
    });
  });

  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    passwordHash: user.passwordHash,
    isActive: user.isActive,
    roles,
    permissions,
    roleId: user.userRoles[0]?.roleId || null,
    roleName: roles[0] || null,
    profile: user.clientProfile
  };
};

// ============================================================================
// BUSCAR USUARIO POR ID
// ============================================================================

/**
 * Buscar usuario por ID con rol y permisos
 * @param {number} userId - ID del usuario
 * @returns {Promise<Object|null>}
 */
const findUserById = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      userRoles: {
        include: {
          role: {
            include: {
              rolePermissions: {
                where: { isActive: true },
                include: {
                  permission: true
                }
              }
            }
          }
        }
      },
      clientProfile: true
    }
  });

  if (!user) return null;

  const roles = user.userRoles.map(ur => ur.role.name);
  const permissions = [];
  const permissionCodes = new Set();

  user.userRoles.forEach(ur => {
    ur.role.rolePermissions.forEach(rp => {
      // Filtrar permisos inactivos en JavaScript
      if (rp.permission && rp.permission.isActive && !permissionCodes.has(rp.permission.code)) {
        permissionCodes.add(rp.permission.code);
        permissions.push({
          codigo: rp.permission.code,
          nombre: rp.permission.name,
          tipo: rp.permission.type,
          recurso: rp.permission.resource
        });
      }
    });
  });

  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    isActive: user.isActive,
    roles,
    permissions,
    profile: user.clientProfile,
    createdAt: user.createdAt
  };
};

// ============================================================================
// CREAR SESION
// ============================================================================

/**
 * Crea una nueva sesion en la base de datos
 * @param {Object} sessionData - Datos de la sesion
 * @returns {Promise<Object>}
 */
const createSession = async (sessionData) => {
  return prisma.session.create({
    data: {
      userId: sessionData.userId,
      token: sessionData.token,
      expiresAt: sessionData.expiresAt,
      ipAddress: sessionData.ipAddress,
      userAgent: sessionData.userAgent,
      userIdRegistration: sessionData.userId
    }
  });
};

// ============================================================================
// ELIMINAR SESION
// ============================================================================

/**
 * Elimina una sesion por token
 * @param {string} token - Token de la sesion
 * @returns {Promise<number>}
 */
const deleteSessionByToken = async (token) => {
  const result = await prisma.session.deleteMany({
    where: { token }
  });
  return result.count;
};

// ============================================================================
// VALIDAR SESION
// ============================================================================

/**
 * Valida si una sesion existe y no ha expirado
 * @param {string} token - Token de la sesion
 * @returns {Promise<Object|null>}
 */
const validateSession = async (token) => {
  return prisma.session.findFirst({
    where: {
      token,
      expiresAt: { gt: new Date() }
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          isActive: true
        }
      }
    }
  });
};

// ============================================================================
// LIMPIAR SESIONES EXPIRADAS
// ============================================================================

/**
 * Elimina sesiones expiradas
 * @returns {Promise<number>}
 */
const cleanExpiredSessions = async () => {
  const result = await prisma.session.deleteMany({
    where: {
      expiresAt: { lt: new Date() }
    }
  });
  return result.count;
};

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  findUserByEmail,
  findUserById,
  createSession,
  deleteSessionByToken,
  validateSession,
  cleanExpiredSessions
};
