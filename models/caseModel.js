// ============================================================================
// CASE MODEL - CRUD de casos/expedientes
// Sistema PRUEBA DIGITAL
// ============================================================================

const { prisma } = require('../config/db');

// ============================================================================
// LISTAR CASOS
// ============================================================================

/**
 * Lista casos con filtros y paginacion
 * @param {Object} options - Opciones de filtrado
 * @returns {Promise<{cases: Array, total: number}>}
 */
const listCases = async (options = {}) => {
  const {
    page = 1,
    limit = 10,
    search,
    ownerUserId,
    includeAll = false // Para SUPER_ADMIN
  } = options;

  const where = {};

  // Filtro por propietario (si no es SUPER_ADMIN)
  if (!includeAll && ownerUserId) {
    where.ownerUserId = ownerUserId;
  }

  // Filtro de busqueda por titulo
  if (search) {
    where.title = { contains: search, mode: 'insensitive' };
  }

  const [cases, total] = await Promise.all([
    prisma.case.findMany({
      where,
      include: {
        owner: {
          select: {
            id: true,
            fullName: true,
            email: true
          }
        },
        _count: {
          select: { evidence: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit
    }),
    prisma.case.count({ where })
  ]);

  return {
    cases: cases.map(c => ({
      id: c.id,
      title: c.title,
      description: c.description,
      owner: c.owner,
      evidenceCount: c._count.evidence,
      createdAt: c.createdAt
    })),
    total
  };
};

// ============================================================================
// OBTENER CASO POR ID
// ============================================================================

/**
 * Obtiene un caso por su ID con sus evidencias
 * @param {number} caseId - ID del caso
 * @param {boolean} includeEvidence - Incluir evidencias
 * @returns {Promise<Object|null>}
 */
const getCaseById = async (caseId, includeEvidence = true) => {
  const caseData = await prisma.case.findUnique({
    where: { id: caseId },
    include: {
      owner: {
        select: {
          id: true,
          fullName: true,
          email: true
        }
      },
      evidence: includeEvidence ? {
        select: {
          id: true,
          title: true,
          sourceType: true,
          status: true,
          isPublic: true,
          createdAt: true
        },
        orderBy: { createdAt: 'desc' }
      } : false
    }
  });

  if (!caseData) return null;

  return {
    id: caseData.id,
    title: caseData.title,
    description: caseData.description,
    ownerUserId: caseData.ownerUserId,
    owner: caseData.owner,
    evidence: caseData.evidence || [],
    createdAt: caseData.createdAt
  };
};

// ============================================================================
// CREAR CASO
// ============================================================================

/**
 * Crea un nuevo caso
 * @param {Object} data - Datos del caso
 * @param {number} userId - ID del usuario creador
 * @returns {Promise<Object>}
 */
const createCase = async (data, userId) => {
  const { title, description } = data;

  const newCase = await prisma.case.create({
    data: {
      ownerUserId: userId,
      title,
      description: description || null,
      userIdRegistration: userId
    }
  });

  return getCaseById(newCase.id, false);
};

// ============================================================================
// ACTUALIZAR CASO
// ============================================================================

/**
 * Actualiza un caso existente
 * @param {number} caseId - ID del caso
 * @param {Object} data - Datos a actualizar
 * @param {number} modifiedBy - ID del usuario que modifica
 * @returns {Promise<Object>}
 */
const updateCase = async (caseId, data, modifiedBy) => {
  const { title, description } = data;

  const updateData = {
    userIdModification: modifiedBy,
    dateTimeModification: new Date()
  };

  if (title !== undefined) updateData.title = title;
  if (description !== undefined) updateData.description = description;

  await prisma.case.update({
    where: { id: caseId },
    data: updateData
  });

  return getCaseById(caseId, false);
};

// ============================================================================
// ELIMINAR CASO
// ============================================================================

/**
 * Elimina un caso (solo si no tiene evidencias)
 * @param {number} caseId - ID del caso
 * @returns {Promise<boolean>}
 */
const deleteCase = async (caseId) => {
  // Verificar si tiene evidencias
  const evidenceCount = await prisma.evidence.count({
    where: { caseId }
  });

  if (evidenceCount > 0) {
    throw new Error('CASE_HAS_EVIDENCE');
  }

  await prisma.case.delete({
    where: { id: caseId }
  });

  return true;
};

// ============================================================================
// VERIFICAR PROPIEDAD
// ============================================================================

/**
 * Verifica si un usuario es propietario de un caso
 * @param {number} caseId - ID del caso
 * @param {number} userId - ID del usuario
 * @returns {Promise<boolean>}
 */
const isOwner = async (caseId, userId) => {
  const caseData = await prisma.case.findUnique({
    where: { id: caseId },
    select: { ownerUserId: true }
  });

  return caseData?.ownerUserId === userId;
};

// ============================================================================
// VERIFICAR EXISTENCIA
// ============================================================================

/**
 * Verifica si un caso existe
 * @param {number} caseId - ID del caso
 * @returns {Promise<boolean>}
 */
const caseExists = async (caseId) => {
  const count = await prisma.case.count({
    where: { id: caseId }
  });
  return count > 0;
};

// ============================================================================
// CONTAR EVIDENCIAS EN CASO
// ============================================================================

/**
 * Cuenta las evidencias de un caso
 * @param {number} caseId - ID del caso
 * @returns {Promise<number>}
 */
const countEvidenceInCase = async (caseId) => {
  return prisma.evidence.count({
    where: { caseId }
  });
};

// ============================================================================
// OBTENER CASOS LISTOS PARA EXPORTAR
// ============================================================================

/**
 * Obtiene casos con todas sus evidencias listas para exportar
 * @param {number} userId - ID del propietario
 * @returns {Promise<Array>}
 */
const getCasesReadyForExport = async (userId) => {
  const cases = await prisma.case.findMany({
    where: {
      ownerUserId: userId,
      evidence: {
        every: {
          status: 'READY_FOR_EXPORT'
        },
        some: {} // Al menos una evidencia
      }
    },
    include: {
      _count: {
        select: { evidence: true }
      }
    }
  });

  return cases.map(c => ({
    id: c.id,
    title: c.title,
    evidenceCount: c._count.evidence
  }));
};

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  listCases,
  getCaseById,
  createCase,
  updateCase,
  deleteCase,
  isOwner,
  caseExists,
  countEvidenceInCase,
  getCasesReadyForExport
};
