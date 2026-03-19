// ============================================================================
// ACTA CONTROLLER - Gestion de Actas de Obtencion de Evidencia Digital
// Sistema PRUEBA DIGITAL
// ============================================================================

const { prisma } = require('../config/db');
const actaService = require('../services/actaService');
const { createAuditLog } = require('../services/auditService');

// ============================================================================
// CREAR REGISTRO DE APORTANTE
// ============================================================================

/**
 * POST /api/evidences/:id/contributor
 * Crea un nuevo registro de aportante para una evidencia
 */
const createContributorRecord = async (req, res) => {
  try {
    const { id } = req.params;
    const evidenceId = parseInt(id);

    // Verificar que la evidencia existe y el usuario tiene acceso
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      include: {
        case: { select: { ownerUserId: true } }
      }
    });

    if (!evidence) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'EVIDENCE_NOT_FOUND',
          message: 'Evidencia no encontrada'
        }
      });
    }

    // Verificar acceso
    const caseOwnerId = evidence.case?.ownerUserId;
    const evidenceOwnerId = evidence.ownerUserId;
    const isOwner = caseOwnerId === req.user.id || evidenceOwnerId === req.user.id;

    if (!req.user.roles.includes('SUPER_ADMIN') && !isOwner) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'ACCESS_DENIED',
          message: 'No tiene acceso a esta evidencia'
        }
      });
    }

    // Crear registro de aportante
    const record = await actaService.createContributorRecord(
      evidenceId,
      req.body,
      req.user.id
    );

    // Registrar auditoria
    await createAuditLog(
      req.user.id,
      'CONTRIBUTOR_RECORD_CREATE',
      'evidence_contributor_records',
      record.id,
      {
        evidenceId,
        aportanteNombre: req.body.aportanteNombreCompleto,
        aportanteDocumento: req.body.aportanteDocumentoNumero
      },
      req.ip,
      req.get('User-Agent')
    );

    res.status(201).json({
      success: true,
      data: record
    });

  } catch (error) {
    console.error('[ActaController] Error creando registro de aportante:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error.message || 'Error al crear registro de aportante'
      }
    });
  }
};

// ============================================================================
// LISTAR REGISTROS DE APORTANTES
// ============================================================================

/**
 * GET /api/evidences/:id/contributors
 * Obtiene todos los registros de aportantes de una evidencia
 */
const getContributorRecords = async (req, res) => {
  try {
    const { id } = req.params;
    const evidenceId = parseInt(id);

    // Verificar que la evidencia existe y el usuario tiene acceso
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      include: {
        case: { select: { ownerUserId: true } }
      }
    });

    if (!evidence) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'EVIDENCE_NOT_FOUND',
          message: 'Evidencia no encontrada'
        }
      });
    }

    // Verificar acceso
    const caseOwnerId = evidence.case?.ownerUserId;
    const evidenceOwnerId = evidence.ownerUserId;
    const isOwner = caseOwnerId === req.user.id || evidenceOwnerId === req.user.id;

    if (!req.user.roles.includes('SUPER_ADMIN') && !isOwner) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'ACCESS_DENIED',
          message: 'No tiene acceso a esta evidencia'
        }
      });
    }

    const records = await actaService.getContributorRecords(evidenceId);

    res.json({
      success: true,
      data: {
        contributors: records,
        total: records.length
      }
    });

  } catch (error) {
    console.error('[ActaController] Error listando registros de aportantes:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al listar registros de aportantes'
      }
    });
  }
};

// ============================================================================
// GENERAR ACTA PDF
// ============================================================================

/**
 * POST /api/evidences/:id/actas/generate
 * Genera el PDF del Acta de Obtencion de Evidencia Digital
 */
const generateActaPdf = async (req, res) => {
  try {
    const { id } = req.params;
    const { contributorRecordId } = req.body;
    const evidenceId = parseInt(id);

    if (!contributorRecordId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_CONTRIBUTOR',
          message: 'Se requiere el ID del registro de aportante'
        }
      });
    }

    // Verificar que la evidencia existe y el usuario tiene acceso
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      include: {
        case: { select: { ownerUserId: true } }
      }
    });

    if (!evidence) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'EVIDENCE_NOT_FOUND',
          message: 'Evidencia no encontrada'
        }
      });
    }

    // Verificar acceso
    const caseOwnerId = evidence.case?.ownerUserId;
    const evidenceOwnerId = evidence.ownerUserId;
    const isOwner = caseOwnerId === req.user.id || evidenceOwnerId === req.user.id;

    if (!req.user.roles.includes('SUPER_ADMIN') && !isOwner) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'ACCESS_DENIED',
          message: 'No tiene acceso a esta evidencia'
        }
      });
    }

    // Generar acta
    const result = await actaService.generateActaPdf(
      evidenceId,
      parseInt(contributorRecordId),
      req.user.id
    );

    // Registrar auditoria
    await createAuditLog(
      req.user.id,
      'ACTA_GENERATED',
      'generated_actas',
      result.id,
      {
        evidenceId,
        actaNumero: result.actaNumero,
        contributorRecordId
      },
      req.ip,
      req.get('User-Agent')
    );

    res.status(201).json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('[ActaController] Error generando acta:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error.message || 'Error al generar acta'
      }
    });
  }
};

// ============================================================================
// LISTAR ACTAS GENERADAS
// ============================================================================

/**
 * GET /api/evidences/:id/actas
 * Obtiene todas las actas generadas de una evidencia
 */
const getGeneratedActas = async (req, res) => {
  try {
    const { id } = req.params;
    const evidenceId = parseInt(id);

    // Verificar que la evidencia existe y el usuario tiene acceso
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      include: {
        case: { select: { ownerUserId: true } }
      }
    });

    if (!evidence) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'EVIDENCE_NOT_FOUND',
          message: 'Evidencia no encontrada'
        }
      });
    }

    // Verificar acceso
    const caseOwnerId = evidence.case?.ownerUserId;
    const evidenceOwnerId = evidence.ownerUserId;
    const isOwner = caseOwnerId === req.user.id || evidenceOwnerId === req.user.id;

    if (!req.user.roles.includes('SUPER_ADMIN') && !isOwner) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'ACCESS_DENIED',
          message: 'No tiene acceso a esta evidencia'
        }
      });
    }

    const actas = await actaService.getGeneratedActas(evidenceId);

    res.json({
      success: true,
      data: {
        actas,
        total: actas.length
      }
    });

  } catch (error) {
    console.error('[ActaController] Error listando actas:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al listar actas'
      }
    });
  }
};

// ============================================================================
// DESCARGAR ACTA
// ============================================================================

/**
 * GET /api/evidences/actas/:actaId/download
 * Descarga el PDF de un acta
 */
const downloadActa = async (req, res) => {
  try {
    const { actaId } = req.params;

    // Obtener acta para verificar permisos
    const actaQuery = await prisma.$queryRaw`
      SELECT ga.*, e.owner_user_id, c.owner_user_id as case_owner_id
      FROM generated_actas ga
      JOIN evidence e ON e.id = ga.evidence_id
      LEFT JOIN cases c ON c.id = e.case_id
      WHERE ga.id = ${parseInt(actaId)}
    `;

    if (!actaQuery || actaQuery.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'ACTA_NOT_FOUND',
          message: 'Acta no encontrada'
        }
      });
    }

    const acta = actaQuery[0];

    // Verificar acceso
    const caseOwnerId = acta.case_owner_id;
    const evidenceOwnerId = acta.owner_user_id;
    const isOwner = caseOwnerId === req.user.id || evidenceOwnerId === req.user.id;

    if (!req.user.roles.includes('SUPER_ADMIN') && !isOwner) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'ACCESS_DENIED',
          message: 'No tiene acceso a esta acta'
        }
      });
    }

    // Obtener archivo
    const { stream, filename, mimeType, sizeBytes } = await actaService.downloadActa(parseInt(actaId));

    // Registrar auditoria
    await createAuditLog(
      req.user.id,
      'ACTA_DOWNLOAD',
      'generated_actas',
      parseInt(actaId),
      {
        actaNumero: acta.acta_numero,
        evidenceId: acta.evidence_id
      },
      req.ip,
      req.get('User-Agent')
    );

    // Configurar headers
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', sizeBytes);

    // Enviar archivo
    stream.pipe(res);

  } catch (error) {
    console.error('[ActaController] Error descargando acta:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error.message || 'Error al descargar acta'
      }
    });
  }
};

// ============================================================================
// OBTENER TODOS LOS DOCUMENTOS
// ============================================================================

/**
 * GET /api/evidences/:id/documents
 * Obtiene la lista de todos los documentos disponibles para una evidencia
 */
const getAllDocuments = async (req, res) => {
  try {
    const { id } = req.params;
    const evidenceId = parseInt(id);

    // Verificar que la evidencia existe y el usuario tiene acceso
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      include: {
        case: { select: { ownerUserId: true } }
      }
    });

    if (!evidence) {
      return res.status(404).json({
        success: false,
        error: { code: 'EVIDENCE_NOT_FOUND', message: 'Evidencia no encontrada' }
      });
    }

    // Verificar acceso
    const caseOwnerId = evidence.case?.ownerUserId;
    const evidenceOwnerId = evidence.ownerUserId;
    const isOwner = caseOwnerId === req.user.id || evidenceOwnerId === req.user.id;

    if (!req.user.roles.includes('SUPER_ADMIN') && !isOwner) {
      return res.status(403).json({
        success: false,
        error: { code: 'ACCESS_DENIED', message: 'No tiene acceso a esta evidencia' }
      });
    }

    const documents = await actaService.getAllDocuments(evidenceId);

    res.json({ success: true, data: documents });

  } catch (error) {
    console.error('[ActaController] Error obteniendo documentos:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Error al obtener documentos' }
    });
  }
};

// ============================================================================
// DESCARGAR CERTIFICADO DE EVIDENCIA DIGITAL
// ============================================================================

/**
 * GET /api/evidences/:id/documents/certificado/download
 * Descarga el Certificado de Evidencia Digital en PDF
 */
const downloadCertificado = async (req, res) => {
  try {
    const { id } = req.params;
    const evidenceId = parseInt(id);

    // Verificar que la evidencia existe y el usuario tiene acceso
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      include: { case: { select: { ownerUserId: true } } }
    });

    if (!evidence) {
      return res.status(404).json({
        success: false,
        error: { code: 'EVIDENCE_NOT_FOUND', message: 'Evidencia no encontrada' }
      });
    }

    // Verificar acceso
    const caseOwnerId = evidence.case?.ownerUserId;
    const evidenceOwnerId = evidence.ownerUserId;
    const isOwner = caseOwnerId === req.user.id || evidenceOwnerId === req.user.id;

    if (!req.user.roles.includes('SUPER_ADMIN') && !isOwner) {
      return res.status(403).json({
        success: false,
        error: { code: 'ACCESS_DENIED', message: 'No tiene acceso a esta evidencia' }
      });
    }

    // Generar el PDF
    const result = await actaService.generateCertificadoPdf(evidenceId, req.user.id);

    // Leer el archivo generado
    const fs = require('fs');
    const { getFullPath } = require('../config/storage');
    const fullPath = getFullPath(result.storageKey);
    const fileBuffer = await fs.promises.readFile(fullPath);

    // Registrar auditoria
    await createAuditLog(
      req.user.id,
      'CERTIFICADO_DOWNLOAD',
      'evidence',
      evidenceId,
      { certNumero: result.certNumero },
      req.ip,
      req.get('User-Agent')
    );

    // Enviar archivo
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Content-Length', result.pdfSizeBytes);
    res.send(fileBuffer);

  } catch (error) {
    console.error('[ActaController] Error descargando certificado:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message || 'Error al descargar certificado' }
    });
  }
};

// ============================================================================
// DESCARGAR REPORTE DE CADENA DE CUSTODIA
// ============================================================================

/**
 * GET /api/evidences/:id/documents/cadena-custodia/download
 * Descarga el Reporte de Cadena de Custodia en PDF
 */
const downloadCadenaCustodia = async (req, res) => {
  try {
    const { id } = req.params;
    const evidenceId = parseInt(id);

    // Verificar que la evidencia existe y el usuario tiene acceso
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      include: { case: { select: { ownerUserId: true } } }
    });

    if (!evidence) {
      return res.status(404).json({
        success: false,
        error: { code: 'EVIDENCE_NOT_FOUND', message: 'Evidencia no encontrada' }
      });
    }

    // Verificar acceso
    const caseOwnerId = evidence.case?.ownerUserId;
    const evidenceOwnerId = evidence.ownerUserId;
    const isOwner = caseOwnerId === req.user.id || evidenceOwnerId === req.user.id;

    if (!req.user.roles.includes('SUPER_ADMIN') && !isOwner) {
      return res.status(403).json({
        success: false,
        error: { code: 'ACCESS_DENIED', message: 'No tiene acceso a esta evidencia' }
      });
    }

    // Generar el PDF
    const result = await actaService.generateCadenaCustodiaPdf(evidenceId, req.user.id);

    // Leer el archivo generado
    const fs = require('fs');
    const { getFullPath } = require('../config/storage');
    const fullPath = getFullPath(result.storageKey);
    const fileBuffer = await fs.promises.readFile(fullPath);

    // Registrar auditoria
    await createAuditLog(
      req.user.id,
      'CADENA_CUSTODIA_DOWNLOAD',
      'evidence',
      evidenceId,
      { reporteNumero: result.reporteNumero, totalEventos: result.totalEventos },
      req.ip,
      req.get('User-Agent')
    );

    // Enviar archivo
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Content-Length', result.pdfSizeBytes);
    res.send(fileBuffer);

  } catch (error) {
    console.error('[ActaController] Error descargando cadena de custodia:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message || 'Error al descargar cadena de custodia' }
    });
  }
};

// ============================================================================
// DESCARGAR REPORTE DE METADATOS
// ============================================================================

/**
 * GET /api/evidences/:id/documents/metadatos/download
 * Descarga el Reporte de Metadatos en PDF
 */
const downloadMetadatos = async (req, res) => {
  try {
    const { id } = req.params;
    const evidenceId = parseInt(id);

    // Verificar que la evidencia existe y el usuario tiene acceso
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      include: { case: { select: { ownerUserId: true } } }
    });

    if (!evidence) {
      return res.status(404).json({
        success: false,
        error: { code: 'EVIDENCE_NOT_FOUND', message: 'Evidencia no encontrada' }
      });
    }

    // Verificar acceso
    const caseOwnerId = evidence.case?.ownerUserId;
    const evidenceOwnerId = evidence.ownerUserId;
    const isOwner = caseOwnerId === req.user.id || evidenceOwnerId === req.user.id;

    if (!req.user.roles.includes('SUPER_ADMIN') && !isOwner) {
      return res.status(403).json({
        success: false,
        error: { code: 'ACCESS_DENIED', message: 'No tiene acceso a esta evidencia' }
      });
    }

    // Generar el PDF
    const result = await actaService.generateMetadatosPdf(evidenceId, req.user.id);

    // Leer el archivo generado
    const fs = require('fs');
    const { getFullPath } = require('../config/storage');
    const fullPath = getFullPath(result.storageKey);
    const fileBuffer = await fs.promises.readFile(fullPath);

    // Registrar auditoria
    await createAuditLog(
      req.user.id,
      'METADATOS_DOWNLOAD',
      'evidence',
      evidenceId,
      { reporteNumero: result.reporteNumero },
      req.ip,
      req.get('User-Agent')
    );

    // Enviar archivo
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Content-Length', result.pdfSizeBytes);
    res.send(fileBuffer);

  } catch (error) {
    console.error('[ActaController] Error descargando metadatos:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message || 'Error al descargar metadatos' }
    });
  }
};

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  createContributorRecord,
  getContributorRecords,
  generateActaPdf,
  getGeneratedActas,
  downloadActa,
  getAllDocuments,
  downloadCertificado,
  downloadCadenaCustodia,
  downloadMetadatos
};
