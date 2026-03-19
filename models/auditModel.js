// ============================================================================
// AUDIT MODEL - Logs de auditoria
// Sistema PRUEBA DIGITAL
// ============================================================================

const { prisma } = require('../config/db');

// ============================================================================
// CREAR LOG DE AUDITORIA
// ============================================================================

/**
 * Crea un registro de auditoria
 * @param {Object} logData - Datos del log
 * @returns {Promise<Object>}
 */
const createAuditLog = async (logData) => {
  const {
    actorUserId,
    action,
    entityType,
    entityId,
    metadata,
    ipAddress,
    userAgent
  } = logData;

  return prisma.auditLog.create({
    data: {
      actorUserId,
      action,
      entityType,
      entityId,
      metadata: metadata ? JSON.stringify(metadata) : null,
      ipAddress,
      userAgent,
      userIdRegistration: actorUserId
    }
  });
};

// ============================================================================
// LISTAR LOGS DE AUDITORIA
// ============================================================================

/**
 * Lista logs de auditoria con filtros
 * @param {Object} options - Opciones de filtrado
 * @returns {Promise<{logs: Array, total: number}>}
 */
const listAuditLogs = async (options = {}) => {
  const {
    page = 1,
    limit = 50,
    actorUserId,
    action,
    entityType,
    entityId,
    from,
    to
  } = options;

  const where = {};

  if (actorUserId) where.actorUserId = actorUserId;
  if (action) where.action = action;
  if (entityType) where.entityType = entityType;
  if (entityId) where.entityId = entityId;

  if (from || to) {
    where.performedAt = {};
    if (from) where.performedAt.gte = new Date(from);
    if (to) where.performedAt.lte = new Date(to);
  }

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: {
        actor: {
          select: {
            id: true,
            email: true,
            fullName: true
          }
        }
      },
      orderBy: { performedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit
    }),
    prisma.auditLog.count({ where })
  ]);

  return {
    logs: logs.map(log => ({
      id: log.id,
      actor: log.actor,
      action: log.action,
      entityType: log.entityType,
      entityId: log.entityId,
      performedAt: log.performedAt,
      ipAddress: log.ipAddress,
      userAgent: log.userAgent,
      metadata: log.metadata ? JSON.parse(log.metadata) : null
    })),
    total
  };
};

// ============================================================================
// OBTENER LOGS POR ENTIDAD
// ============================================================================

/**
 * Obtiene logs de auditoria de una entidad especifica
 * @param {string} entityType - Tipo de entidad
 * @param {number} entityId - ID de la entidad
 * @returns {Promise<Array>}
 */
const getLogsByEntity = async (entityType, entityId) => {
  return prisma.auditLog.findMany({
    where: {
      entityType,
      entityId
    },
    include: {
      actor: {
        select: {
          id: true,
          fullName: true
        }
      }
    },
    orderBy: { performedAt: 'desc' }
  });
};

// ============================================================================
// OBTENER LOGS POR USUARIO
// ============================================================================

/**
 * Obtiene logs de auditoria de un usuario
 * @param {number} userId - ID del usuario
 * @param {number} limit - Limite de resultados
 * @returns {Promise<Array>}
 */
const getLogsByUser = async (userId, limit = 100) => {
  return prisma.auditLog.findMany({
    where: { actorUserId: userId },
    orderBy: { performedAt: 'desc' },
    take: limit
  });
};

// ============================================================================
// OBTENER ACCIONES UNICAS
// ============================================================================

/**
 * Obtiene lista de acciones unicas registradas
 * @returns {Promise<Array<string>>}
 */
const getUniqueActions = async () => {
  const actions = await prisma.auditLog.findMany({
    select: { action: true },
    distinct: ['action']
  });
  return actions.map(a => a.action);
};

// ============================================================================
// OBTENER TIPOS DE ENTIDAD UNICOS
// ============================================================================

/**
 * Obtiene lista de tipos de entidad unicos
 * @returns {Promise<Array<string>>}
 */
const getUniqueEntityTypes = async () => {
  const types = await prisma.auditLog.findMany({
    select: { entityType: true },
    distinct: ['entityType']
  });
  return types.map(t => t.entityType);
};

// ============================================================================
// EXPORTAR LOGS
// ============================================================================

/**
 * Exporta logs de auditoria en un rango de fechas
 * @param {Date} from - Fecha inicio
 * @param {Date} to - Fecha fin
 * @returns {Promise<Array>}
 */
const exportLogs = async (from, to) => {
  return prisma.auditLog.findMany({
    where: {
      performedAt: {
        gte: from,
        lte: to
      }
    },
    include: {
      actor: {
        select: {
          id: true,
          email: true,
          fullName: true
        }
      }
    },
    orderBy: { performedAt: 'asc' }
  });
};

// ============================================================================
// CONTAR LOGS
// ============================================================================

/**
 * Cuenta logs de auditoria con filtros
 * @param {Object} filters - Filtros
 * @returns {Promise<number>}
 */
const countLogs = async (filters = {}) => {
  const where = {};

  if (filters.actorUserId) where.actorUserId = filters.actorUserId;
  if (filters.action) where.action = filters.action;
  if (filters.entityType) where.entityType = filters.entityType;

  return prisma.auditLog.count({ where });
};

// ============================================================================
// ESTADISTICAS DE AUDITORIA
// ============================================================================

/**
 * Obtiene estadisticas de auditoria
 * @returns {Promise<Object>}
 */
const getAuditStats = async () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [
    totalLogs,
    todayLogs,
    uniqueUsers,
    topActions
  ] = await Promise.all([
    prisma.auditLog.count(),
    prisma.auditLog.count({
      where: { performedAt: { gte: today } }
    }),
    prisma.auditLog.findMany({
      select: { actorUserId: true },
      distinct: ['actorUserId']
    }),
    prisma.auditLog.groupBy({
      by: ['action'],
      _count: { action: true },
      orderBy: { _count: { action: 'desc' } },
      take: 10
    })
  ]);

  return {
    totalLogs,
    todayLogs,
    uniqueUsers: uniqueUsers.length,
    topActions: topActions.map(a => ({
      action: a.action,
      count: a._count.action
    }))
  };
};

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  createAuditLog,
  listAuditLogs,
  getLogsByEntity,
  getLogsByUser,
  getUniqueActions,
  getUniqueEntityTypes,
  exportLogs,
  countLogs,
  getAuditStats
};
