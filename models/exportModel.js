// ============================================================================
// EXPORT MODEL - Operaciones de exportacion ZIP forense
// Sistema PRUEBA DIGITAL
// ============================================================================

const { prisma } = require('../config/db');

// ============================================================================
// LISTAR EXPORTACIONES
// ============================================================================

/**
 * Lista exportaciones con filtros y paginacion
 * @param {Object} options - Opciones de filtrado
 * @returns {Promise<{exports: Array, total: number}>}
 */
const listExports = async (options = {}) => {
  const {
    page = 1,
    limit = 10,
    status,
    userId,
    includeAll = false
  } = options;

  const where = {};

  // Filtro por usuario
  if (!includeAll && userId) {
    where.requestedByUserId = userId;
  }

  // Filtro por estado
  if (status) {
    where.status = status;
  }

  const [exports, total] = await Promise.all([
    prisma.export.findMany({
      where,
      include: {
        requestedBy: {
          select: { id: true, fullName: true, email: true }
        },
        evidence: {
          select: { id: true, title: true, sourceType: true }
        },
        case: {
          select: { id: true, title: true }
        },
        exportFile: {
          select: {
            id: true,
            originalFilename: true,
            sizeBytes: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit
    }),
    prisma.export.count({ where })
  ]);

  return {
    exports: exports.map(e => ({
      id: e.id,
      scope: e.scope,
      status: e.status,
      requestedBy: e.requestedBy,
      evidence: e.evidence,
      case: e.case,
      file: e.exportFile ? {
        id: e.exportFile.id,
        filename: e.exportFile.originalFilename,
        sizeBytes: Number(e.exportFile.sizeBytes)
      } : null,
      createdAt: e.createdAt
    })),
    total
  };
};

// ============================================================================
// OBTENER EXPORTACION POR ID
// ============================================================================

/**
 * Obtiene una exportacion por su ID
 * @param {number} exportId - ID de la exportacion
 * @returns {Promise<Object|null>}
 */
const getExportById = async (exportId) => {
  const exportData = await prisma.export.findUnique({
    where: { id: exportId },
    include: {
      requestedBy: {
        select: { id: true, fullName: true, email: true }
      },
      evidence: {
        select: { id: true, title: true, sourceType: true, status: true }
      },
      case: {
        select: { id: true, title: true }
      },
      exportFile: {
        include: {
          hashRecords: true
        }
      },
      items: {
        include: {
          evidence: {
            select: { id: true, title: true }
          }
        }
      }
    }
  });

  if (!exportData) return null;

  return {
    id: exportData.id,
    scope: exportData.scope,
    status: exportData.status,
    requestedByUserId: exportData.requestedByUserId,
    requestedBy: exportData.requestedBy,
    evidence: exportData.evidence,
    case: exportData.case,
    file: exportData.exportFile ? {
      id: exportData.exportFile.id,
      storageKey: exportData.exportFile.storageKey,
      filename: exportData.exportFile.originalFilename,
      mimeType: exportData.exportFile.mimeType,
      sizeBytes: Number(exportData.exportFile.sizeBytes),
      hash: exportData.exportFile.hashRecords[0]?.hashHex || null
    } : null,
    items: exportData.items.map(i => ({
      evidenceId: i.evidenceId,
      evidenceTitle: i.evidence.title
    })),
    createdAt: exportData.createdAt
  };
};

// ============================================================================
// CREAR EXPORTACION
// ============================================================================

/**
 * Crea una nueva exportacion
 * @param {Object} data - Datos de la exportacion
 * @param {number} userId - ID del usuario
 * @returns {Promise<Object>}
 */
const createExport = async (data, userId) => {
  const { scope, evidenceId, caseId } = data;

  const exportRecord = await prisma.export.create({
    data: {
      requestedByUserId: userId,
      scope,
      evidenceId: scope === 'SINGLE_EVIDENCE' ? evidenceId : null,
      caseId: scope === 'CASE' ? caseId : null,
      status: 'CREATING',
      userIdRegistration: userId
    }
  });

  return exportRecord;
};

// ============================================================================
// ACTUALIZAR ESTADO
// ============================================================================

/**
 * Actualiza el estado de una exportacion
 * @param {number} exportId - ID de la exportacion
 * @param {string} status - Nuevo estado
 * @param {number} exportFileId - ID del archivo exportado (opcional)
 * @returns {Promise<Object>}
 */
const updateExportStatus = async (exportId, status, exportFileId = null) => {
  const updateData = {
    status,
    dateTimeModification: new Date()
  };

  if (exportFileId) {
    updateData.exportFileId = exportFileId;
  }

  return prisma.export.update({
    where: { id: exportId },
    data: updateData
  });
};

// ============================================================================
// AGREGAR ITEMS A EXPORTACION
// ============================================================================

/**
 * Agrega items a una exportacion de caso
 * @param {number} exportId - ID de la exportacion
 * @param {Array<number>} evidenceIds - IDs de las evidencias
 * @param {number} userId - ID del usuario
 * @returns {Promise<number>}
 */
const addExportItems = async (exportId, evidenceIds, userId) => {
  const items = evidenceIds.map(evidenceId => ({
    exportId,
    evidenceId,
    userIdRegistration: userId
  }));

  const result = await prisma.exportItem.createMany({
    data: items,
    skipDuplicates: true
  });

  return result.count;
};

// ============================================================================
// VERIFICAR PROPIEDAD
// ============================================================================

/**
 * Verifica si un usuario es propietario de una exportacion
 * @param {number} exportId - ID de la exportacion
 * @param {number} userId - ID del usuario
 * @returns {Promise<boolean>}
 */
const isOwner = async (exportId, userId) => {
  const exportData = await prisma.export.findUnique({
    where: { id: exportId },
    select: { requestedByUserId: true }
  });

  return exportData?.requestedByUserId === userId;
};

// ============================================================================
// VERIFICAR EXISTENCIA
// ============================================================================

/**
 * Verifica si una exportacion existe
 * @param {number} exportId - ID de la exportacion
 * @returns {Promise<boolean>}
 */
const exportExists = async (exportId) => {
  const count = await prisma.export.count({
    where: { id: exportId }
  });
  return count > 0;
};

// ============================================================================
// OBTENER EXPORTACION POR EVIDENCIA
// ============================================================================

/**
 * Obtiene la ultima exportacion de una evidencia
 * @param {number} evidenceId - ID de la evidencia
 * @returns {Promise<Object|null>}
 */
const getLatestExportByEvidence = async (evidenceId) => {
  return prisma.export.findFirst({
    where: {
      OR: [
        { evidenceId },
        { items: { some: { evidenceId } } }
      ],
      status: 'READY'
    },
    orderBy: { createdAt: 'desc' }
  });
};

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  listExports,
  getExportById,
  createExport,
  updateExportStatus,
  addExportItems,
  isOwner,
  exportExists,
  getLatestExportByEvidence
};
