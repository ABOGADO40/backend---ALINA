// ============================================================================
// USER MODEL - CRUD de usuarios
// Sistema PRUEBA DIGITAL
// ============================================================================

const { prisma } = require('../config/db');

// ============================================================================
// LISTAR USUARIOS
// ============================================================================

/**
 * Lista usuarios con filtros y paginacion
 * @param {Object} options - Opciones de filtrado y paginacion
 * @returns {Promise<{users: Array, total: number}>}
 */
const listUsers = async (options = {}) => {
  const {
    page = 1,
    limit = 10,
    search,
    role,
    isActive
  } = options;

  const where = {};

  // Filtro de busqueda por nombre o email
  if (search) {
    where.OR = [
      { fullName: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } }
    ];
  }

  // Filtro por estado activo
  if (typeof isActive === 'boolean') {
    where.isActive = isActive;
  }

  // Filtro por rol
  if (role) {
    where.userRoles = {
      some: {
        role: { name: role }
      }
    };
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      include: {
        userRoles: {
          include: {
            role: {
              select: { name: true }
            }
          }
        },
        clientProfile: true
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit
    }),
    prisma.user.count({ where })
  ]);

  return {
    users: users.map(user => ({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      isActive: user.isActive,
      roles: user.userRoles.map(ur => ur.role.name),
      profile: user.clientProfile,
      createdAt: user.createdAt
    })),
    total
  };
};

// ============================================================================
// OBTENER USUARIO POR ID
// ============================================================================

/**
 * Obtiene un usuario por su ID
 * @param {number} userId - ID del usuario
 * @returns {Promise<Object|null>}
 */
const getUserById = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      userRoles: {
        include: {
          role: {
            select: { id: true, name: true }
          }
        }
      },
      clientProfile: true
    }
  });

  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    isActive: user.isActive,
    roles: user.userRoles.map(ur => ur.role.name),
    profile: user.clientProfile ? {
      dni: user.clientProfile.dni,
      ruc: user.clientProfile.ruc,
      phone: user.clientProfile.phone,
      address: user.clientProfile.address
    } : null,
    createdAt: user.createdAt
  };
};

// ============================================================================
// ACTUALIZAR USUARIO
// ============================================================================

/**
 * Actualiza datos de un usuario
 * @param {number} userId - ID del usuario
 * @param {Object} data - Datos a actualizar
 * @param {number} modifiedBy - ID del usuario que modifica
 * @returns {Promise<Object>}
 */
const updateUser = async (userId, data, modifiedBy) => {
  const { fullName, phone, dni, ruc, address, isActive } = data;

  // Actualizar en transaccion
  return prisma.$transaction(async (tx) => {
    // Actualizar usuario
    const userUpdateData = {
      userIdModification: modifiedBy,
      dateTimeModification: new Date()
    };

    if (fullName !== undefined) userUpdateData.fullName = fullName;
    if (isActive !== undefined) userUpdateData.isActive = isActive;

    const user = await tx.user.update({
      where: { id: userId },
      data: userUpdateData
    });

    // Actualizar perfil si existe
    const profile = await tx.clientProfile.findUnique({
      where: { userId }
    });

    if (profile) {
      const profileUpdateData = {
        userIdModification: modifiedBy,
        dateTimeModification: new Date()
      };

      if (phone !== undefined) profileUpdateData.phone = phone;
      if (dni !== undefined) profileUpdateData.dni = dni;
      if (ruc !== undefined) profileUpdateData.ruc = ruc;
      if (address !== undefined) profileUpdateData.address = address;

      await tx.clientProfile.update({
        where: { userId },
        data: profileUpdateData
      });
    }

    return getUserById(userId);
  });
};

// ============================================================================
// CAMBIAR CONTRASENA
// ============================================================================

/**
 * Actualiza la contrasena de un usuario
 * @param {number} userId - ID del usuario
 * @param {string} newPasswordHash - Nueva contrasena hasheada
 * @param {number} modifiedBy - ID del usuario que modifica
 * @returns {Promise<Object>}
 */
const updatePassword = async (userId, newPasswordHash, modifiedBy) => {
  return prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: newPasswordHash,
      userIdModification: modifiedBy,
      dateTimeModification: new Date()
    }
  });
};

// ============================================================================
// OBTENER CONTRASENA ACTUAL
// ============================================================================

/**
 * Obtiene la contrasena hasheada de un usuario
 * @param {number} userId - ID del usuario
 * @returns {Promise<string|null>}
 */
const getPasswordHash = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true }
  });
  return user?.passwordHash || null;
};

// ============================================================================
// VERIFICAR EMAIL EXISTE
// ============================================================================

/**
 * Verifica si un email ya esta registrado
 * @param {string} email - Email a verificar
 * @param {number} excludeUserId - ID de usuario a excluir (para updates)
 * @returns {Promise<boolean>}
 */
const emailExists = async (email, excludeUserId = null) => {
  const where = { email };
  if (excludeUserId) {
    where.NOT = { id: excludeUserId };
  }

  const count = await prisma.user.count({ where });
  return count > 0;
};

// ============================================================================
// CREAR USUARIO CON ROL Y PERFIL
// ============================================================================

/**
 * Crea un nuevo usuario con rol y perfil de cliente
 * @param {Object} userData - Datos del usuario
 * @returns {Promise<Object>}
 */
const createUser = async (userData) => {
  const {
    email,
    passwordHash,
    fullName,
    roleId,
    dni,
    ruc,
    phone,
    createdBy
  } = userData;

  return prisma.$transaction(async (tx) => {
    // Crear usuario
    const user = await tx.user.create({
      data: {
        email,
        passwordHash,
        fullName,
        isActive: true,
        userIdRegistration: createdBy
      }
    });

    // Asignar rol
    await tx.userRole.create({
      data: {
        userId: user.id,
        roleId,
        userIdRegistration: createdBy || user.id
      }
    });

    // Crear perfil de cliente
    await tx.clientProfile.create({
      data: {
        userId: user.id,
        dni: dni || null,
        ruc: ruc || null,
        phone: phone || null,
        userIdRegistration: createdBy || user.id
      }
    });

    // Actualizar campo de auditoria
    await tx.user.update({
      where: { id: user.id },
      data: { userIdRegistration: createdBy || user.id }
    });

    return getUserById(user.id);
  });
};

// ============================================================================
// OBTENER ROL POR NOMBRE
// ============================================================================

/**
 * Obtiene un rol por su nombre
 * @param {string} roleName - Nombre del rol
 * @returns {Promise<Object|null>}
 */
const getRoleByName = async (roleName) => {
  return prisma.role.findUnique({
    where: { name: roleName }
  });
};

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  listUsers,
  getUserById,
  updateUser,
  updatePassword,
  getPasswordHash,
  emailExists,
  createUser,
  getRoleByName
};
