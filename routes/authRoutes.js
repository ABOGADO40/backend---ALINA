// ============================================================================
// AUTH ROUTES - Rutas de autenticacion
// Sistema PRUEBA DIGITAL
// ============================================================================

const express = require('express');
const router = express.Router();
const { body } = require('express-validator');

const authController = require('../controllers/authController');
const { validateRequest } = require('../middleware/validationMiddleware');
const { authMiddleware } = require('../middleware/authMiddleware');

// ============================================================================
// VALIDADORES
// ============================================================================

const registerValidators = [
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

const loginValidators = [
  body('email')
    .isEmail()
    .withMessage('Email invalido')
    .normalizeEmail(),
  body('password')
    .notEmpty()
    .withMessage('Contrasena requerida')
];

// ============================================================================
// RUTAS
// ============================================================================

/**
 * POST /api/auth/register
 * Registro de nuevo cliente
 */
router.post(
  '/register',
  registerValidators,
  validateRequest,
  authController.register
);

/**
 * POST /api/auth/login
 * Inicio de sesion
 */
router.post(
  '/login',
  loginValidators,
  validateRequest,
  authController.login
);

/**
 * POST /api/auth/logout
 * Cierre de sesion
 */
router.post(
  '/logout',
  authMiddleware,
  authController.logout
);

/**
 * GET /api/auth/me
 * Obtener usuario actual con permisos
 */
router.get(
  '/me',
  authMiddleware,
  authController.me
);

module.exports = router;
