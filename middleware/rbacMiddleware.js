// ============================================================================
// RBAC MIDDLEWARE - Control de permisos basado en roles
// Sistema PRUEBA DIGITAL
// ============================================================================

const { prisma } = require('../config/db');

// ============================================================================
// PERMISOS POR DEFECTO POR ROL
// ============================================================================

const DEFAULT_PERMISSIONS = {
  SUPER_ADMIN: [
    // Todos los permisos
    'ADMIN_ALL',
    // Usuarios
    'users:list', 'users:view', 'users:create', 'users:update', 'users:delete',
    // Casos
    'cases:list', 'cases:view', 'cases:create', 'cases:update', 'cases:delete',
    // Evidencias
    'evidence:list', 'evidence:view', 'evidence:upload', 'evidence:update',
    'evidence:delete', 'evidence:download', 'evidence:toggle_public',
    // Exportaciones
    'exports:list', 'exports:view', 'exports:create', 'exports:download',
    // Auditoria
    'audit:list', 'audit:export',
    // Custodia
    'custody:view', 'custody:export'
  ],
  CLIENT: [
    // Casos propios
    'cases:list', 'cases:view', 'cases:create', 'cases:update', 'cases:delete',
    // Evidencias propias
    'evidence:list', 'evidence:view', 'evidence:upload', 'evidence:update', 'evidence:download', 'evidence:toggle_public',
    // Exportaciones propias
    'exports:list', 'exports:view', 'exports:create', 'exports:download',
    // Custodia propia
    'custody:view', 'custody:export'
  ]
};

// ============================================================================
// MIDDLEWARE DE VERIFICACION DE PERMISO
// ============================================================================

/**
 * Verifica que el usuario tenga el permiso requerido
 * @param {string} requiredPermission - Codigo del permiso requerido
 * @returns {Function} Middleware de Express
 */
const checkPermission = (requiredPermission) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'AUTH_REQUIRED',
          message: 'Autenticacion requerida'
        }
      });
    }

    // SUPER_ADMIN tiene todos los permisos
    if (req.user.roles.includes('SUPER_ADMIN')) {
      return next();
    }

    // Verificar permiso ADMIN_ALL
    if (req.user.permissions.includes('ADMIN_ALL')) {
      return next();
    }

    // Verificar permiso especifico
    if (req.user.permissions.includes(requiredPermission)) {
      return next();
    }

    // Verificar permisos por defecto del rol
    for (const role of req.user.roles) {
      const defaultPerms = DEFAULT_PERMISSIONS[role] || [];
      if (defaultPerms.includes(requiredPermission)) {
        return next();
      }
    }

    return res.status(403).json({
      success: false,
      error: {
        code: 'PERMISSION_DENIED',
        message: `No tiene permiso para esta accion: ${requiredPermission}`
      }
    });
  };
};

// ============================================================================
// MIDDLEWARE DE VERIFICACION DE ROL
// ============================================================================

/**
 * Verifica que el usuario tenga uno de los roles requeridos
 * @param  {...string} allowedRoles - Roles permitidos
 * @returns {Function} Middleware de Express
 */
const checkRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'AUTH_REQUIRED',
          message: 'Autenticacion requerida'
        }
      });
    }

    const hasRole = req.user.roles.some(role => allowedRoles.includes(role));

    if (!hasRole) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'ROLE_DENIED',
          message: `Se requiere rol: ${allowedRoles.join(' o ')}`
        }
      });
    }

    next();
  };
};

// ============================================================================
// MIDDLEWARE DE VERIFICACION DE PROPIEDAD
// ============================================================================

/**
 * Verifica que el usuario sea propietario del recurso o SUPER_ADMIN
 * @param {string} model - Nombre del modelo Prisma
 * @param {string} ownerField - Campo que contiene el ID del propietario
 * @param {string} paramName - Nombre del parametro en la URL
 * @returns {Function} Middleware de Express
 */
const checkOwnership = (model, ownerField = 'ownerUserId', paramName = 'id') => {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'AUTH_REQUIRED',
          message: 'Autenticacion requerida'
        }
      });
    }

    // SUPER_ADMIN puede acceder a todo
    if (req.user.roles.includes('SUPER_ADMIN')) {
      return next();
    }

    const resourceId = parseInt(req.params[paramName]);
    if (isNaN(resourceId)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'ID de recurso invalido'
        }
      });
    }

    try {
      // Buscar recurso en la base de datos
      const resource = await prisma[model].findUnique({
        where: { id: resourceId },
        select: { [ownerField]: true }
      });

      if (!resource) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Recurso no encontrado'
          }
        });
      }

      // Verificar propiedad
      if (resource[ownerField] !== req.user.id) {
        return res.status(403).json({
          success: false,
          error: {
            code: 'RESOURCE_FORBIDDEN',
            message: 'No tiene acceso a este recurso'
          }
        });
      }

      // Agregar recurso al request para evitar consulta duplicada
      req.resource = resource;

      next();

    } catch (error) {
      console.error('[RBACMiddleware] Error verificando propiedad:', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Error al verificar acceso'
        }
      });
    }
  };
};

// ============================================================================
// MIDDLEWARE DE VERIFICACION DE PROPIEDAD O PERMISO ESPECIAL
// ============================================================================

/**
 * Verifica propiedad o un permiso especial para acceder a recurso
 * @param {string} model - Nombre del modelo
 * @param {string} specialPermission - Permiso que permite acceso sin ser propietario
 * @param {string} ownerField - Campo del propietario
 */
const checkOwnershipOrPermission = (model, specialPermission, ownerField = 'ownerUserId') => {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'AUTH_REQUIRED',
          message: 'Autenticacion requerida'
        }
      });
    }

    // SUPER_ADMIN o permiso especial
    if (req.user.roles.includes('SUPER_ADMIN') ||
        req.user.permissions.includes(specialPermission) ||
        req.user.permissions.includes('ADMIN_ALL')) {
      return next();
    }

    // Verificar propiedad
    const resourceId = parseInt(req.params.id);
    if (isNaN(resourceId)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ID',
          message: 'ID invalido'
        }
      });
    }

    try {
      const resource = await prisma[model].findUnique({
        where: { id: resourceId },
        select: { [ownerField]: true }
      });

      if (!resource) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Recurso no encontrado'
          }
        });
      }

      if (resource[ownerField] !== req.user.id) {
        return res.status(403).json({
          success: false,
          error: {
            code: 'RESOURCE_FORBIDDEN',
            message: 'No tiene acceso a este recurso'
          }
        });
      }

      req.resource = resource;
      next();

    } catch (error) {
      console.error('[RBACMiddleware] Error:', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Error al verificar acceso'
        }
      });
    }
  };
};

// ============================================================================
// UTILIDAD: VERIFICAR PERMISO SIN MIDDLEWARE
// ============================================================================

/**
 * Verifica si un usuario tiene un permiso (para uso en controladores)
 * @param {Object} user - Usuario del request
 * @param {string} permission - Permiso a verificar
 * @returns {boolean}
 */
const hasPermission = (user, permission) => {
  if (!user) return false;

  // SUPER_ADMIN tiene todo
  if (user.roles.includes('SUPER_ADMIN')) return true;

  // ADMIN_ALL
  if (user.permissions.includes('ADMIN_ALL')) return true;

  // Permiso especifico
  if (user.permissions.includes(permission)) return true;

  // Permisos por defecto del rol
  for (const role of user.roles) {
    const defaultPerms = DEFAULT_PERMISSIONS[role] || [];
    if (defaultPerms.includes(permission)) return true;
  }

  return false;
};

/**
 * Verifica si un usuario tiene un rol
 * @param {Object} user - Usuario del request
 * @param {string} role - Rol a verificar
 * @returns {boolean}
 */
const hasRole = (user, role) => {
  return user?.roles?.includes(role) || false;
};

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  checkPermission,
  checkRole,
  checkOwnership,
  checkOwnershipOrPermission,
  hasPermission,
  hasRole,
  DEFAULT_PERMISSIONS
};
