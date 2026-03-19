// ============================================================================
// AUTH CONTROLLER - Controlador de autenticacion
// Sistema PRUEBA DIGITAL
// ============================================================================

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { createAuditLog } = require('../services/auditService');

const prisma = new PrismaClient();
const BCRYPT_SALT_ROUNDS = 12;

// ============================================================================
// REGISTRO DE CLIENTE
// ============================================================================

/**
 * POST /api/auth/register
 * Registra un nuevo cliente en el sistema
 */
const register = async (req, res) => {
  try {
    const { email, password, fullName, dni, ruc, phone } = req.body;

    // Verificar si el email ya existe
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'EMAIL_EXISTS',
          message: 'El email ya esta registrado'
        }
      });
    }

    // Hashear password
    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

    // Obtener rol CLIENT
    const clientRole = await prisma.role.findUnique({
      where: { name: 'CLIENT' }
    });

    if (!clientRole) {
      return res.status(500).json({
        success: false,
        error: {
          code: 'ROLE_NOT_FOUND',
          message: 'Rol de cliente no configurado en el sistema'
        }
      });
    }

    // Crear usuario con transaccion
    const user = await prisma.$transaction(async (tx) => {
      // Crear usuario
      const newUser = await tx.user.create({
        data: {
          email,
          passwordHash,
          fullName,
          isActive: true
        }
      });

      // Asignar rol CLIENT
      await tx.userRole.create({
        data: {
          userId: newUser.id,
          roleId: clientRole.id,
          userIdRegistration: newUser.id
        }
      });

      // Crear perfil de cliente
      await tx.clientProfile.create({
        data: {
          userId: newUser.id,
          dni: dni || null,
          ruc: ruc || null,
          phone: phone || null,
          userIdRegistration: newUser.id
        }
      });

      // Actualizar campos de auditoria del usuario
      await tx.user.update({
        where: { id: newUser.id },
        data: {
          userIdRegistration: newUser.id
        }
      });

      return newUser;
    });

    // Generar token JWT
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        roles: ['CLIENT']
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '4h' }
    );

    // Crear sesion en BD (igual que en login)
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 4);

    await prisma.session.create({
      data: {
        userId: user.id,
        token,
        expiresAt,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
        userIdRegistration: user.id
      }
    });

    // Registrar auditoria
    await createAuditLog(
      user.id,
      'USER_REGISTER',
      'users',
      user.id,
      { email },
      req.ip,
      req.get('User-Agent')
    );

    res.status(201).json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          roles: ['CLIENT']
        },
        token,
        expiresIn: process.env.JWT_EXPIRES_IN || '4h'
      }
    });

  } catch (error) {
    console.error('[AuthController] Error en registro:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al registrar usuario'
      }
    });
  }
};

// ============================================================================
// LOGIN
// ============================================================================

/**
 * POST /api/auth/login
 * Inicia sesion y retorna token JWT
 */
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Buscar usuario con roles y permisos
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

    // Verificar si existe
    if (!user) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'Correo no registrado'
        }
      });
    }

    // Verificar si esta activo
    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'USER_INACTIVE',
          message: 'Usuario inactivo'
        }
      });
    }

    // Verificar password
    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'CREDENTIALS_INVALID',
          message: 'Contrasena incorrecta'
        }
      });
    }

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

    // Generar token JWT
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        roles
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '4h' }
    );

    // Crear sesion en BD
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 4);

    await prisma.session.create({
      data: {
        userId: user.id,
        token,
        expiresAt,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
        userIdRegistration: user.id
      }
    });

    // Registrar auditoria
    await createAuditLog(
      user.id,
      'USER_LOGIN',
      'sessions',
      null,
      { email },
      req.ip,
      req.get('User-Agent')
    );

    res.json({
      success: true,
      data: {
        mensaje: 'Login exitoso',
        token,
        usuario: {
          id: user.id,
          nombres: user.fullName,
          correo: user.email,
          id_rol: user.userRoles[0]?.roleId || null,
          rol: roles[0] || null,
          permisos: permissions
        }
      }
    });

  } catch (error) {
    console.error('[AuthController] Error en login:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al iniciar sesion'
      }
    });
  }
};

// ============================================================================
// LOGOUT
// ============================================================================

/**
 * POST /api/auth/logout
 * Cierra la sesion del usuario
 */
const logout = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (token) {
      // Eliminar sesion
      await prisma.session.deleteMany({
        where: { token }
      });
    }

    // Registrar auditoria
    await createAuditLog(
      req.user.id,
      'USER_LOGOUT',
      'sessions',
      null,
      null,
      req.ip,
      req.get('User-Agent')
    );

    res.json({
      success: true,
      data: {
        mensaje: 'Sesion cerrada exitosamente'
      }
    });

  } catch (error) {
    console.error('[AuthController] Error en logout:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al cerrar sesion'
      }
    });
  }
};

// ============================================================================
// ME (Usuario actual)
// ============================================================================

/**
 * GET /api/auth/me
 * Obtiene informacion del usuario autenticado
 */
const me = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
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

    if (!user) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'Usuario no encontrado'
        }
      });
    }

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

    res.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        isActive: user.isActive,
        roles,
        permisos: permissions,
        profile: user.clientProfile ? {
          dni: user.clientProfile.dni,
          ruc: user.clientProfile.ruc,
          phone: user.clientProfile.phone
        } : null,
        createdAt: user.createdAt
      }
    });

  } catch (error) {
    console.error('[AuthController] Error en me:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al obtener usuario'
      }
    });
  }
};

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  register,
  login,
  logout,
  me
};
