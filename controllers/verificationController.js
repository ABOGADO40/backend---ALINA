// ============================================================================
// VERIFICATION CONTROLLER - Verificacion publica de hashes + forense
// Sistema PRUEBA DIGITAL
// ============================================================================

const { prisma } = require('../config/db');
const { createAuditLog } = require('../services/auditService');
const verificationService = require('../services/verificationService');

// ============================================================================
// VERIFICAR HASH
// ============================================================================

/**
 * GET /api/verify/:hash
 * Verifica un hash SHA-256 en el sistema (endpoint publico)
 */
const verifyByHash = async (req, res) => {
  try {
    const { hash } = req.params;

    // Validar formato de hash SHA-256
    if (!hash || !/^[a-fA-F0-9]{64}$/.test(hash)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_HASH',
          message: 'El hash debe ser SHA-256 (64 caracteres hexadecimales)'
        }
      });
    }

    const normalizedHash = hash.toLowerCase();

    // Buscar el hash en registros de archivos
    const hashRecord = await prisma.hashRecord.findFirst({
      where: {
        hashHex: normalizedHash
      },
      include: {
        evidenceFile: {
          include: {
            evidence: {
              include: {
                case: {
                  select: { id: true, title: true, internalCode: true }
                },
                owner: {
                  select: { email: true }
                }
              }
            }
          }
        }
      }
    });

    if (!hashRecord) {
      // Registrar intento de verificacion fallido (anonimo)
      await createAuditLog(
        null,
        'HASH_VERIFY_NOT_FOUND',
        'hash_records',
        null,
        { hash: normalizedHash },
        req.ip,
        req.get('User-Agent')
      );

      return res.status(404).json({
        success: false,
        verified: false,
        error: {
          code: 'HASH_NOT_FOUND',
          message: 'El hash proporcionado no existe en nuestro sistema'
        }
      });
    }

    const evidence = hashRecord.evidenceFile.evidence;

    // Verificar si la evidencia es publica
    if (!evidence.isPublic) {
      // Registrar intento de verificacion de hash privado
      await createAuditLog(
        null,
        'HASH_VERIFY_PRIVATE',
        'hash_records',
        hashRecord.id,
        { hash: normalizedHash, evidenceId: evidence.id },
        req.ip,
        req.get('User-Agent')
      );

      return res.json({
        success: true,
        verified: true,
        data: {
          found: true,
          isPublic: false,
          message: 'El hash existe en el sistema pero pertenece a una evidencia privada. Contacte al propietario para mas informacion.',
          registeredAt: hashRecord.computedAt,
          algorithm: hashRecord.algorithm,
          contact: {
            email: evidence.contact_email || null,
            phone: evidence.contact_phone || null
          }
        }
      });
    }

    // Registrar verificacion exitosa
    await createAuditLog(
      null,
      'HASH_VERIFY_SUCCESS',
      'hash_records',
      hashRecord.id,
      { hash: normalizedHash, evidenceId: evidence.id },
      req.ip,
      req.get('User-Agent')
    );

    // Respuesta completa para evidencia publica
    res.json({
      success: true,
      verified: true,
      data: {
        found: true,
        isPublic: true,
        evidence: {
          id: evidence.id,
          title: evidence.title,
          sourceType: evidence.sourceType,
          status: evidence.status,
          createdAt: evidence.createdAt
        },
        file: {
          role: hashRecord.evidenceFile.fileRole,
          originalFilename: hashRecord.evidenceFile.originalFilename,
          mimeType: hashRecord.evidenceFile.mimeType,
          sizeBytes: Number(hashRecord.evidenceFile.sizeBytes)
        },
        hash: {
          algorithm: hashRecord.algorithm,
          value: hashRecord.hashHex,
          registeredAt: hashRecord.computedAt
        },
        case: evidence.case ? {
          internalCode: evidence.case.internalCode
        } : null,
        contact: {
          email: evidence.owner?.email || null
        },
        message: 'El archivo fue registrado en nuestro sistema y su integridad esta verificada'
      }
    });

  } catch (error) {
    console.error('[VerificationController] Error verificando hash:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al verificar hash'
      }
    });
  }
};

// ============================================================================
// VERIFICAR MULTIPLES HASHES
// ============================================================================

/**
 * POST /api/verify/batch
 * Verifica multiples hashes a la vez (endpoint publico)
 */
const verifyBatch = async (req, res) => {
  try {
    const { hashes } = req.body;

    if (!hashes || !Array.isArray(hashes)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'HASHES_REQUIRED',
          message: 'Se requiere un array de hashes'
        }
      });
    }

    if (hashes.length > 50) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'TOO_MANY_HASHES',
          message: 'Maximo 50 hashes por solicitud'
        }
      });
    }

    // Validar y normalizar hashes
    const validHashes = [];
    const invalidHashes = [];

    for (const hash of hashes) {
      if (/^[a-fA-F0-9]{64}$/.test(hash)) {
        validHashes.push(hash.toLowerCase());
      } else {
        invalidHashes.push(hash);
      }
    }

    if (validHashes.length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'NO_VALID_HASHES',
          message: 'Ninguno de los hashes proporcionados es valido'
        }
      });
    }

    // Buscar todos los hashes
    const hashRecords = await prisma.hashRecord.findMany({
      where: {
        hashHex: { in: validHashes }
      },
      include: {
        evidenceFile: {
          include: {
            evidence: {
              select: {
                id: true,
                title: true,
                sourceType: true,
                isPublic: true,
                createdAt: true,
                contact_email: true,
                contact_phone: true
              }
            }
          }
        }
      }
    });

    // Crear mapa de resultados
    const foundHashMap = new Map(
      hashRecords.map(hr => [hr.hashHex, hr])
    );

    // Construir resultados
    const results = validHashes.map(hash => {
      const record = foundHashMap.get(hash);

      if (!record) {
        return {
          hash,
          found: false,
          verified: false
        };
      }

      const evidence = record.evidenceFile.evidence;

      if (!evidence.isPublic) {
        return {
          hash,
          found: true,
          verified: true,
          isPublic: false,
          registeredAt: record.computedAt,
          contact: {
            email: evidence.contact_email || null,
            phone: evidence.contact_phone || null
          }
        };
      }

      return {
        hash,
        found: true,
        verified: true,
        isPublic: true,
        evidence: {
          id: evidence.id,
          title: evidence.title,
          sourceType: evidence.sourceType,
          createdAt: evidence.createdAt
        },
        file: {
          role: record.evidenceFile.fileRole,
          originalFilename: record.evidenceFile.originalFilename
        },
        registeredAt: record.computedAt
      };
    });

    // Registrar auditoria
    await createAuditLog(
      null,
      'HASH_VERIFY_BATCH',
      'hash_records',
      null,
      {
        totalRequested: hashes.length,
        validHashes: validHashes.length,
        found: hashRecords.length
      },
      req.ip,
      req.get('User-Agent')
    );

    res.json({
      success: true,
      data: {
        results,
        summary: {
          total: validHashes.length,
          found: hashRecords.length,
          notFound: validHashes.length - hashRecords.length,
          invalid: invalidHashes.length
        },
        invalidHashes: invalidHashes.length > 0 ? invalidHashes : undefined
      }
    });

  } catch (error) {
    console.error('[VerificationController] Error en verificacion batch:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al verificar hashes'
      }
    });
  }
};

// ============================================================================
// OBTENER CADENA DE CUSTODIA PUBLICA
// ============================================================================

/**
 * GET /api/verify/:hash/custody
 * Obtiene la cadena de custodia de una evidencia publica por hash
 */
const getCustodyByHash = async (req, res) => {
  try {
    const { hash } = req.params;

    // Validar formato
    if (!hash || !/^[a-fA-F0-9]{64}$/.test(hash)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_HASH',
          message: 'Hash invalido'
        }
      });
    }

    const normalizedHash = hash.toLowerCase();

    // Buscar evidencia por hash
    const hashRecord = await prisma.hashRecord.findFirst({
      where: { hashHex: normalizedHash },
      include: {
        evidenceFile: {
          include: {
            evidence: {
              include: {
                custodyEvents: {
                  orderBy: { eventTime: 'asc' }
                }
              }
            }
          }
        }
      }
    });

    if (!hashRecord) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'HASH_NOT_FOUND',
          message: 'Hash no encontrado'
        }
      });
    }

    const evidence = hashRecord.evidenceFile.evidence;

    // Verificar que sea publica
    if (!evidence.isPublic) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'EVIDENCE_PRIVATE',
          message: 'La cadena de custodia solo esta disponible para evidencias publicas'
        }
      });
    }

    // Formatear eventos (sin datos sensibles)
    const custodyChain = evidence.custodyEvents.map(event => ({
      eventType: event.eventType,
      description: event.description,
      eventTime: event.eventTime,
      eventHash: event.eventHash
    }));

    // Verificar integridad de la cadena
    let integrityValid = true;
    let previousHash = null;

    for (const event of evidence.custodyEvents) {
      if (previousHash && event.previousHash !== previousHash) {
        integrityValid = false;
        break;
      }
      previousHash = event.eventHash;
    }

    res.json({
      success: true,
      data: {
        evidenceId: evidence.id,
        evidenceTitle: evidence.title,
        custodyChain,
        totalEvents: custodyChain.length,
        chainIntegrity: integrityValid ? 'VERIFIED' : 'BROKEN'
      }
    });

  } catch (error) {
    console.error('[VerificationController] Error obteniendo custodia:', error);
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
// VERIFICACION FORENSE COMPLETA (ADMIN)
// ============================================================================

/**
 * POST /api/verify/forensic/:uuid
 * Verificacion forense completa de cadena de custodia (endpoint protegido)
 * Solo accesible para SUPER_ADMIN
 */
const verifyChainForensic = async (req, res) => {
  try {
    const { uuid } = req.params;

    // Validar UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid || !uuidRegex.test(uuid)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_UUID',
          message: 'UUID de evidencia invalido'
        }
      });
    }

    console.log(`[VerificationController] Iniciando verificacion forense para ${uuid}`);

    // Ejecutar verificacion forense completa
    const result = await verificationService.verifyChain(uuid);

    // Registrar auditoria
    await createAuditLog(
      req.user.id,
      'FORENSIC_VERIFICATION',
      'evidence',
      result.evidenceId || null,
      {
        evidenceUuid: uuid,
        valid: result.valid,
        passedChecks: result.summary.passedChecks,
        failedChecks: result.summary.failedChecks
      },
      req.ip,
      req.get('User-Agent')
    );

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('[VerificationController] Error en verificacion forense:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al verificar cadena de custodia'
      }
    });
  }
};

/**
 * GET /api/verify/forensic/:uuid/status
 * Obtener estado rapido de integridad (endpoint protegido)
 */
const getIntegrityStatus = async (req, res) => {
  try {
    const { uuid } = req.params;

    // Buscar evidencia por UUID
    const evidence = await prisma.evidence.findUnique({
      where: { uuid },
      select: { id: true }
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

    const status = await verificationService.getIntegrityStatus(evidence.id);

    res.json({
      success: true,
      data: status
    });

  } catch (error) {
    console.error('[VerificationController] Error obteniendo estado:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al obtener estado de integridad'
      }
    });
  }
};

/**
 * POST /api/verify/package/:uuid
 * Verificacion de paquete de evidencia completo (checklist L)
 * Retorna PASS/FAIL con primer motivo de falla
 */
const verifyEvidencePackage = async (req, res) => {
  try {
    const { uuid } = req.params;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid || !uuidRegex.test(uuid)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_UUID',
          message: 'UUID de evidencia invalido'
        }
      });
    }

    console.log(`[VerificationController] verifyEvidencePackage para ${uuid}`);

    // Ejecutar verificacion segun checklist L
    const result = await verificationService.verifyEvidencePackage(uuid);

    // Registrar auditoria
    await createAuditLog(
      req.user?.id || null,
      'VERIFY_EVIDENCE_PACKAGE',
      'evidence',
      null,
      {
        evidenceUuid: uuid,
        result: result.result,
        firstFailureReason: result.firstFailureReason
      },
      req.ip,
      req.get('User-Agent')
    );

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('[VerificationController] Error en verifyEvidencePackage:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al verificar paquete de evidencia'
      }
    });
  }
};

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  verifyByHash,
  verifyBatch,
  getCustodyByHash,
  verifyChainForensic,
  getIntegrityStatus,
  verifyEvidencePackage
};
