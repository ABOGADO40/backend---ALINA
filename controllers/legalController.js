// ============================================================================
// LEGAL CONTROLLER - Gestion de documentos legales (Privacidad y Terminos)
// Sistema PRUEBA DIGITAL
// ============================================================================

const legalModel = require('../models/legalModel');
const { createAuditLog } = require('../services/auditService');

const SLUG_TO_TYPE = {
  privacy: 'PRIVACY_POLICY',
  terms: 'TERMS_AND_CONDITIONS'
};

const MAX_CONTENT_LENGTH = 50000;

// ============================================================================
// OBTENER POLITICA DE PRIVACIDAD (PUBLICO)
// ============================================================================

/**
 * GET /api/legal/privacy
 * Endpoint publico que devuelve el contenido de la Politica de Privacidad
 */
const getPrivacyPolicy = async (req, res) => {
  try {
    const document = await legalModel.getDocumentByType('PRIVACY_POLICY');

    if (!document) {
      return res.json({
        success: true,
        data: {
          type: 'PRIVACY_POLICY',
          content: '',
          dateTimeModification: null,
          dateTimeRegistration: null
        }
      });
    }

    return res.json({
      success: true,
      data: {
        type: document.type,
        content: document.content,
        dateTimeModification: document.dateTimeModification,
        dateTimeRegistration: document.dateTimeRegistration
      }
    });
  } catch (error) {
    console.error('[LegalController] Error getPrivacyPolicy:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al obtener la Politica de Privacidad'
      }
    });
  }
};

// ============================================================================
// OBTENER TERMINOS Y CONDICIONES (PUBLICO)
// ============================================================================

/**
 * GET /api/legal/terms
 * Endpoint publico que devuelve el contenido de los Terminos y Condiciones
 */
const getTermsAndConditions = async (req, res) => {
  try {
    const document = await legalModel.getDocumentByType('TERMS_AND_CONDITIONS');

    if (!document) {
      return res.json({
        success: true,
        data: {
          type: 'TERMS_AND_CONDITIONS',
          content: '',
          dateTimeModification: null,
          dateTimeRegistration: null
        }
      });
    }

    return res.json({
      success: true,
      data: {
        type: document.type,
        content: document.content,
        dateTimeModification: document.dateTimeModification,
        dateTimeRegistration: document.dateTimeRegistration
      }
    });
  } catch (error) {
    console.error('[LegalController] Error getTermsAndConditions:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al obtener los Terminos y Condiciones'
      }
    });
  }
};

// ============================================================================
// LISTAR AMBOS DOCUMENTOS PARA ADMIN
// ============================================================================

/**
 * GET /api/legal
 * Devuelve ambos documentos con metadatos para la pagina admin de Configuracion
 * Solo SUPER_ADMIN
 */
const listLegalDocuments = async (req, res) => {
  try {
    const [privacy, terms] = await Promise.all([
      legalModel.getDocumentWithModifier('PRIVACY_POLICY'),
      legalModel.getDocumentWithModifier('TERMS_AND_CONDITIONS')
    ]);

    return res.json({
      success: true,
      data: {
        privacy: privacy || { type: 'PRIVACY_POLICY', content: '', modifierName: null, dateTimeModification: null },
        terms: terms || { type: 'TERMS_AND_CONDITIONS', content: '', modifierName: null, dateTimeModification: null }
      }
    });
  } catch (error) {
    console.error('[LegalController] Error listLegalDocuments:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al obtener los documentos legales'
      }
    });
  }
};

// ============================================================================
// ACTUALIZAR DOCUMENTO (SOLO SUPER_ADMIN)
// ============================================================================

/**
 * PUT /api/legal/:type
 * Actualiza el contenido de un documento legal
 * type ∈ { 'privacy', 'terms' }
 */
const updateLegalDocument = async (req, res) => {
  try {
    const slug = String(req.params.type || '').toLowerCase();
    const documentType = SLUG_TO_TYPE[slug];

    if (!documentType) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_DOCUMENT_TYPE',
          message: 'Tipo de documento invalido. Use "privacy" o "terms".'
        }
      });
    }

    const { content } = req.body;

    if (typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'El contenido es requerido y no puede estar vacio'
        }
      });
    }

    if (content.length > MAX_CONTENT_LENGTH) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'CONTENT_TOO_LONG',
          message: `El contenido excede el limite de ${MAX_CONTENT_LENGTH} caracteres`
        }
      });
    }

    const updated = await legalModel.updateDocument(documentType, content, req.user.id);

    // Auditoria
    await createAuditLog(
      req.user.id,
      'LEGAL_DOCUMENT_UPDATE',
      'LegalDocument',
      updated.id,
      { type: documentType, contentLength: content.length },
      req.ip,
      req.headers['user-agent']
    );

    return res.json({
      success: true,
      data: {
        id: updated.id,
        type: updated.type,
        content: updated.content,
        dateTimeModification: updated.dateTimeModification
      },
      message: 'Documento actualizado correctamente'
    });
  } catch (error) {
    console.error('[LegalController] Error updateLegalDocument:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al actualizar el documento legal'
      }
    });
  }
};

module.exports = {
  getPrivacyPolicy,
  getTermsAndConditions,
  listLegalDocuments,
  updateLegalDocument
};
