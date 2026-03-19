// ============================================================================
// EVIDENCE ROUTES - Rutas de evidencias digitales
// Sistema PRUEBA DIGITAL
// ============================================================================

const express = require('express');
const router = express.Router();
const { body } = require('express-validator');

const { authMiddleware } = require('../middleware/authMiddleware');
const { checkPermission } = require('../middleware/rbacMiddleware');
const { validateRequest } = require('../middleware/validationMiddleware');
const { uploadSingle, validateUploadedFile, handleUploadError } = require('../middleware/uploadMiddleware');
const evidenceController = require('../controllers/evidenceController');
const custodyController = require('../controllers/custodyController');
const actaController = require('../controllers/actaController');

// ============================================================================
// VALIDADORES
// ============================================================================

const uploadValidators = [
  body('caseId')
    .optional({ nullable: true, checkFalsy: true })
    .isInt()
    .withMessage('caseId debe ser un numero entero'),
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
  // Validadores OBLIGATORIOS para datos del aportante (Acta)
  body('actaLugar')
    .notEmpty()
    .withMessage('El lugar del acta es requerido')
    .isLength({ min: 3, max: 500 })
    .withMessage('El lugar del acta debe tener entre 3 y 500 caracteres')
    .trim(),
  body('actaEntidadInterviniente')
    .notEmpty()
    .withMessage('La entidad interviniente es requerida')
    .isLength({ min: 3, max: 500 })
    .withMessage('La entidad interviniente debe tener entre 3 y 500 caracteres')
    .trim(),
  body('usuarioEntidad')
    .optional({ nullable: true, checkFalsy: true })
    .isLength({ max: 500 })
    .trim(),
  body('aportanteNombreCompleto')
    .notEmpty()
    .withMessage('El nombre del aportante es requerido')
    .isLength({ min: 3, max: 255 })
    .withMessage('El nombre del aportante debe tener entre 3 y 255 caracteres')
    .trim(),
  body('aportanteDocumentoTipo')
    .optional()
    .isIn(['DNI', 'CE', 'PASAPORTE', 'RUC'])
    .withMessage('Tipo de documento invalido'),
  body('aportanteDocumentoNumero')
    .notEmpty()
    .withMessage('El numero de documento es requerido')
    .isLength({ min: 6, max: 50 })
    .withMessage('El numero de documento debe tener entre 6 y 50 caracteres')
    .trim(),
  body('aportanteCondicion')
    .notEmpty()
    .withMessage('La condicion del aportante es requerida')
    .isIn(['TESTIGO', 'AGRAVIADO', 'DENUNCIANTE', 'TERCERO', 'OTRO'])
    .withMessage('Condicion del aportante invalida'),
  body('aportanteCondicionOtro')
    .optional({ nullable: true, checkFalsy: true })
    .isLength({ max: 255 })
    .trim(),
  body('aportanteDomicilio')
    .optional({ nullable: true, checkFalsy: true })
    .isLength({ max: 500 })
    .trim(),
  body('aportanteTelefono')
    .optional({ nullable: true, checkFalsy: true })
    .isLength({ max: 50 })
    .trim(),
  body('aportanteCorreo')
    .optional({ nullable: true, checkFalsy: true })
    .isEmail()
    .withMessage('Correo electronico invalido'),
  body('dispositivoOrigen')
    .optional({ nullable: true, checkFalsy: true })
    .isLength({ max: 500 })
    .trim(),
  body('fechaObtencionArchivo')
    .optional({ nullable: true, checkFalsy: true })
    .isISO8601()
    .withMessage('Fecha de obtencion invalida')
];

const importDriveValidators = [
  body('fileIds')
    .isArray({ min: 1, max: 10 })
    .withMessage('Se requiere entre 1 y 10 IDs de archivo'),
  body('fileIds.*')
    .isString()
    .notEmpty()
    .withMessage('Cada fileId debe ser un string no vacio'),
  body('accessToken')
    .isString()
    .notEmpty()
    .withMessage('Se requiere el token de acceso de Google'),
  body('caseId')
    .optional({ nullable: true, checkFalsy: true })
    .isInt()
    .withMessage('caseId debe ser un numero entero'),
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
  body('actaLugar')
    .notEmpty()
    .withMessage('El lugar del acta es requerido')
    .isLength({ min: 3, max: 500 })
    .trim(),
  body('actaEntidadInterviniente')
    .notEmpty()
    .withMessage('La entidad interviniente es requerida')
    .isLength({ min: 3, max: 500 })
    .trim(),
  body('usuarioEntidad')
    .optional({ nullable: true, checkFalsy: true })
    .isLength({ max: 500 })
    .trim(),
  body('aportanteNombreCompleto')
    .notEmpty()
    .withMessage('El nombre del aportante es requerido')
    .isLength({ min: 3, max: 255 })
    .trim(),
  body('aportanteDocumentoTipo')
    .optional()
    .isIn(['DNI', 'CE', 'PASAPORTE', 'RUC'])
    .withMessage('Tipo de documento invalido'),
  body('aportanteDocumentoNumero')
    .notEmpty()
    .withMessage('El numero de documento es requerido')
    .isLength({ min: 6, max: 50 })
    .trim(),
  body('aportanteCondicion')
    .notEmpty()
    .isIn(['TESTIGO', 'AGRAVIADO', 'DENUNCIANTE', 'TERCERO', 'OTRO'])
    .withMessage('Condicion del aportante invalida'),
  body('aportanteCondicionOtro')
    .optional({ nullable: true, checkFalsy: true })
    .isLength({ max: 255 })
    .trim(),
  body('aportanteDomicilio')
    .optional({ nullable: true, checkFalsy: true })
    .isLength({ max: 500 })
    .trim(),
  body('aportanteTelefono')
    .optional({ nullable: true, checkFalsy: true })
    .isLength({ max: 50 })
    .trim(),
  body('aportanteCorreo')
    .optional({ nullable: true, checkFalsy: true })
    .isEmail()
    .withMessage('Correo electronico invalido'),
  body('dispositivoOrigen')
    .optional({ nullable: true, checkFalsy: true })
    .isLength({ max: 500 })
    .trim(),
  body('fechaObtencionArchivo')
    .optional({ nullable: true, checkFalsy: true })
    .isISO8601()
    .withMessage('Fecha de obtencion invalida')
];

// ============================================================================
// RUTAS DE EVIDENCIAS
// ============================================================================

/**
 * GET /api/evidences
 * Listar evidencias del usuario
 */
router.get(
  '/',
  authMiddleware,
  checkPermission('evidence:list'),
  evidenceController.listEvidences
);

/**
 * POST /api/evidences/import-drive
 * Importar evidencia(s) desde Google Drive
 */
router.post(
  '/import-drive',
  authMiddleware,
  checkPermission('evidence:upload'),
  importDriveValidators,
  validateRequest,
  evidenceController.importFromDrive
);

/**
 * POST /api/evidences/upload
 * Subir nueva evidencia (hasta 2GB)
 */
router.post(
  '/upload',
  authMiddleware,
  checkPermission('evidence:upload'),
  uploadSingle,
  handleUploadError,
  validateUploadedFile,
  uploadValidators,
  validateRequest,
  evidenceController.uploadEvidence
);

/**
 * GET /api/evidences/actas/:actaId/download
 * Descargar PDF del acta
 * NOTA: Esta ruta debe estar ANTES de /:id para evitar conflictos
 */
router.get(
  '/actas/:actaId/download',
  authMiddleware,
  checkPermission('evidence:view'),
  actaController.downloadActa
);

/**
 * GET /api/evidences/:id/documents/certificado/download
 * Descargar Certificado de Evidencia Digital en PDF
 */
router.get(
  '/:id/documents/certificado/download',
  authMiddleware,
  checkPermission('evidence:view'),
  actaController.downloadCertificado
);

/**
 * GET /api/evidences/:id/documents/cadena-custodia/download
 * Descargar Reporte de Cadena de Custodia en PDF
 */
router.get(
  '/:id/documents/cadena-custodia/download',
  authMiddleware,
  checkPermission('evidence:view'),
  actaController.downloadCadenaCustodia
);

/**
 * GET /api/evidences/:id/documents/metadatos/download
 * Descargar Reporte de Metadatos en PDF
 */
router.get(
  '/:id/documents/metadatos/download',
  authMiddleware,
  checkPermission('evidence:view'),
  actaController.downloadMetadatos
);

/**
 * GET /api/evidences/:id/documents
 * Obtener lista de todos los documentos disponibles
 */
router.get(
  '/:id/documents',
  authMiddleware,
  checkPermission('evidence:view'),
  actaController.getAllDocuments
);

/**
 * GET /api/evidences/:id/download/:fileRole
 * Descargar archivo de evidencia
 * fileRole: ORIGINAL, BITCOPY, SEALED, CERT_PDF, CERT_JSON
 */
router.get(
  '/:id/download/:fileRole',
  authMiddleware,
  checkPermission('evidence:download'),
  evidenceController.downloadFile
);

/**
 * GET /api/evidences/:id
 * Obtener detalle de evidencia
 * NOTA: Esta ruta debe estar DESPUES de todas las rutas con subrutas /:id/...
 */
router.get(
  '/:id',
  authMiddleware,
  checkPermission('evidence:view'),
  evidenceController.getEvidenceById
);

/**
 * PATCH /api/evidences/:id/toggle-public
 * Cambiar visibilidad publica
 */
router.patch(
  '/:id/toggle-public',
  authMiddleware,
  checkPermission('evidence:toggle_public'),
  evidenceController.togglePublic
);

/**
 * POST /api/evidences/:id/regenerate
 * Regenerar procesamiento de evidencia
 */
router.post(
  '/:id/regenerate',
  authMiddleware,
  checkPermission('evidence:upload'),
  evidenceController.regenerate
);

/**
 * DELETE /api/evidences/:id
 * Archivar evidencia
 */
router.delete(
  '/:id',
  authMiddleware,
  checkPermission('evidence:delete'),
  evidenceController.deleteEvidence
);

/**
 * GET /api/evidences/:id/metadata/export
 * Exportar metadata de la evidencia en formato PDF
 */
router.get(
  '/:id/metadata/export',
  authMiddleware,
  checkPermission('evidence:view'),
  evidenceController.exportMetadata
);

// ============================================================================
// RUTAS DE CADENA DE CUSTODIA (anidadas bajo evidencias)
// ============================================================================

/**
 * GET /api/evidences/:id/custody
 * Obtener cadena de custodia
 */
router.get(
  '/:id/custody',
  authMiddleware,
  checkPermission('custody:view'),
  custodyController.getCustodyChain
);

/**
 * GET /api/evidences/:id/custody/export
 * Exportar cadena de custodia
 */
router.get(
  '/:id/custody/export',
  authMiddleware,
  checkPermission('custody:export'),
  custodyController.exportCustodyChain
);

/**
 * GET /api/evidences/:id/custody/verify
 * Verificar integridad de cadena de custodia
 */
router.get(
  '/:id/custody/verify',
  authMiddleware,
  checkPermission('custody:view'),
  custodyController.verifyCustodyIntegrity
);

/**
 * POST /api/evidences/:id/custody/events
 * Agregar evento manual a custodia (solo SUPER_ADMIN)
 */
router.post(
  '/:id/custody/events',
  authMiddleware,
  checkPermission('custody:view'),
  body('eventType')
    .isIn(['ANNOTATION', 'REVIEW', 'TRANSFER', 'LEGAL_ACTION', 'OTHER'])
    .withMessage('Tipo de evento invalido'),
  body('description')
    .isLength({ min: 5, max: 500 })
    .withMessage('Descripcion requerida (5-500 caracteres)')
    .trim(),
  validateRequest,
  custodyController.addCustodyEvent
);

// ============================================================================
// RUTAS DE ACTAS (Acta de Obtencion de Evidencia Digital)
// ============================================================================

/**
 * POST /api/evidences/:id/contributor
 * Crear registro de aportante
 */
router.post(
  '/:id/contributor',
  authMiddleware,
  checkPermission('evidence:view'),
  body('actaLugar')
    .isLength({ min: 3, max: 500 })
    .withMessage('El lugar del acta es requerido (3-500 caracteres)')
    .trim(),
  body('actaEntidadInterviniente')
    .isLength({ min: 3, max: 500 })
    .withMessage('La entidad interviniente es requerida (3-500 caracteres)')
    .trim(),
  body('aportanteNombreCompleto')
    .isLength({ min: 3, max: 255 })
    .withMessage('El nombre del aportante es requerido (3-255 caracteres)')
    .trim(),
  body('aportanteDocumentoTipo')
    .optional()
    .isIn(['DNI', 'CE', 'PASAPORTE', 'RUC'])
    .withMessage('Tipo de documento invalido'),
  body('aportanteDocumentoNumero')
    .isLength({ min: 6, max: 50 })
    .withMessage('El numero de documento es requerido (6-50 caracteres)')
    .trim(),
  body('aportanteCondicion')
    .isIn(['TESTIGO', 'AGRAVIADO', 'DENUNCIANTE', 'TERCERO', 'OTRO'])
    .withMessage('Condicion del aportante invalida'),
  body('aportanteCorreo')
    .optional({ nullable: true, checkFalsy: true })
    .isEmail()
    .withMessage('Correo electronico invalido'),
  validateRequest,
  actaController.createContributorRecord
);

/**
 * GET /api/evidences/:id/contributors
 * Listar registros de aportantes
 */
router.get(
  '/:id/contributors',
  authMiddleware,
  checkPermission('evidence:view'),
  actaController.getContributorRecords
);

/**
 * POST /api/evidences/:id/actas/generate
 * Generar PDF del acta
 */
router.post(
  '/:id/actas/generate',
  authMiddleware,
  checkPermission('evidence:view'),
  body('contributorRecordId')
    .isInt({ min: 1 })
    .withMessage('ID de registro de aportante requerido'),
  validateRequest,
  actaController.generateActaPdf
);

/**
 * GET /api/evidences/:id/actas
 * Listar actas generadas
 */
router.get(
  '/:id/actas',
  authMiddleware,
  checkPermission('evidence:view'),
  actaController.getGeneratedActas
);

module.exports = router;
