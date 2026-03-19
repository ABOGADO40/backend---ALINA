// ============================================================================
// EXPORT CONTROLLER - Gestion de exportaciones ZIP forenses
// Sistema PRUEBA DIGITAL
// ============================================================================

const { prisma } = require('../config/db');
const { createAuditLog } = require('../services/auditService');
const exportService = require('../services/exportService');
// NOTA: custodyService NO se usa aquí - EXPORT se registra en AuditLog (ver exportService.js)

// ============================================================================
// LISTAR EXPORTACIONES
// ============================================================================

/**
 * GET /api/exports
 * Lista exportaciones del usuario
 */
const listExports = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    // Construir filtros
    const where = {};

    // Si no es SUPER_ADMIN, solo ver sus propias exportaciones
    if (!req.user.roles.includes('SUPER_ADMIN')) {
      where.requestedByUserId = req.user.id;
    }

    if (status) {
      where.status = status;
    }

    // Ejecutar consultas
    const [exports, total] = await Promise.all([
      prisma.export.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          requestedBy: {
            select: { id: true, email: true, fullName: true }
          },
          exportFile: {
            select: { originalFilename: true, sizeBytes: true }
          },
          evidence: {
            select: { id: true, title: true }
          },
          case: {
            select: { id: true, title: true }
          },
          items: {
            include: {
              evidence: {
                select: { id: true, title: true }
              }
            }
          },
          _count: {
            select: { items: true }
          }
        }
      }),
      prisma.export.count({ where })
    ]);

    // Formatear respuesta
    const formattedExports = exports.map(e => {
      // Determinar el título a mostrar
      let displayTitle = null;
      if (e.scope === 'SINGLE_EVIDENCE' && e.evidence) {
        displayTitle = e.evidence.title;
      } else if (e.scope === 'FULL_CASE' && e.case) {
        displayTitle = e.case.title;
      } else if (e.items && e.items.length > 0) {
        // Para MULTIPLE_EVIDENCE, mostrar cantidad o primera evidencia
        if (e.items.length === 1) {
          displayTitle = e.items[0].evidence?.title;
        } else {
          displayTitle = `${e.items.length} evidencias`;
        }
      }

      return {
        id: e.id,
        status: e.status,
        scope: e.scope,
        file: e.exportFile ? {
          filename: e.exportFile.originalFilename,
          sizeBytes: Number(e.exportFile.sizeBytes)
        } : null,
        evidence: e.evidence ? { id: e.evidence.id, title: e.evidence.title } : null,
        case: e.case ? { id: e.case.id, title: e.case.title } : null,
        evidenceCount: e._count.items,
        displayTitle,
        user: e.requestedBy,
        createdAt: e.createdAt
      };
    });

    res.json({
      success: true,
      data: {
        exports: formattedExports,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / take)
        }
      }
    });

  } catch (error) {
    console.error('[ExportController] Error listando exportaciones:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al listar exportaciones'
      }
    });
  }
};

// ============================================================================
// OBTENER EXPORTACION POR ID
// ============================================================================

/**
 * GET /api/exports/:id
 * Obtiene detalle de una exportacion
 */
const getExportById = async (req, res) => {
  try {
    const { id } = req.params;

    const exportRecord = await prisma.export.findUnique({
      where: { id: parseInt(id) },
      include: {
        requestedBy: {
          select: { id: true, email: true, fullName: true }
        },
        exportFile: {
          include: {
            hashRecords: {
              orderBy: { computedAt: 'desc' },
              take: 1
            }
          }
        },
        items: {
          include: {
            evidence: {
              select: { id: true, title: true, sourceType: true, status: true }
            }
          }
        }
      }
    });

    if (!exportRecord) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'EXPORT_NOT_FOUND',
          message: 'Exportacion no encontrada'
        }
      });
    }

    // Verificar acceso
    if (!req.user.roles.includes('SUPER_ADMIN') && exportRecord.requestedByUserId !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'ACCESS_DENIED',
          message: 'No tiene acceso a esta exportacion'
        }
      });
    }

    res.json({
      success: true,
      data: {
        id: exportRecord.id,
        status: exportRecord.status,
        scope: exportRecord.scope,
        filename: exportRecord.exportFile?.originalFilename || null,
        sizeBytes: exportRecord.exportFile?.sizeBytes ? Number(exportRecord.exportFile.sizeBytes) : null,
        hash: exportRecord.exportFile?.hashRecords?.[0]?.hashHex || null,
        user: exportRecord.requestedBy,
        items: exportRecord.items.map(i => ({
          id: i.id,
          evidence: i.evidence,
          includedAt: i.createdAt
        })),
        createdAt: exportRecord.createdAt
      }
    });

  } catch (error) {
    console.error('[ExportController] Error obteniendo exportacion:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al obtener exportacion'
      }
    });
  }
};

// ============================================================================
// CREAR EXPORTACION
// ============================================================================

/**
 * POST /api/exports
 * Crea una nueva exportacion ZIP forense
 */
const createExport = async (req, res) => {
  try {
    const { evidenceIds, password } = req.body;

    if (!evidenceIds || !Array.isArray(evidenceIds) || evidenceIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'EVIDENCE_IDS_REQUIRED',
          message: 'Se requiere al menos una evidencia'
        }
      });
    }

    if (!password || password.length < 8) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'PASSWORD_REQUIRED',
          message: 'Se requiere una contrasena de al menos 8 caracteres'
        }
      });
    }

    // Verificar que todas las evidencias existen y el usuario tiene acceso
    const evidences = await prisma.evidence.findMany({
      where: {
        id: { in: evidenceIds.map(id => parseInt(id)) }
      },
      include: {
        case: { select: { ownerUserId: true } }
      }
    });

    if (evidences.length !== evidenceIds.length) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'EVIDENCE_NOT_FOUND',
          message: 'Una o mas evidencias no fueron encontradas'
        }
      });
    }

    // Verificar acceso a todas las evidencias
    if (!req.user.roles.includes('SUPER_ADMIN')) {
      const unauthorized = evidences.filter(e => e.case.ownerUserId !== req.user.id);
      if (unauthorized.length > 0) {
        return res.status(403).json({
          success: false,
          error: {
            code: 'ACCESS_DENIED',
            message: 'No tiene acceso a una o mas evidencias seleccionadas'
          }
        });
      }
    }

    // Verificar que todas estan en estado READY_FOR_EXPORT o EXPORTED
    const notReady = evidences.filter(e => !['READY_FOR_EXPORT', 'EXPORTED'].includes(e.status));
    if (notReady.length > 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'EVIDENCE_NOT_READY',
          message: 'Todas las evidencias deben estar procesadas (READY_FOR_EXPORT)'
        }
      });
    }

    // Crear registro de exportacion
    const exportRecord = await prisma.$transaction(async (tx) => {
      // Crear exportacion
      const newExport = await tx.export.create({
        data: {
          requestedByUserId: req.user.id,
          scope: 'MULTIPLE_EVIDENCE',
          status: 'CREATING',
          userIdRegistration: req.user.id
        }
      });

      // Crear items de exportacion
      for (const evidenceId of evidenceIds) {
        await tx.exportItem.create({
          data: {
            exportId: newExport.id,
            evidenceId: parseInt(evidenceId),
            userIdRegistration: req.user.id
          }
        });
      }

      return newExport;
    });

    // Generar ZIP forense (asincrono)
    generateZipAsync(exportRecord.id, evidenceIds.map(id => parseInt(id)), password, req.user.id);

    // Registrar auditoria
    await createAuditLog(
      req.user.id,
      'EXPORT_CREATE',
      'exports',
      exportRecord.id,
      { evidenceCount: evidenceIds.length },
      req.ip,
      req.get('User-Agent')
    );

    res.status(201).json({
      success: true,
      data: {
        id: exportRecord.id,
        status: 'CREATING',
        message: 'Exportacion iniciada. Estara disponible en unos minutos.',
        evidenceCount: evidenceIds.length
      }
    });

  } catch (error) {
    console.error('[ExportController] Error creando exportacion:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al crear exportacion'
      }
    });
  }
};

/**
 * Genera el ZIP de forma asincrona
 */
async function generateZipAsync(exportId, evidenceIds, password, userId) {
  try {
    // Generar ZIP
    const result = await exportService.createForensicZip(exportId, evidenceIds, password, userId);

    // Actualizar exportacion con resultado
    await prisma.export.update({
      where: { id: exportId },
      data: {
        status: 'READY',
        exportFileId: result.fileId || null,
        userIdModification: userId
      }
    });

    // NOTA: El registro de EXPORT se hace en AuditLog (no en custody_events)
    // porque la evidencia ya está sellada con CRYPTO_SEAL_CREATED.
    // Ver exportService.js líneas 162-190 donde se registra en AuditLog.

    console.log(`[ExportController] Exportacion ${exportId} completada`);

  } catch (error) {
    console.error(`[ExportController] Error generando ZIP para export ${exportId}:`, error);

    await prisma.export.update({
      where: { id: exportId },
      data: {
        status: 'ERROR',
        userIdModification: userId
      }
    });
  }
}

// ============================================================================
// DESCARGAR EXPORTACION
// ============================================================================

/**
 * GET /api/exports/:id/download
 * Descarga el ZIP de una exportacion
 */
const downloadExport = async (req, res) => {
  try {
    const { id } = req.params;

    const exportRecord = await prisma.export.findUnique({
      where: { id: parseInt(id) },
      include: {
        exportFile: {
          select: { storageKey: true, originalFilename: true, sizeBytes: true, isEncrypted: true }
        }
      }
    });

    if (!exportRecord) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'EXPORT_NOT_FOUND',
          message: 'Exportacion no encontrada'
        }
      });
    }

    // Verificar acceso
    if (!req.user.roles.includes('SUPER_ADMIN') && exportRecord.requestedByUserId !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'ACCESS_DENIED',
          message: 'No tiene acceso a esta exportacion'
        }
      });
    }

    // Verificar estado
    if (exportRecord.status !== 'READY') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'EXPORT_NOT_READY',
          message: `La exportacion esta en estado: ${exportRecord.status}`
        }
      });
    }

    // Verificar que existe el archivo
    if (!exportRecord.exportFile) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'FILE_NOT_FOUND',
          message: 'Archivo de exportacion no encontrado'
        }
      });
    }

    // Obtener stream
    const stream = exportService.getDownloadStream(exportRecord.exportFile.storageKey);

    // NOTA: No actualizamos el status porque DOWNLOADED no existe en el enum
    // La descarga queda registrada en el audit log

    // Registrar auditoria
    await createAuditLog(
      req.user.id,
      'EXPORT_DOWNLOAD',
      'exports',
      exportRecord.id,
      { filename: exportRecord.exportFile.originalFilename },
      req.ip,
      req.get('User-Agent')
    );

    // Configurar headers
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${exportRecord.exportFile.originalFilename || 'export.zip'}"`);
    if (exportRecord.exportFile.sizeBytes) {
      res.setHeader('Content-Length', Number(exportRecord.exportFile.sizeBytes));
    }

    // Pipe stream
    stream.pipe(res);

  } catch (error) {
    console.error('[ExportController] Error descargando exportacion:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al descargar exportacion'
      }
    });
  }
};

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  listExports,
  getExportById,
  createExport,
  downloadExport
};
