// ============================================================================
// AUDIT ROUTES - Rutas de auditoria
// Sistema PRUEBA DIGITAL
// ============================================================================

const express = require('express');
const router = express.Router();

const { authMiddleware } = require('../middleware/authMiddleware');
const { checkRole, checkPermission } = require('../middleware/rbacMiddleware');
const auditController = require('../controllers/auditController');

// ============================================================================
// RUTAS (Solo SUPER_ADMIN)
// ============================================================================

/**
 * GET /api/audit
 * Listar logs de auditoria
 */
router.get(
  '/',
  authMiddleware,
  checkRole('SUPER_ADMIN'),
  auditController.listAuditLogs
);

/**
 * GET /api/audit/stats
 * Obtener estadisticas de auditoria
 */
router.get(
  '/stats',
  authMiddleware,
  checkRole('SUPER_ADMIN'),
  auditController.getAuditStats
);

/**
 * GET /api/audit/export
 * Exportar logs de auditoria
 */
router.get(
  '/export',
  authMiddleware,
  checkRole('SUPER_ADMIN'),
  auditController.exportAuditLogs
);

/**
 * GET /api/audit/:id
 * Obtener log de auditoria por ID
 */
router.get(
  '/:id',
  authMiddleware,
  checkRole('SUPER_ADMIN'),
  auditController.getAuditLogById
);

module.exports = router;
