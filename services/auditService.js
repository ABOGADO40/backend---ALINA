// ============================================================================
// AUDIT SERVICE - Servicio de auditoria
// Sistema PRUEBA DIGITAL
// ============================================================================

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ============================================================================
// CREAR LOG DE AUDITORIA
// ============================================================================

/**
 * Crea un registro de auditoria
 * @param {number} actorUserId - ID del usuario que realiza la accion
 * @param {string} action - Accion realizada
 * @param {string} entityType - Tipo de entidad afectada
 * @param {number|null} entityId - ID de la entidad afectada
 * @param {Object|null} metadata - Metadata adicional
 * @param {string|null} ipAddress - Direccion IP
 * @param {string|null} userAgent - User Agent del navegador
 * @returns {Promise<Object>} Log creado
 */
async function createAuditLog(
  actorUserId,
  action,
  entityType,
  entityId = null,
  metadata = null,
  ipAddress = null,
  userAgent = null
) {
  try {
    const log = await prisma.auditLog.create({
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

    return log;
  } catch (error) {
    console.error('[AuditService] Error creando log:', error);
    // No lanzar error para no interrumpir el flujo principal
    return null;
  }
}

/**
 * Obtiene logs de auditoria con filtros
 * @param {Object} filters - Filtros de busqueda
 * @returns {Promise<Array>}
 */
async function getAuditLogs(filters = {}) {
  const {
    page = 1,
    limit = 50,
    actorUserId,
    action,
    entityType,
    from,
    to
  } = filters;

  const where = {};

  if (actorUserId) where.actorUserId = actorUserId;
  if (action) where.action = action;
  if (entityType) where.entityType = entityType;

  if (from || to) {
    where.performedAt = {};
    if (from) where.performedAt.gte = new Date(from);
    if (to) where.performedAt.lte = new Date(to);
  }

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: {
        actorUser: {
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
    logs,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  };
}

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  createAuditLog,
  getAuditLogs
};
