// ============================================================================
// LEGAL MODEL - CRUD de documentos legales (Privacidad y Terminos)
// Sistema PRUEBA DIGITAL
// ============================================================================

const { prisma } = require('../config/db');

const LEGAL_DOCUMENT_TYPES = {
  PRIVACY_POLICY: 'PRIVACY_POLICY',
  TERMS_AND_CONDITIONS: 'TERMS_AND_CONDITIONS'
};

// ============================================================================
// OBTENER DOCUMENTO POR TIPO
// ============================================================================

/**
 * Obtiene un documento legal por tipo, incluyendo el modificador
 * @param {string} type - LegalDocumentType (PRIVACY_POLICY | TERMS_AND_CONDITIONS)
 * @returns {Promise<Object|null>}
 */
const getDocumentByType = async (type) => {
  return prisma.legalDocument.findUnique({
    where: { type }
  });
};

/**
 * Obtiene un documento legal con datos del usuario que lo modifico
 * @param {string} type - LegalDocumentType
 * @returns {Promise<Object|null>}
 */
const getDocumentWithModifier = async (type) => {
  const document = await prisma.legalDocument.findUnique({
    where: { type }
  });

  if (!document) return null;

  let modifierName = null;
  if (document.userIdModification) {
    const modifier = await prisma.user.findUnique({
      where: { id: document.userIdModification },
      select: { fullName: true, email: true }
    });
    modifierName = modifier?.fullName || modifier?.email || null;
  }

  return {
    ...document,
    modifierName
  };
};

// ============================================================================
// ACTUALIZAR DOCUMENTO
// ============================================================================

/**
 * Actualiza el contenido de un documento legal
 * @param {string} type - LegalDocumentType
 * @param {string} content - Nuevo contenido en texto plano
 * @param {number} userId - ID del usuario admin que modifica
 * @returns {Promise<Object>} Documento actualizado
 */
const updateDocument = async (type, content, userId) => {
  return prisma.legalDocument.upsert({
    where: { type },
    update: {
      content,
      userIdModification: userId,
      dateTimeModification: new Date()
    },
    create: {
      type,
      content,
      userIdRegistration: userId
    }
  });
};

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  LEGAL_DOCUMENT_TYPES,
  getDocumentByType,
  getDocumentWithModifier,
  updateDocument
};
