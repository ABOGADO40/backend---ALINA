// ============================================================================
// VALIDATION MIDDLEWARE - Middleware de validacion
// Sistema PRUEBA DIGITAL
// ============================================================================

const { validationResult } = require('express-validator');

// ============================================================================
// VALIDAR RESULTADO DE EXPRESS-VALIDATOR
// ============================================================================

/**
 * Middleware que verifica los errores de validacion de express-validator
 */
const validateRequest = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Error de validacion en los datos enviados',
        details: errors.array().map(err => ({
          field: err.path,
          message: err.msg,
          value: err.value
        }))
      }
    });
  }

  next();
};

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  validateRequest
};
