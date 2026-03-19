// ============================================================================
// AUDIT CONTROLLER - Consulta de logs de auditoria
// Sistema PRUEBA DIGITAL
// ============================================================================

const { prisma } = require('../config/db');
const { createAuditLog } = require('../services/auditService');

// ============================================================================
// LISTAR LOGS DE AUDITORIA
// ============================================================================

/**
 * GET /api/audit
 * Lista logs de auditoria con filtros (Solo SUPER_ADMIN)
 */
const listAuditLogs = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      userId,
      action,
      entityType,
      dateFrom,
      dateTo
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    // Construir filtros
    const where = {};

    if (userId) {
      where.actorUserId = parseInt(userId);
    }

    if (action) {
      where.action = action;
    }

    if (entityType) {
      where.entityType = entityType;
    }

    if (dateFrom || dateTo) {
      where.performedAt = {};
      if (dateFrom) {
        where.performedAt.gte = new Date(dateFrom);
      }
      if (dateTo) {
        where.performedAt.lte = new Date(dateTo);
      }
    }

    // Ejecutar consultas
    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        skip,
        take,
        orderBy: { performedAt: 'desc' },
        include: {
          actor: {
            select: { id: true, email: true, fullName: true }
          }
        }
      }),
      prisma.auditLog.count({ where })
    ]);

    // Formatear respuesta
    const formattedLogs = logs.map(log => ({
      id: log.id,
      action: log.action,
      entityType: log.entityType,
      entityId: log.entityId,
      metadata: log.metadata,
      ipAddress: log.ipAddress,
      userAgent: log.userAgent,
      user: log.actor,
      performedAt: log.performedAt
    }));

    res.json({
      success: true,
      data: {
        logs: formattedLogs,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / take)
        }
      }
    });

  } catch (error) {
    console.error('[AuditController] Error listando logs:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al listar logs de auditoria'
      }
    });
  }
};

// ============================================================================
// OBTENER ESTADISTICAS DE AUDITORIA
// ============================================================================

/**
 * GET /api/audit/stats
 * Obtiene estadisticas de auditoria (Solo SUPER_ADMIN)
 */
const getAuditStats = async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;

    const where = {};
    if (dateFrom || dateTo) {
      where.performedAt = {};
      if (dateFrom) where.performedAt.gte = new Date(dateFrom);
      if (dateTo) where.performedAt.lte = new Date(dateTo);
    }

    // Obtener conteos por accion
    const actionCounts = await prisma.auditLog.groupBy({
      by: ['action'],
      where,
      _count: { action: true },
      orderBy: { _count: { action: 'desc' } }
    });

    // Obtener conteos por entityType
    const entityTypeCounts = await prisma.auditLog.groupBy({
      by: ['entityType'],
      where,
      _count: { entityType: true },
      orderBy: { _count: { entityType: 'desc' } }
    });

    // Obtener actividad por usuario (top 10)
    const userActivity = await prisma.auditLog.groupBy({
      by: ['actorUserId'],
      where: { ...where, actorUserId: { not: null } },
      _count: { actorUserId: true },
      orderBy: { _count: { actorUserId: 'desc' } },
      take: 10
    });

    // Obtener emails de usuarios
    const userIds = userActivity.map(u => u.actorUserId).filter(Boolean);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, fullName: true }
    });
    const userMap = new Map(users.map(u => [u.id, u]));

    // Total de logs
    const totalLogs = await prisma.auditLog.count({ where });

    // Logs ultimas 24 horas
    const last24h = await prisma.auditLog.count({
      where: {
        ...where,
        performedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      }
    });

    res.json({
      success: true,
      data: {
        total: totalLogs,
        last24Hours: last24h,
        byAction: actionCounts.map(a => ({
          action: a.action,
          count: a._count.action
        })),
        byEntityType: entityTypeCounts.map(t => ({
          entityType: t.entityType,
          count: t._count.entityType
        })),
        topUsers: userActivity.map(u => ({
          user: userMap.get(u.actorUserId) || { id: u.actorUserId },
          count: u._count.actorUserId
        }))
      }
    });

  } catch (error) {
    console.error('[AuditController] Error obteniendo estadisticas:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al obtener estadisticas'
      }
    });
  }
};

// ============================================================================
// EXPORTAR LOGS DE AUDITORIA
// ============================================================================

/**
 * GET /api/audit/export
 * Exporta logs de auditoria en formato JSON (Solo SUPER_ADMIN)
 */
const exportAuditLogs = async (req, res) => {
  try {
    const { dateFrom, dateTo, format = 'json' } = req.query;

    const where = {};
    if (dateFrom || dateTo) {
      where.performedAt = {};
      if (dateFrom) where.performedAt.gte = new Date(dateFrom);
      if (dateTo) where.performedAt.lte = new Date(dateTo);
    }

    // Limitar a ultimos 10000 registros
    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { performedAt: 'desc' },
      take: 10000,
      include: {
        actor: {
          select: { id: true, email: true, fullName: true }
        }
      }
    });

    // Registrar auditoria de la exportacion
    await createAuditLog(
      req.user.id,
      'AUDIT_EXPORT',
      'audit_logs',
      null,
      { count: logs.length, dateFrom, dateTo },
      req.ip,
      req.get('User-Agent')
    );

    if (format === 'csv') {
      // Exportar como CSV
      const csv = generateCsv(logs);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="audit_logs_${new Date().toISOString().split('T')[0]}.csv"`);
      return res.send(csv);
    }

    // Exportar como JSON
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="audit_logs_${new Date().toISOString().split('T')[0]}.json"`);

    res.json({
      exportedAt: new Date().toISOString(),
      totalRecords: logs.length,
      dateRange: {
        from: dateFrom || 'all',
        to: dateTo || 'now'
      },
      logs: logs.map(log => ({
        id: log.id,
        action: log.action,
        entityType: log.entityType,
        entityId: log.entityId,
        metadata: log.metadata,
        ipAddress: log.ipAddress,
        userAgent: log.userAgent,
        user: log.actor,
        performedAt: log.performedAt
      }))
    });

  } catch (error) {
    console.error('[AuditController] Error exportando logs:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al exportar logs'
      }
    });
  }
};

/**
 * Genera CSV a partir de logs
 */
function generateCsv(logs) {
  const headers = [
    'ID',
    'Accion',
    'EntityType',
    'EntityID',
    'Usuario',
    'Email',
    'IP',
    'Fecha'
  ];

  const rows = logs.map(log => [
    log.id,
    log.action,
    log.entityType,
    log.entityId || '',
    log.actor?.fullName || 'Sistema',
    log.actor?.email || '',
    log.ipAddress || '',
    log.performedAt.toISOString()
  ]);

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
  ].join('\n');

  return csvContent;
}

// ============================================================================
// OBTENER LOG POR ID
// ============================================================================

/**
 * GET /api/audit/:id
 * Obtiene detalle de un log de auditoria
 */
const getAuditLogById = async (req, res) => {
  try {
    const { id } = req.params;

    const log = await prisma.auditLog.findUnique({
      where: { id: parseInt(id) },
      include: {
        actor: {
          select: { id: true, email: true, fullName: true }
        }
      }
    });

    if (!log) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'LOG_NOT_FOUND',
          message: 'Log de auditoria no encontrado'
        }
      });
    }

    res.json({
      success: true,
      data: {
        id: log.id,
        action: log.action,
        entityType: log.entityType,
        entityId: log.entityId,
        metadata: log.metadata,
        ipAddress: log.ipAddress,
        userAgent: log.userAgent,
        user: log.actor,
        performedAt: log.performedAt
      }
    });

  } catch (error) {
    console.error('[AuditController] Error obteniendo log:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al obtener log'
      }
    });
  }
};

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  listAuditLogs,
  getAuditStats,
  exportAuditLogs,
  getAuditLogById
};
