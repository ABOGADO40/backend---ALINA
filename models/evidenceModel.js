// ============================================================================
// EVIDENCE MODEL - CRUD de evidencias
// Sistema PRUEBA DIGITAL
// ============================================================================

const { prisma } = require('../config/db');

// ============================================================================
// LISTAR EVIDENCIAS
// ============================================================================

/**
 * Lista evidencias con filtros y paginacion
 * @param {Object} options - Opciones de filtrado
 * @returns {Promise<{evidence: Array, total: number}>}
 */
const listEvidence = async (options = {}) => {
  const {
    page = 1,
    limit = 10,
    search,
    caseId,
    status,
    sourceType,
    ownerUserId,
    includeAll = false
  } = options;

  const where = {};

  // Filtro por propietario
  if (!includeAll && ownerUserId) {
    where.ownerUserId = ownerUserId;
  }

  // Filtro por caso
  if (caseId) {
    where.caseId = parseInt(caseId);
  }

  // Filtro por estado
  if (status) {
    where.status = status;
  }

  // Filtro por tipo
  if (sourceType) {
    where.sourceType = sourceType;
  }

  // Filtro de busqueda por titulo
  if (search) {
    where.title = { contains: search, mode: 'insensitive' };
  }

  const [evidence, total] = await Promise.all([
    prisma.evidence.findMany({
      where,
      include: {
        owner: {
          select: { id: true, fullName: true }
        },
        case: {
          select: { id: true, title: true }
        },
        files: {
          where: { fileRole: 'ORIGINAL' },
          select: {
            id: true,
            originalFilename: true,
            mimeType: true,
            sizeBytes: true
          },
          take: 1
        }
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit
    }),
    prisma.evidence.count({ where })
  ]);

  return {
    evidence: evidence.map(e => ({
      id: e.id,
      title: e.title,
      description: e.description,
      sourceType: e.sourceType,
      status: e.status,
      isPublic: e.isPublic,
      caseId: e.caseId,
      caseName: e.case?.title || null,
      owner: e.owner,
      originalFile: e.files[0] ? {
        id: e.files[0].id,
        filename: e.files[0].originalFilename,
        mimeType: e.files[0].mimeType,
        size: Number(e.files[0].sizeBytes)
      } : null,
      createdAt: e.createdAt
    })),
    total
  };
};

// ============================================================================
// OBTENER EVIDENCIA POR ID
// ============================================================================

/**
 * Obtiene una evidencia por su ID con archivos, hashes y custodia
 * @param {number} evidenceId - ID de la evidencia
 * @returns {Promise<Object|null>}
 */
const getEvidenceById = async (evidenceId) => {
  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    include: {
      owner: {
        select: { id: true, fullName: true, email: true }
      },
      case: {
        select: { id: true, title: true }
      },
      files: {
        include: {
          hashRecords: {
            orderBy: { computedAt: 'desc' },
            take: 1
          }
        },
        orderBy: { createdAt: 'asc' }
      },
      metadataReports: {
        orderBy: { version: 'desc' },
        take: 1
      },
      riskReports: {
        orderBy: { version: 'desc' },
        take: 1
      },
      custodyEvents: {
        include: {
          actor: {
            select: { id: true, fullName: true }
          }
        },
        orderBy: { eventAt: 'asc' }
      }
    }
  });

  if (!evidence) return null;

  return {
    id: evidence.id,
    title: evidence.title,
    description: evidence.description,
    sourceType: evidence.sourceType,
    status: evidence.status,
    isPublic: evidence.isPublic,
    ownerUserId: evidence.ownerUserId,
    owner: evidence.owner,
    case: evidence.case,
    files: evidence.files.map(f => ({
      id: f.id,
      fileRole: f.fileRole,
      version: f.version,
      originalFilename: f.originalFilename,
      mimeType: f.mimeType,
      sizeBytes: Number(f.sizeBytes),
      isEncrypted: f.isEncrypted,
      hash: f.hashRecords[0] ? {
        algorithm: f.hashRecords[0].algorithm,
        hashHex: f.hashRecords[0].hashHex,
        computedAt: f.hashRecords[0].computedAt
      } : null,
      createdAt: f.createdAt
    })),
    metadataReport: evidence.metadataReports[0] ? {
      version: evidence.metadataReports[0].version,
      reportJson: evidence.metadataReports[0].reportJson,
      createdAt: evidence.metadataReports[0].createdAt
    } : null,
    riskReport: evidence.riskReports[0] ? {
      version: evidence.riskReports[0].version,
      rulesTriggered: evidence.riskReports[0].rulesTriggered,
      summary: evidence.riskReports[0].summary,
      createdAt: evidence.riskReports[0].createdAt
    } : null,
    custodyEvents: evidence.custodyEvents.map(e => ({
      id: e.id,
      eventType: e.eventType,
      actorType: e.actorType,
      actor: e.actor,
      eventAt: e.eventAt,
      details: e.details
    })),
    createdAt: evidence.createdAt
  };
};

// ============================================================================
// CREAR EVIDENCIA
// ============================================================================

/**
 * Crea una nueva evidencia
 * @param {Object} data - Datos de la evidencia
 * @param {number} userId - ID del usuario creador
 * @returns {Promise<Object>}
 */
const createEvidence = async (data, userId) => {
  const { title, description, caseId, sourceType } = data;

  const evidence = await prisma.evidence.create({
    data: {
      ownerUserId: userId,
      caseId: caseId || null,
      title: title || null,
      description: description || null,
      sourceType: sourceType || 'OTHER',
      status: 'RECEIVED',
      isPublic: false,
      userIdRegistration: userId
    }
  });

  return evidence;
};

// ============================================================================
// ACTUALIZAR EVIDENCIA
// ============================================================================

/**
 * Actualiza metadatos de una evidencia
 * @param {number} evidenceId - ID de la evidencia
 * @param {Object} data - Datos a actualizar
 * @param {number} modifiedBy - ID del usuario que modifica
 * @returns {Promise<Object>}
 */
const updateEvidence = async (evidenceId, data, modifiedBy) => {
  const { title, description } = data;

  const updateData = {
    userIdModification: modifiedBy,
    dateTimeModification: new Date()
  };

  if (title !== undefined) updateData.title = title;
  if (description !== undefined) updateData.description = description;

  await prisma.evidence.update({
    where: { id: evidenceId },
    data: updateData
  });

  return getEvidenceById(evidenceId);
};

// ============================================================================
// ACTUALIZAR ESTADO
// ============================================================================

/**
 * Actualiza el estado de una evidencia
 * @param {number} evidenceId - ID de la evidencia
 * @param {string} status - Nuevo estado
 * @returns {Promise<Object>}
 */
const updateStatus = async (evidenceId, status) => {
  return prisma.evidence.update({
    where: { id: evidenceId },
    data: {
      status,
      dateTimeModification: new Date()
    }
  });
};

// ============================================================================
// TOGGLE PUBLICO
// ============================================================================

/**
 * Cambia el estado de verificacion publica
 * @param {number} evidenceId - ID de la evidencia
 * @param {boolean} isPublic - Nuevo estado
 * @param {number} modifiedBy - ID del usuario que modifica
 * @returns {Promise<Object>}
 */
const togglePublic = async (evidenceId, isPublic, modifiedBy) => {
  return prisma.evidence.update({
    where: { id: evidenceId },
    data: {
      isPublic,
      userIdModification: modifiedBy,
      dateTimeModification: new Date()
    }
  });
};

// ============================================================================
// VERIFICAR PROPIEDAD
// ============================================================================

/**
 * Verifica si un usuario es propietario de una evidencia
 * @param {number} evidenceId - ID de la evidencia
 * @param {number} userId - ID del usuario
 * @returns {Promise<boolean>}
 */
const isOwner = async (evidenceId, userId) => {
  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: { ownerUserId: true }
  });

  return evidence?.ownerUserId === userId;
};

// ============================================================================
// VERIFICAR EXISTENCIA
// ============================================================================

/**
 * Verifica si una evidencia existe
 * @param {number} evidenceId - ID de la evidencia
 * @returns {Promise<boolean>}
 */
const evidenceExists = async (evidenceId) => {
  const count = await prisma.evidence.count({
    where: { id: evidenceId }
  });
  return count > 0;
};

// ============================================================================
// OBTENER ESTADO
// ============================================================================

/**
 * Obtiene el estado actual de una evidencia
 * @param {number} evidenceId - ID de la evidencia
 * @returns {Promise<string|null>}
 */
const getStatus = async (evidenceId) => {
  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: { status: true }
  });
  return evidence?.status || null;
};

// ============================================================================
// OBTENER ARCHIVO POR ROL
// ============================================================================

/**
 * Obtiene un archivo de evidencia por su rol
 * @param {number} evidenceId - ID de la evidencia
 * @param {string} fileRole - Rol del archivo
 * @param {number} version - Version (opcional)
 * @returns {Promise<Object|null>}
 */
const getFileByRole = async (evidenceId, fileRole, version = null) => {
  const where = {
    evidenceId,
    fileRole
  };

  if (version) {
    where.version = version;
  }

  return prisma.evidenceFile.findFirst({
    where,
    orderBy: { version: 'desc' },
    include: {
      hashRecords: {
        orderBy: { computedAt: 'desc' },
        take: 1
      }
    }
  });
};

// ============================================================================
// CREAR ARCHIVO DE EVIDENCIA
// ============================================================================

/**
 * Crea un registro de archivo de evidencia
 * @param {Object} fileData - Datos del archivo
 * @param {number} userId - ID del usuario
 * @returns {Promise<Object>}
 */
const createEvidenceFile = async (fileData, userId) => {
  const {
    evidenceId,
    fileRole,
    version,
    storageKey,
    originalFilename,
    mimeType,
    sizeBytes,
    isEncrypted
  } = fileData;

  return prisma.evidenceFile.create({
    data: {
      evidenceId,
      fileRole,
      version: version || 1,
      storageKey,
      originalFilename,
      mimeType,
      sizeBytes: BigInt(sizeBytes),
      isEncrypted: isEncrypted || false,
      userIdRegistration: userId
    }
  });
};

// ============================================================================
// OBTENER VERSION MAXIMA
// ============================================================================

/**
 * Obtiene la version maxima de archivos de una evidencia
 * @param {number} evidenceId - ID de la evidencia
 * @param {string} fileRole - Rol del archivo
 * @returns {Promise<number>}
 */
const getMaxVersion = async (evidenceId, fileRole) => {
  const result = await prisma.evidenceFile.aggregate({
    where: { evidenceId, fileRole },
    _max: { version: true }
  });
  return result._max.version || 0;
};

// ============================================================================
// OBTENER EVIDENCIAS LISTAS PARA EXPORTAR
// ============================================================================

/**
 * Obtiene evidencias listas para exportar de un caso
 * @param {number} caseId - ID del caso
 * @returns {Promise<Array>}
 */
const getEvidenceReadyForExport = async (caseId) => {
  return prisma.evidence.findMany({
    where: {
      caseId,
      status: 'READY_FOR_EXPORT'
    },
    include: {
      files: {
        include: {
          hashRecords: true
        }
      }
    }
  });
};

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  listEvidence,
  getEvidenceById,
  createEvidence,
  updateEvidence,
  updateStatus,
  togglePublic,
  isOwner,
  evidenceExists,
  getStatus,
  getFileByRole,
  createEvidenceFile,
  getMaxVersion,
  getEvidenceReadyForExport
};
