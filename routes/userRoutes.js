// ============================================================================
// USER ROUTES - Rutas de usuarios
// Sistema PRUEBA DIGITAL
// ============================================================================

const express = require('express');
const router = express.Router();
const { body } = require('express-validator');

const { authMiddleware } = require('../middleware/authMiddleware');
const { checkPermission, checkRole } = require('../middleware/rbacMiddleware');
const { validateRequest } = require('../middleware/validationMiddleware');
const userController = require('../controllers/userController');

// ============================================================================
// VALIDADORES
// ============================================================================

const createUserValidators = [
  body('email')
    .isEmail()
    .withMessage('Email invalido')
    .normalizeEmail(),
  body('password')
    .isLength({ min: 8 })
    .withMessage('La contrasena debe tener al menos 8 caracteres'),
  body('fullName')
    .isLength({ min: 3 })
    .withMessage('El nombre debe tener al menos 3 caracteres')
    .trim(),
  body('roleId')
    .isInt()
    .withMessage('roleId debe ser un numero entero'),
  body('dni')
    .optional()
    .isLength({ min: 8, max: 8 })
    .withMessage('DNI debe tener 8 digitos')
    .isNumeric(),
  body('ruc')
    .optional()
    .isLength({ min: 11, max: 11 })
    .withMessage('RUC debe tener 11 digitos')
    .isNumeric(),
  body('phone')
    .optional()
    .trim()
];

const updateUserValidators = [
  body('fullName')
    .optional()
    .isLength({ min: 3 })
    .withMessage('El nombre debe tener al menos 3 caracteres')
    .trim(),
  body('password')
    .optional()
    .isLength({ min: 8 })
    .withMessage('La contrasena debe tener al menos 8 caracteres'),
  body('roleId')
    .optional()
    .isInt()
    .withMessage('roleId debe ser un numero entero'),
  body('isActive')
    .optional()
    .isBoolean()
    .withMessage('isActive debe ser booleano')
];

// ============================================================================
// RUTAS
// ============================================================================

/**
 * GET /api/users
 * Listar usuarios (solo SUPER_ADMIN)
 */
router.get(
  '/',
  authMiddleware,
  checkRole('SUPER_ADMIN'),
  userController.listUsers
);

/**
 * GET /api/users/:id
 * Obtener usuario por ID
 */
router.get(
  '/:id',
  authMiddleware,
  checkPermission('users:view'),
  userController.getUserById
);

/**
 * POST /api/users
 * Crear nuevo usuario (solo SUPER_ADMIN)
 */
router.post(
  '/',
  authMiddleware,
  checkRole('SUPER_ADMIN'),
  createUserValidators,
  validateRequest,
  userController.createUser
);

/**
 * PUT /api/users/:id
 * Actualizar usuario
 */
router.put(
  '/:id',
  authMiddleware,
  checkPermission('users:update'),
  updateUserValidators,
  validateRequest,
  userController.updateUser
);

/**
 * DELETE /api/users/:id
 * Eliminar usuario (soft delete, solo SUPER_ADMIN)
 */
router.delete(
  '/:id',
  authMiddleware,
  checkRole('SUPER_ADMIN'),
  userController.deleteUser
);

module.exports = router;
