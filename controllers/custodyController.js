// ============================================================================
// CUSTODY CONTROLLER - Consulta de cadena de custodia
// Sistema PRUEBA DIGITAL
// ============================================================================

const { prisma } = require('../config/db');
const custodyService = require('../services/custodyService');
const { createAuditLog } = require('../services/auditService');

// ============================================================================
// OBTENER CADENA DE CUSTODIA
// ============================================================================

/**
 * GET /api/evidences/:id/custody
 * Obtiene la cadena de custodia completa de una evidencia
 */
const getCustodyChain = async (req, res) => {
  try {
    const { id } = req.params;
    const evidenceId = parseInt(id);

    // Verificar que la evidencia existe
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: {
        id: true,
        title: true,
        ownerUserId: true,
        isPublic: true,
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
    const isOwner = evidence.ownerUserId === req.user.id ||
                    (evidence.case && evidence.case.ownerUserId === req.user.id);
    if (!req.user.roles.includes('SUPER_ADMIN') && !isOwner) {
      if (!evidence.isPublic) {
        return res.status(403).json({
          success: false,
          error: {
            code: 'ACCESS_DENIED',
            message: 'No tiene acceso a esta evidencia'
          }
        });
      }
    }

    // Obtener eventos de custodia
    const events = await prisma.custodyEvent.findMany({
      where: { evidenceId },
      orderBy: { eventAt: 'asc' },
      include: {
        actor: {
          select: { id: true, email: true, fullName: true }
        }
      }
    });

    // Verificar integridad de la cadena
    let chainIntegrity = 'VERIFIED';
    let previousHash = null;

    for (const event of events) {
      if (previousHash && event.prevEventHash !== previousHash) {
        chainIntegrity = 'BROKEN';
        break;
      }
      previousHash = event.eventHash;
    }

    // Formatear eventos
    const formattedEvents = events.map(event => ({
      id: event.id,
      eventType: event.eventType,
      details: event.details,
      eventAt: event.eventAt,
      eventHash: event.eventHash,
      prevEventHash: event.prevEventHash,
      actor: event.actor,
      actorType: event.actorType
    }));

    res.json({
      success: true,
      data: {
        evidenceId,
        evidenceTitle: evidence.title,
        totalEvents: events.length,
        chainIntegrity,
        events: formattedEvents
      }
    });

  } catch (error) {
    console.error('[CustodyController] Error obteniendo cadena:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al obtener cadena de custodia'
      }
    });
  }
};

// ============================================================================
// EXPORTAR CADENA DE CUSTODIA
// ============================================================================

/**
 * GET /api/evidences/:id/custody/export
 * Exporta la cadena de custodia en formato TXT legible
 */
const exportCustodyChain = async (req, res) => {
  try {
    const { id } = req.params;
    const evidenceId = parseInt(id);

    // Verificar que la evidencia existe
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: {
        id: true,
        title: true,
        ownerUserId: true,
        case: { select: { ownerUserId: true, internalCode: true, title: true } }
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
    const isOwner = evidence.ownerUserId === req.user.id ||
                    (evidence.case && evidence.case.ownerUserId === req.user.id);
    if (!req.user.roles.includes('SUPER_ADMIN') && !isOwner) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'ACCESS_DENIED',
          message: 'No tiene acceso a esta evidencia'
        }
      });
    }

    // Exportar usando el servicio de custodia
    const exportData = await custodyService.exportCustodyAsJson(evidenceId);

    // Convertir a formato TXT legible
    const txtContent = formatCustodyChainAsTxt(exportData, evidence);

    // Registrar evento de custodia
    await custodyService.registerEvent(
      evidenceId,
      'EXPORT_CUSTODY',
      'USER',            // actorType
      req.user.id,       // actorUserId
      { format: 'txt', message: 'Cadena de custodia exportada' }
    );

    // Registrar auditoria
    await createAuditLog(
      req.user.id,
      'CUSTODY_EXPORT',
      'custody_events',
      null,
      { evidenceId, eventCount: exportData.events.length },
      req.ip,
      req.get('User-Agent')
    );

    // Configurar headers para descarga TXT
    const filename = `cadena_custodia_evidencia_${evidenceId}_${new Date().toISOString().split('T')[0]}.txt`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    res.send(txtContent);

  } catch (error) {
    console.error('[CustodyController] Error exportando cadena:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al exportar cadena de custodia'
      }
    });
  }
};

/**
 * Formatea la cadena de custodia como texto legible
 */
function formatCustodyChainAsTxt(exportData, evidence) {
  const eventTypeLabels = {
    UPLOAD: 'Archivo Subido',
    SCAN_OK: 'Escaneo Exitoso',
    SCAN_FAILED: 'Escaneo Fallido',
    HASH_COMPUTED: 'Hash Calculado',
    HASH_CALCULATED: 'Hash Calculado',
    BITCOPY_CREATED: 'Copia Bit-a-Bit Creada',
    SEAL_CREATED: 'Documento Sellado',
    SEALED_DOC_CREATED: 'Documento Sellado',
    CRYPTO_SEAL_CREATED: 'Sello Criptografico Ed25519',
    METADATA_CREATED: 'Metadata Extraida',
    METADATA_EXTRACTED: 'Metadata Extraida',
    RISK_REPORT_CREATED: 'Reporte de Riesgo Generado',
    READY_FOR_EXPORT: 'Listo para Exportar',
    READY_EXPORT: 'Listo para Exportar',
    EXPORT_CREATED: 'Exportacion Creada',
    DOWNLOAD: 'Archivo Descargado',
    PUBLIC_VERIFY: 'Verificacion Publica',
    REGENERATE_VERSION: 'Version Regenerada',
    EXPORT_CUSTODY: 'Custodia Exportada',
    ERROR: 'Error'
  };

  let txt = `================================================================================
                    CADENA DE CUSTODIA - PRUEBA DIGITAL
                    Sistema de Evidencia Digital Forense
================================================================================

Fecha de exportacion: ${new Date().toISOString()}

--------------------------------------------------------------------------------
                           DATOS DE LA EVIDENCIA
--------------------------------------------------------------------------------

ID de Evidencia: ${evidence.id}
Titulo: ${evidence.title || 'Sin titulo'}
Caso: ${evidence.case?.title || 'Sin caso asignado'}
Codigo de Caso: ${evidence.case?.internalCode || 'N/A'}
Integridad de Cadena: ${exportData.chainIntegrity || 'VERIFICADA'}
Total de Eventos: ${exportData.events?.length || 0}

--------------------------------------------------------------------------------
                           EVENTOS DE CUSTODIA
--------------------------------------------------------------------------------

`;

  if (exportData.events && exportData.events.length > 0) {
    exportData.events.forEach((event, index) => {
      const eventLabel = eventTypeLabels[event.eventType] || event.eventType;
      const actorName = event.actor?.fullName || (event.actorType === 'SYSTEM' ? 'Sistema' : 'Desconocido');

      txt += `[Evento #${index + 1}] ${eventLabel}
  Fecha/Hora: ${new Date(event.eventAt).toLocaleString('es-ES', { timeZone: 'UTC' })} UTC
  Actor: ${actorName} (${event.actorType})
  Hash del Evento: ${event.eventHash || 'N/A'}
  Hash Anterior: ${event.prevEventHash || '(Genesis)'}`;

      if (event.details) {
        const details = typeof event.details === 'string' ? JSON.parse(event.details) : event.details;
        if (Object.keys(details).length > 0) {
          txt += `\n  Detalles:`;
          for (const [key, value] of Object.entries(details)) {
            if (value !== null && value !== undefined) {
              const displayValue = typeof value === 'object' ? JSON.stringify(value) : value;
              txt += `\n    - ${key}: ${displayValue}`;
            }
          }
        }
      }

      txt += `\n\n`;
    });
  } else {
    txt += `  (No hay eventos registrados)\n\n`;
  }

  txt += `--------------------------------------------------------------------------------
                              NOTA LEGAL
--------------------------------------------------------------------------------

Esta cadena de custodia digital garantiza la trazabilidad de todas las
operaciones realizadas sobre la evidencia. Cada evento esta vinculado
criptograficamente al anterior mediante hash SHA-256, formando una cadena
inmutable que puede ser verificada independientemente.

================================================================================
                           FIN DEL DOCUMENTO
================================================================================`;

  return txt;
}

// ============================================================================
// VERIFICAR INTEGRIDAD DE CADENA
// ============================================================================

/**
 * GET /api/evidences/:id/custody/verify
 * Verifica la integridad de la cadena de custodia
 */
const verifyCustodyIntegrity = async (req, res) => {
  try {
    const { id } = req.params;
    const evidenceId = parseInt(id);

    // Verificar que la evidencia existe
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: {
        id: true,
        ownerUserId: true,
        isPublic: true,
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

    // Verificar acceso (permitir si es publica)
    const isOwner = evidence.ownerUserId === req.user.id ||
                    (evidence.case && evidence.case.ownerUserId === req.user.id);
    if (!req.user.roles.includes('SUPER_ADMIN') && !isOwner) {
      if (!evidence.isPublic) {
        return res.status(403).json({
          success: false,
          error: {
            code: 'ACCESS_DENIED',
            message: 'No tiene acceso a esta evidencia'
          }
        });
      }
    }

    // Verificar integridad usando el servicio
    const verificationResult = await custodyService.verifyCustodyChainIntegrity(evidenceId);

    res.json({
      success: true,
      data: verificationResult
    });

  } catch (error) {
    console.error('[CustodyController] Error verificando integridad:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al verificar integridad'
      }
    });
  }
};

// ============================================================================
// AGREGAR EVENTO MANUAL (Solo SUPER_ADMIN)
// ============================================================================

/**
 * POST /api/evidences/:id/custody/events
 * Agrega un evento manual a la cadena de custodia
 */
const addCustodyEvent = async (req, res) => {
  try {
    const { id } = req.params;
    const { eventType, description } = req.body;
    const evidenceId = parseInt(id);

    // Verificar que la evidencia existe
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId }
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

    // Validar tipo de evento
    const validEventTypes = [
      'ANNOTATION',
      'REVIEW',
      'TRANSFER',
      'LEGAL_ACTION',
      'OTHER'
    ];

    if (!validEventTypes.includes(eventType)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_EVENT_TYPE',
          message: `Tipo de evento invalido. Valores permitidos: ${validEventTypes.join(', ')}`
        }
      });
    }

    // Registrar evento (actorType='USER', details contiene la descripcion)
    const event = await custodyService.registerEvent(
      evidenceId,
      eventType,
      'USER',           // actorType
      req.user.id,      // actorUserId
      { description }   // details
    );

    // Registrar auditoria
    await createAuditLog(
      req.user.id,
      'CUSTODY_EVENT_ADD',
      'custody_events',
      event.id,
      { evidenceId, eventType, description },
      req.ip,
      req.get('User-Agent')
    );

    res.status(201).json({
      success: true,
      data: {
        id: event.id,
        eventType: event.eventType,
        details: event.details,
        eventAt: event.eventAt,
        eventHash: event.eventHash,
        message: 'Evento registrado en la cadena de custodia'
      }
    });

  } catch (error) {
    console.error('[CustodyController] Error agregando evento:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al agregar evento'
      }
    });
  }
};

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  getCustodyChain,
  exportCustodyChain,
  verifyCustodyIntegrity,
  addCustodyEvent
};
