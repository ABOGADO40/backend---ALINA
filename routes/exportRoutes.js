// ============================================================================
// EXPORT ROUTES - Rutas de exportacion ZIP forense
// Sistema PRUEBA DIGITAL
// ============================================================================

const express = require('express');
const router = express.Router();
const { body } = require('express-validator');

const { authMiddleware } = require('../middleware/authMiddleware');
const { checkPermission } = require('../middleware/rbacMiddleware');
const { validateRequest } = require('../middleware/validationMiddleware');
const exportController = require('../controllers/exportController');

// ============================================================================
// VALIDADORES
// ============================================================================

const createExportValidators = [
  body('evidenceIds')
    .isArray({ min: 1 })
    .withMessage('Se requiere al menos una evidencia'),
  body('evidenceIds.*')
    .isInt()
    .withMessage('Los IDs de evidencia deben ser numeros enteros'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('La contrasena debe tener al menos 8 caracteres')
];

// ============================================================================
// RUTAS
// ============================================================================

/**
 * GET /api/exports
 * Listar exportaciones del usuario
 */
router.get(
  '/',
  authMiddleware,
  checkPermission('exports:list'),
  exportController.listExports
);

/**
 * GET /api/exports/:id
 * Obtener detalle de exportacion
 */
router.get(
  '/:id',
  authMiddleware,
  checkPermission('exports:view'),
  exportController.getExportById
);

/**
 * POST /api/exports
 * Crear nueva exportacion ZIP forense
 */
router.post(
  '/',
  authMiddleware,
  checkPermission('exports:create'),
  createExportValidators,
  validateRequest,
  exportController.createExport
);

/**
 * GET /api/exports/:id/download
 * Descargar ZIP forense
 */
router.get(
  '/:id/download',
  authMiddleware,
  checkPermission('exports:download'),
  exportController.downloadExport
);

module.exports = router;
