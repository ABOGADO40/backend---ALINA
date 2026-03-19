// ============================================================================
// USER CONTROLLER - Gestion de usuarios
// Sistema PRUEBA DIGITAL
// ============================================================================

const bcrypt = require('bcrypt');
const { prisma } = require('../config/db');
const { createAuditLog } = require('../services/auditService');

const BCRYPT_SALT_ROUNDS = 12;

// ============================================================================
// LISTAR USUARIOS (Solo SUPER_ADMIN)
// ============================================================================

/**
 * GET /api/users
 * Lista todos los usuarios con paginacion
 */
const listUsers = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      role,
      isActive
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    // Construir filtros
    const where = {};

    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { fullName: { contains: search, mode: 'insensitive' } }
      ];
    }

    if (isActive !== undefined) {
      where.isActive = isActive === 'true';
    }

    if (role) {
      where.userRoles = {
        some: {
          role: { name: role }
        }
      };
    }

    // Ejecutar consultas en paralelo
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          userRoles: {
            include: {
              role: { select: { id: true, name: true, description: true } }
            }
          },
          clientProfile: {
            select: { dni: true, ruc: true, phone: true }
          }
        }
      }),
      prisma.user.count({ where })
    ]);

    // Formatear respuesta
    const formattedUsers = users.map(user => ({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      isActive: user.isActive,
      roles: user.userRoles.map(ur => ({
        id: ur.role.id,
        name: ur.role.name,
        description: ur.role.description
      })),
      profile: user.clientProfile,
      createdAt: user.createdAt
    }));

    res.json({
      success: true,
      data: {
        users: formattedUsers,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / take)
        }
      }
    });

  } catch (error) {
    console.error('[UserController] Error listando usuarios:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al listar usuarios'
      }
    });
  }
};

// ============================================================================
// OBTENER USUARIO POR ID
// ============================================================================

/**
 * GET /api/users/:id
 * Obtiene detalle de un usuario
 */
const getUserById = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: parseInt(id) },
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
        clientProfile: true,
        _count: {
          select: {
            ownedCases: true,
            exports: true
          }
        }
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

    // Extraer permisos (filtrar inactivos en JavaScript)
    const permissions = [];
    const permissionCodes = new Set();

    user.userRoles.forEach(ur => {
      ur.role.rolePermissions.forEach(rp => {
        if (rp.permission && rp.permission.isActive && !permissionCodes.has(rp.permission.code)) {
          permissionCodes.add(rp.permission.code);
          permissions.push({
            code: rp.permission.code,
            name: rp.permission.name,
            type: rp.permission.type,
            resource: rp.permission.resource
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
        roles: user.userRoles.map(ur => ({
          id: ur.role.id,
          name: ur.role.name,
          description: ur.role.description
        })),
        permissions,
        profile: user.clientProfile ? {
          dni: user.clientProfile.dni,
          ruc: user.clientProfile.ruc,
          phone: user.clientProfile.phone
        } : null,
        stats: {
          totalCases: user._count.ownedCases,
          totalExports: user._count.exports
        },
        createdAt: user.createdAt
      }
    });

  } catch (error) {
    console.error('[UserController] Error obteniendo usuario:', error);
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
// CREAR USUARIO (Solo SUPER_ADMIN)
// ============================================================================

/**
 * POST /api/users
 * Crea un nuevo usuario
 */
const createUser = async (req, res) => {
  try {
    const { email, password, fullName, roleId, dni, ruc, phone, isActive = true } = req.body;

    // Verificar email duplicado
    const existing = await prisma.user.findUnique({
      where: { email }
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'EMAIL_EXISTS',
          message: 'El email ya esta registrado'
        }
      });
    }

    // Verificar que el rol existe
    const role = await prisma.role.findUnique({
      where: { id: parseInt(roleId) }
    });

    if (!role) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'ROLE_NOT_FOUND',
          message: 'Rol no encontrado'
        }
      });
    }

    // Hashear password
    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

    // Crear usuario con transaccion
    const user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email,
          passwordHash,
          fullName,
          isActive,
          userIdRegistration: req.user.id
        }
      });

      // Asignar rol
      await tx.userRole.create({
        data: {
          userId: newUser.id,
          roleId: parseInt(roleId),
          userIdRegistration: req.user.id
        }
      });

      // Crear perfil si es CLIENT
      if (role.name === 'CLIENT') {
        await tx.clientProfile.create({
          data: {
            userId: newUser.id,
            dni: dni || null,
            ruc: ruc || null,
            phone: phone || null,
            userIdRegistration: req.user.id
          }
        });
      }

      return newUser;
    });

    // Registrar auditoria
    await createAuditLog(
      req.user.id,
      'USER_CREATE',
      'users',
      user.id,
      { email, fullName, roleId },
      req.ip,
      req.get('User-Agent')
    );

    res.status(201).json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        isActive: user.isActive,
        createdAt: user.createdAt
      }
    });

  } catch (error) {
    console.error('[UserController] Error creando usuario:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al crear usuario'
      }
    });
  }
};

// ============================================================================
// ACTUALIZAR USUARIO
// ============================================================================

/**
 * PUT /api/users/:id
 * Actualiza un usuario existente
 */
const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { fullName, password, roleId, dni, ruc, phone, isActive } = req.body;

    const userId = parseInt(id);

    // Verificar que existe
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { clientProfile: true }
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

    // Preparar datos de actualizacion
    const updateData = {
      userIdModification: req.user.id
    };

    if (fullName !== undefined) updateData.fullName = fullName;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (password) {
      updateData.passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    }

    // Actualizar con transaccion
    await prisma.$transaction(async (tx) => {
      // Actualizar usuario
      await tx.user.update({
        where: { id: userId },
        data: updateData
      });

      // Actualizar rol si se proporciona
      if (roleId) {
        // Eliminar roles anteriores
        await tx.userRole.deleteMany({
          where: { userId }
        });

        // Asignar nuevo rol
        await tx.userRole.create({
          data: {
            userId,
            roleId: parseInt(roleId),
            userIdRegistration: req.user.id
          }
        });
      }

      // Actualizar perfil
      if (dni !== undefined || ruc !== undefined || phone !== undefined) {
        if (user.clientProfile) {
          await tx.clientProfile.update({
            where: { userId },
            data: {
              dni: dni !== undefined ? dni : user.clientProfile.dni,
              ruc: ruc !== undefined ? ruc : user.clientProfile.ruc,
              phone: phone !== undefined ? phone : user.clientProfile.phone,
              userIdModification: req.user.id
            }
          });
        } else {
          await tx.clientProfile.create({
            data: {
              userId,
              dni: dni || null,
              ruc: ruc || null,
              phone: phone || null,
              userIdRegistration: req.user.id
            }
          });
        }
      }
    });

    // Registrar auditoria
    await createAuditLog(
      req.user.id,
      'USER_UPDATE',
      'users',
      userId,
      { fullName, roleId, isActive },
      req.ip,
      req.get('User-Agent')
    );

    res.json({
      success: true,
      data: {
        message: 'Usuario actualizado correctamente'
      }
    });

  } catch (error) {
    console.error('[UserController] Error actualizando usuario:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al actualizar usuario'
      }
    });
  }
};

// ============================================================================
// ELIMINAR USUARIO (Soft delete)
// ============================================================================

/**
 * DELETE /api/users/:id
 * Desactiva un usuario (soft delete)
 */
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = parseInt(id);

    // No permitir auto-eliminacion
    if (userId === req.user.id) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'SELF_DELETE_FORBIDDEN',
          message: 'No puede eliminar su propia cuenta'
        }
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId }
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

    // Soft delete
    await prisma.user.update({
      where: { id: userId },
      data: {
        isActive: false,
        userIdModification: req.user.id
      }
    });

    // Invalidar sesiones
    await prisma.session.deleteMany({
      where: { userId }
    });

    // Registrar auditoria
    await createAuditLog(
      req.user.id,
      'USER_DELETE',
      'users',
      userId,
      { email: user.email },
      req.ip,
      req.get('User-Agent')
    );

    res.json({
      success: true,
      data: {
        message: 'Usuario eliminado correctamente'
      }
    });

  } catch (error) {
    console.error('[UserController] Error eliminando usuario:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al eliminar usuario'
      }
    });
  }
};

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  listUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser
};
