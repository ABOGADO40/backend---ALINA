// ============================================================================
// CUSTODY ROUTES - Rutas de cadena de custodia (legacy/alternativas)
// Sistema PRUEBA DIGITAL
//
// NOTA: Las rutas principales de custodia estan bajo /api/evidences/:id/custody
// Estas rutas se mantienen por compatibilidad
// ============================================================================

const express = require('express');
const router = express.Router();

const { authMiddleware } = require('../middleware/authMiddleware');
const { checkPermission } = require('../middleware/rbacMiddleware');
const custodyController = require('../controllers/custodyController');

// ============================================================================
// RUTAS ALTERNATIVAS
// ============================================================================

/**
 * GET /api/custody/evidence/:evidenceId
 * Obtener cadena de custodia (ruta alternativa)
 */
router.get(
  '/evidence/:id',
  authMiddleware,
  checkPermission('custody:view'),
  custodyController.getCustodyChain
);

/**
 * GET /api/custody/evidence/:evidenceId/export
 * Exportar cadena de custodia (ruta alternativa)
 */
router.get(
  '/evidence/:id/export',
  authMiddleware,
  checkPermission('custody:export'),
  custodyController.exportCustodyChain
);

/**
 * GET /api/custody/evidence/:evidenceId/verify
 * Verificar integridad (ruta alternativa)
 */
router.get(
  '/evidence/:id/verify',
  authMiddleware,
  checkPermission('custody:view'),
  custodyController.verifyCustodyIntegrity
);

module.exports = router;
