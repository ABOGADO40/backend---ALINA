// ============================================================================
// LEGAL ROUTES - Rutas de documentos legales (Privacidad y Terminos)
// Sistema PRUEBA DIGITAL
// ============================================================================

const express = require('express');
const router = express.Router();

const { authMiddleware } = require('../middleware/authMiddleware');
const { checkRole } = require('../middleware/rbacMiddleware');
const legalController = require('../controllers/legalController');

// ============================================================================
// RUTAS PUBLICAS (sin autenticacion)
// ============================================================================

/**
 * GET /api/legal/privacy
 * Devuelve la Politica de Privacidad vigente. Acceso publico.
 */
router.get('/privacy', legalController.getPrivacyPolicy);

/**
 * GET /api/legal/terms
 * Devuelve los Terminos y Condiciones vigentes. Acceso publico.
 */
router.get('/terms', legalController.getTermsAndConditions);

// ============================================================================
// RUTAS PROTEGIDAS (SOLO SUPER_ADMIN)
// ============================================================================

/**
 * GET /api/legal
 * Devuelve ambos documentos con metadatos. Solo SUPER_ADMIN.
 */
router.get(
  '/',
  authMiddleware,
  checkRole('SUPER_ADMIN'),
  legalController.listLegalDocuments
);

/**
 * PUT /api/legal/:type
 * Actualiza el contenido de un documento legal. Solo SUPER_ADMIN.
 * type ∈ { 'privacy', 'terms' }
 */
router.put(
  '/:type',
  authMiddleware,
  checkRole('SUPER_ADMIN'),
  legalController.updateLegalDocument
);

module.exports = router;
