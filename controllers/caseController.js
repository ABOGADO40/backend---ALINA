// ============================================================================
// CASE CONTROLLER - Gestion de casos/expedientes
// Sistema PRUEBA DIGITAL
// ============================================================================

const { prisma } = require('../config/db');
const { createAuditLog } = require('../services/auditService');

// ============================================================================
// LISTAR CASOS
// ============================================================================

/**
 * GET /api/cases
 * Lista casos del usuario (o todos para SUPER_ADMIN)
 */
const listCases = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    // Construir filtros
    const where = {};

    // Si no es SUPER_ADMIN, solo ver sus propios casos
    if (!req.user.roles.includes('SUPER_ADMIN')) {
      where.ownerUserId = req.user.id;
    }

    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } }
      ];
    }

    // Ejecutar consultas
    const [cases, total] = await Promise.all([
      prisma.case.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          owner: {
            select: { id: true, email: true, fullName: true }
          },
          _count: {
            select: { evidence: true }
          }
        }
      }),
      prisma.case.count({ where })
    ]);

    // Formatear respuesta
    const formattedCases = cases.map(c => ({
      id: c.id,
      title: c.title,
      description: c.description,
      owner: c.owner,
      evidenceCount: c._count.evidence,
      createdAt: c.createdAt
    }));

    res.json({
      success: true,
      data: {
        cases: formattedCases,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / take)
        }
      }
    });

  } catch (error) {
    console.error('[CaseController] Error listando casos:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al listar casos'
      }
    });
  }
};

// ============================================================================
// OBTENER CASO POR ID
// ============================================================================

/**
 * GET /api/cases/:id
 * Obtiene detalle de un caso
 */
const getCaseById = async (req, res) => {
  try {
    const { id } = req.params;

    const caseRecord = await prisma.case.findUnique({
      where: { id: parseInt(id) },
      include: {
        owner: {
          select: { id: true, email: true, fullName: true }
        },
        evidence: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            title: true,
            sourceType: true,
            status: true,
            isPublic: true,
            createdAt: true
          }
        }
      }
    });

    if (!caseRecord) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'CASE_NOT_FOUND',
          message: 'Caso no encontrado'
        }
      });
    }

    // Verificar acceso
    if (!req.user.roles.includes('SUPER_ADMIN') && caseRecord.ownerUserId !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'ACCESS_DENIED',
          message: 'No tiene acceso a este caso'
        }
      });
    }

    res.json({
      success: true,
      data: {
        id: caseRecord.id,
        title: caseRecord.title,
        description: caseRecord.description,
        owner: caseRecord.owner,
        evidences: caseRecord.evidence,
        createdAt: caseRecord.createdAt
      }
    });

  } catch (error) {
    console.error('[CaseController] Error obteniendo caso:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al obtener caso'
      }
    });
  }
};

// ============================================================================
// CREAR CASO
// ============================================================================

/**
 * POST /api/cases
 * Crea un nuevo caso
 */
const createCase = async (req, res) => {
  try {
    const { title, description } = req.body;

    const newCase = await prisma.case.create({
      data: {
        title,
        description: description || null,
        ownerUserId: req.user.id,
        userIdRegistration: req.user.id
      }
    });

    // Registrar auditoria
    await createAuditLog(
      req.user.id,
      'CASE_CREATE',
      'cases',
      newCase.id,
      { title },
      req.ip,
      req.get('User-Agent')
    );

    res.status(201).json({
      success: true,
      data: {
        id: newCase.id,
        title: newCase.title,
        description: newCase.description,
        createdAt: newCase.createdAt
      }
    });

  } catch (error) {
    console.error('[CaseController] Error creando caso:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al crear caso'
      }
    });
  }
};

// ============================================================================
// ACTUALIZAR CASO
// ============================================================================

/**
 * PUT /api/cases/:id
 * Actualiza un caso existente
 */
const updateCase = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description } = req.body;

    const caseId = parseInt(id);

    // Verificar que existe
    const existingCase = await prisma.case.findUnique({
      where: { id: caseId }
    });

    if (!existingCase) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'CASE_NOT_FOUND',
          message: 'Caso no encontrado'
        }
      });
    }

    // Verificar acceso
    if (!req.user.roles.includes('SUPER_ADMIN') && existingCase.ownerUserId !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'ACCESS_DENIED',
          message: 'No tiene acceso a este caso'
        }
      });
    }

    // Preparar actualizacion
    const updateData = {
      userIdModification: req.user.id,
      dateTimeModification: new Date()
    };

    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;

    const updatedCase = await prisma.case.update({
      where: { id: caseId },
      data: updateData
    });

    // Registrar auditoria
    await createAuditLog(
      req.user.id,
      'CASE_UPDATE',
      'cases',
      caseId,
      { title, description },
      req.ip,
      req.get('User-Agent')
    );

    res.json({
      success: true,
      data: {
        id: updatedCase.id,
        title: updatedCase.title,
        description: updatedCase.description,
        createdAt: updatedCase.createdAt
      }
    });

  } catch (error) {
    console.error('[CaseController] Error actualizando caso:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al actualizar caso'
      }
    });
  }
};

// ============================================================================
// ELIMINAR CASO
// ============================================================================

/**
 * DELETE /api/cases/:id
 * Archiva un caso (soft delete)
 */
const deleteCase = async (req, res) => {
  try {
    const { id } = req.params;
    const caseId = parseInt(id);

    const existingCase = await prisma.case.findUnique({
      where: { id: caseId },
      include: {
        _count: { select: { evidence: true } }
      }
    });

    if (!existingCase) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'CASE_NOT_FOUND',
          message: 'Caso no encontrado'
        }
      });
    }

    // Verificar acceso
    if (!req.user.roles.includes('SUPER_ADMIN') && existingCase.ownerUserId !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'ACCESS_DENIED',
          message: 'No tiene acceso a este caso'
        }
      });
    }

    // No eliminar si tiene evidencias
    if (existingCase._count.evidence > 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'CASE_HAS_EVIDENCES',
          message: 'No se puede eliminar un caso con evidencias.'
        }
      });
    }

    // Eliminar caso (hard delete ya que no tiene evidencias)
    await prisma.case.delete({
      where: { id: caseId }
    });

    // Registrar auditoria
    await createAuditLog(
      req.user.id,
      'CASE_DELETE',
      'cases',
      caseId,
      { title: existingCase.title },
      req.ip,
      req.get('User-Agent')
    );

    res.json({
      success: true,
      data: {
        message: 'Caso eliminado correctamente'
      }
    });

  } catch (error) {
    console.error('[CaseController] Error eliminando caso:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al eliminar caso'
      }
    });
  }
};

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  listCases,
  getCaseById,
  createCase,
  updateCase,
  deleteCase
};
