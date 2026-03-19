// ============================================================================
// AUTH MIDDLEWARE - Middleware de autenticacion y autorizacion
// Sistema PRUEBA DIGITAL
// ============================================================================

const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ============================================================================
// MIDDLEWARE DE AUTENTICACION
// ============================================================================

/**
 * Verifica que el usuario este autenticado con un token JWT valido
 */
const authMiddleware = async (req, res, next) => {
  try {
    // Obtener token del header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'AUTH_REQUIRED',
          message: 'Token de autenticacion no proporcionado'
        }
      });
    }

    const token = authHeader.split(' ')[1];

    // Verificar token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          error: {
            code: 'TOKEN_EXPIRED',
            message: 'Token expirado'
          }
        });
      }
      return res.status(401).json({
        success: false,
        error: {
          code: 'TOKEN_INVALID',
          message: 'Token invalido'
        }
      });
    }

    // Verificar que la sesion exista en BD
    const session = await prisma.session.findFirst({
      where: {
        token,
        expiresAt: { gt: new Date() }
      }
    });

    if (!session) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'SESSION_INVALID',
          message: 'Sesion invalida o expirada'
        }
      });
    }

    // Obtener usuario con roles y permisos
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
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
        }
      }
    });

    if (!user || !user.isActive) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'USER_INACTIVE',
          message: 'Usuario no encontrado o inactivo'
        }
      });
    }

    // Extraer roles y permisos
    const roles = user.userRoles.map(ur => ur.role.name);
    const permissions = new Set();

    user.userRoles.forEach(ur => {
      ur.role.rolePermissions.forEach(rp => {
        if (rp.permission) {
          permissions.add(rp.permission.code);
        }
      });
    });

    // Agregar usuario al request
    req.user = {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      roles,
      permissions: Array.from(permissions)
    };

    next();

  } catch (error) {
    console.error('[AuthMiddleware] Error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error de autenticacion'
      }
    });
  }
};

// ============================================================================
// MIDDLEWARE DE AUTORIZACION POR PERMISO
// ============================================================================

/**
 * Verifica que el usuario tenga el permiso requerido
 * @param {string} requiredPermission - Codigo del permiso requerido
 */
const requirePermission = (requiredPermission) => {
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

    // Verificar permiso especifico
    if (!req.user.permissions.includes(requiredPermission)) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'PERMISSION_DENIED',
          message: `Permiso requerido: ${requiredPermission}`
        }
      });
    }

    next();
  };
};

// ============================================================================
// MIDDLEWARE DE AUTORIZACION POR ROL
// ============================================================================

/**
 * Verifica que el usuario tenga uno de los roles requeridos
 * @param {...string} allowedRoles - Roles permitidos
 */
const requireRole = (...allowedRoles) => {
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
          message: `Rol requerido: ${allowedRoles.join(' o ')}`
        }
      });
    }

    next();
  };
};

// ============================================================================
// MIDDLEWARE OPCIONAL DE AUTENTICACION
// ============================================================================

/**
 * Intenta autenticar pero permite continuar sin autenticacion
 * Util para endpoints que funcionan diferente segun el usuario
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null;
      return next();
    }

    const token = authHeader.split(' ')[1];

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
        include: {
          userRoles: {
            include: {
              role: true
            }
          }
        }
      });

      if (user && user.isActive) {
        req.user = {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          roles: user.userRoles.map(ur => ur.role.name)
        };
      } else {
        req.user = null;
      }
    } catch {
      req.user = null;
    }

    next();

  } catch (error) {
    req.user = null;
    next();
  }
};

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  authMiddleware,
  requirePermission,
  requireRole,
  optionalAuth
};
