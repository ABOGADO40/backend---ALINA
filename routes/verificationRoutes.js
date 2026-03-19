// ============================================================================
// VERIFICATION ROUTES - Rutas de verificacion publica + forense (admin)
// Sistema PRUEBA DIGITAL
// ============================================================================

const express = require('express');
const router = express.Router();
const { body, param } = require('express-validator');

const { validateRequest } = require('../middleware/validationMiddleware');
const { authMiddleware, requireRole } = require('../middleware/authMiddleware');
const verificationController = require('../controllers/verificationController');

// ============================================================================
// VALIDADORES
// ============================================================================

const hashParamValidator = [
  param('hash')
    .isLength({ min: 64, max: 64 })
    .withMessage('Hash debe ser de 64 caracteres')
    .matches(/^[a-fA-F0-9]{64}$/)
    .withMessage('Hash debe contener solo caracteres hexadecimales')
];

const batchValidators = [
  body('hashes')
    .isArray({ min: 1, max: 50 })
    .withMessage('Se requiere un array de 1 a 50 hashes')
];

const uuidParamValidator = [
  param('uuid')
    .isUUID(4)
    .withMessage('UUID de evidencia invalido')
];

// ============================================================================
// RUTAS PUBLICAS (sin autenticacion)
// ============================================================================

/**
 * GET /api/verify/:hash
 * Verificacion publica por hash SHA-256
 */
router.get(
  '/:hash',
  hashParamValidator,
  validateRequest,
  verificationController.verifyByHash
);

/**
 * POST /api/verify/batch
 * Verificacion de multiples hashes
 */
router.post(
  '/batch',
  batchValidators,
  validateRequest,
  verificationController.verifyBatch
);

/**
 * GET /api/verify/:hash/custody
 * Obtener cadena de custodia publica por hash
 */
router.get(
  '/:hash/custody',
  hashParamValidator,
  validateRequest,
  verificationController.getCustodyByHash
);

// ============================================================================
// RUTAS PROTEGIDAS - VERIFICACION FORENSE (solo SUPER_ADMIN)
// ============================================================================

/**
 * POST /api/verify/forensic/:uuid
 * Verificacion forense completa de cadena de custodia
 * Verifica: cadena de eventos, eventlog hash, manifest hash, firma Ed25519
 */
router.post(
  '/forensic/:uuid',
  authMiddleware,
  requireRole('SUPER_ADMIN'),
  uuidParamValidator,
  validateRequest,
  verificationController.verifyChainForensic
);

/**
 * GET /api/verify/forensic/:uuid/status
 * Obtener estado rapido de integridad de una evidencia
 */
router.get(
  '/forensic/:uuid/status',
  authMiddleware,
  requireRole('SUPER_ADMIN'),
  uuidParamValidator,
  validateRequest,
  verificationController.getIntegrityStatus
);

/**
 * POST /api/verify/package/:uuid
 * Verificacion de paquete de evidencia completo (checklist L)
 * Retorna PASS/FAIL con primer motivo de falla
 */
router.post(
  '/package/:uuid',
  authMiddleware,
  requireRole('SUPER_ADMIN'),
  uuidParamValidator,
  validateRequest,
  verificationController.verifyEvidencePackage
);

module.exports = router;
