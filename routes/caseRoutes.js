// ============================================================================
// CASE ROUTES - Rutas de casos/expedientes
// Sistema PRUEBA DIGITAL
// ============================================================================

const express = require('express');
const router = express.Router();
const { body } = require('express-validator');

const { authMiddleware } = require('../middleware/authMiddleware');
const { checkPermission } = require('../middleware/rbacMiddleware');
const { validateRequest } = require('../middleware/validationMiddleware');
const caseController = require('../controllers/caseController');

// ============================================================================
// VALIDADORES
// ============================================================================

const createCaseValidators = [
  body('title')
    .isLength({ min: 3, max: 255 })
    .withMessage('El titulo debe tener entre 3 y 255 caracteres')
    .trim(),
  body('description')
    .optional()
    .isLength({ max: 2000 })
    .withMessage('La descripcion no puede exceder 2000 caracteres')
    .trim()
];

const updateCaseValidators = [
  body('title')
    .optional()
    .isLength({ min: 3, max: 255 })
    .withMessage('El titulo debe tener entre 3 y 255 caracteres')
    .trim(),
  body('description')
    .optional()
    .isLength({ max: 2000 })
    .withMessage('La descripcion no puede exceder 2000 caracteres')
    .trim(),
  body('status')
    .optional()
    .isIn(['OPEN', 'CLOSED', 'ARCHIVED'])
    .withMessage('Estado invalido')
];

// ============================================================================
// RUTAS
// ============================================================================

/**
 * GET /api/cases
 * Listar casos del usuario
 */
router.get(
  '/',
  authMiddleware,
  checkPermission('cases:list'),
  caseController.listCases
);

/**
 * GET /api/cases/:id
 * Obtener caso por ID
 */
router.get(
  '/:id',
  authMiddleware,
  checkPermission('cases:view'),
  caseController.getCaseById
);

/**
 * POST /api/cases
 * Crear nuevo caso
 */
router.post(
  '/',
  authMiddleware,
  checkPermission('cases:create'),
  createCaseValidators,
  validateRequest,
  caseController.createCase
);

/**
 * PUT /api/cases/:id
 * Actualizar caso
 */
router.put(
  '/:id',
  authMiddleware,
  checkPermission('cases:update'),
  updateCaseValidators,
  validateRequest,
  caseController.updateCase
);

/**
 * DELETE /api/cases/:id
 * Archivar/eliminar caso
 */
router.delete(
  '/:id',
  authMiddleware,
  checkPermission('cases:delete'),
  caseController.deleteCase
);

module.exports = router;
