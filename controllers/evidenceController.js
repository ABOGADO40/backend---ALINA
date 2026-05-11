// ============================================================================
// EVIDENCE CONTROLLER - Gestion de evidencias digitales
// Sistema PRUEBA DIGITAL
// ============================================================================

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { prisma } = require('../config/db');
const { createAuditLog } = require('../services/auditService');
const storageService = require('../services/storageService');
const { getMimeCategory, generateStorageKeyByHash, STORAGE_STRUCTURE } = require('../config/storage');
const pipelineService = require('../services/pipelineService');
const custodyService = require('../services/custodyService');
const actaService = require('../services/actaService');
const googleDriveService = require('../services/googleDriveService');

// ============================================================================
// LISTAR EVIDENCIAS
// ============================================================================

/**
 * GET /api/evidences
 * Lista evidencias con filtros
 */
const listEvidences = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      caseId,
      status,
      sourceType,
      search
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    // Construir filtros con AND para combinar condiciones sin conflicto
    const where = {};
    const andConditions = [];

    // Filtrar por caso si se especifica
    if (caseId) {
      where.caseId = parseInt(caseId);
    }

    // Si no es SUPER_ADMIN, solo ver evidencias propias (subidas por el usuario)
    // o evidencias de casos que le pertenecen
    if (!req.user.roles.includes('SUPER_ADMIN')) {
      andConditions.push({
        OR: [
          { ownerUserId: req.user.id },
          { case: { ownerUserId: req.user.id } }
        ]
      });
    }

    if (status) {
      where.status = status;
    }

    if (sourceType) {
      where.sourceType = sourceType;
    }

    if (search) {
      andConditions.push({
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } }
        ]
      });
    }

    if (andConditions.length > 0) {
      where.AND = andConditions;
    }

    // Ejecutar consultas
    const [evidences, total] = await Promise.all([
      prisma.evidence.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
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
        }
      }),
      prisma.evidence.count({ where })
    ]);

    // Formatear respuesta (convertir BigInt a Number para JSON serialization)
    const formattedEvidences = evidences.map(e => ({
      id: e.id,
      title: e.title,
      description: e.description,
      sourceType: e.sourceType,
      status: e.status,
      isPublic: e.isPublic,
      caseId: e.case?.id || null,
      caseName: e.case?.title || null,
      originalFile: e.files[0] ? {
        id: e.files[0].id,
        filename: e.files[0].originalFilename,
        mimeType: e.files[0].mimeType,
        size: Number(e.files[0].sizeBytes)
      } : null,
      createdAt: e.createdAt
    }));

    res.json({
      success: true,
      data: {
        evidences: formattedEvidences,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / take)
        }
      }
    });

  } catch (error) {
    console.error('[EvidenceController] Error listando evidencias:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al listar evidencias'
      }
    });
  }
};

// ============================================================================
// OBTENER EVIDENCIA POR ID
// ============================================================================

/**
 * GET /api/evidences/:id
 * Obtiene detalle completo de una evidencia
 */
const getEvidenceById = async (req, res) => {
  try {
    const { id } = req.params;

    const evidence = await prisma.evidence.findUnique({
      where: { id: parseInt(id) },
      include: {
        case: {
          select: { id: true, title: true, ownerUserId: true }
        },
        files: {
          orderBy: { version: 'desc' },
          include: {
            hashRecords: {
              orderBy: { computedAt: 'desc' },
              take: 1
            }
          }
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
          orderBy: { eventAt: 'asc' },
          take: 10
        }
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
      // Si es publica, permitir acceso limitado
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

    // Formatear archivos
    const formattedFiles = evidence.files.map(f => ({
      id: f.id,
      fileRole: f.fileRole,
      originalFilename: f.originalFilename,
      mimeType: f.mimeType,
      sizeBytes: Number(f.sizeBytes),
      version: f.version,
      hash: f.hashRecords[0] ? {
        algorithm: f.hashRecords[0].algorithm,
        hashHex: f.hashRecords[0].hashHex,
        computedAt: f.hashRecords[0].computedAt
      } : null,
      createdAt: f.createdAt
    }));

    res.json({
      success: true,
      data: {
        id: evidence.id,
        title: evidence.title,
        description: evidence.description,
        sourceType: evidence.sourceType,
        status: evidence.status,
        isPublic: evidence.isPublic,
        contactEmail: evidence.contact_email || null,
        contactPhone: evidence.contact_phone || null,
        case: evidence.case,
        files: formattedFiles,
        metadata: evidence.metadataReports[0]?.reportJson || null,
        riskAnalysis: evidence.riskReports[0] ? {
          rulesTriggered: evidence.riskReports[0].rulesTriggered,
          summary: evidence.riskReports[0].summary,
          createdAt: evidence.riskReports[0].createdAt
        } : null,
        recentCustodyEvents: evidence.custodyEvents,
        createdAt: evidence.createdAt
      }
    });

  } catch (error) {
    console.error('[EvidenceController] Error obteniendo evidencia:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al obtener evidencia'
      }
    });
  }
};

// ============================================================================
// SUBIR EVIDENCIA
// ============================================================================

/**
 * POST /api/evidences/upload
 * Sube una nueva evidencia y dispara el pipeline
 * Incluye datos opcionales del aportante para generar Acta automaticamente
 */
const uploadEvidence = async (req, res) => {
  try {
    const { caseId, title, description } = req.body;
    const file = req.file;

    // Datos del aportante (OBLIGATORIOS)
    const contributorData = {
      actaLugar: req.body.actaLugar,
      actaEntidadInterviniente: req.body.actaEntidadInterviniente,
      usuarioEntidad: req.body.usuarioEntidad || null,
      aportanteNombreCompleto: req.body.aportanteNombreCompleto,
      aportanteDocumentoTipo: req.body.aportanteDocumentoTipo || 'DNI',
      aportanteDocumentoNumero: req.body.aportanteDocumentoNumero,
      aportanteCondicion: req.body.aportanteCondicion,
      aportanteCondicionOtro: req.body.aportanteCondicionOtro || null,
      aportanteDomicilio: req.body.aportanteDomicilio || null,
      aportanteTelefono: req.body.aportanteTelefono || null,
      aportanteCorreo: req.body.aportanteCorreo || null,
      dispositivoOrigen: req.body.dispositivoOrigen || null,
      fechaObtencionArchivo: req.body.fechaObtencionArchivo || null
    };

    if (!file) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'FILE_REQUIRED',
          message: 'Se requiere un archivo'
        }
      });
    }

    // Verificar caso solo si se proporciona caseId (es opcional)
    let caseRecord = null;
    const parsedCaseId = caseId ? parseInt(caseId) : null;

    if (parsedCaseId) {
      caseRecord = await prisma.case.findUnique({
        where: { id: parsedCaseId }
      });

      if (!caseRecord) {
        // Limpiar archivo temporal
        await fs.promises.unlink(file.path);
        return res.status(404).json({
          success: false,
          error: {
            code: 'CASE_NOT_FOUND',
            message: 'Caso no encontrado'
          }
        });
      }

      // Verificar acceso al caso
      if (!req.user.roles.includes('SUPER_ADMIN') && caseRecord.ownerUserId !== req.user.id) {
        await fs.promises.unlink(file.path);
        return res.status(403).json({
          success: false,
          error: {
            code: 'ACCESS_DENIED',
            message: 'No tiene acceso a este caso'
          }
        });
      }
    }

    // =====================================================================
    // FLUJO IDEMPOTENTE: hash -> dedupe -> S3 -> BD
    //
    // Garantias:
    //  - Si Railway mata el proceso ANTES de S3: solo se borra el archivo /tmp (no hay BD)
    //  - Si Railway mata el proceso DURANTE S3: archivo S3 incompleto, pero NO hay BD huerfana
    //  - Si Railway mata el proceso DESPUES de S3 pero ANTES de BD: archivo S3 huerfano (cleanup lo eliminara)
    //  - Si Railway mata el proceso DESPUES de BD: pipeline reintentara y procesara
    //  - Reintento del cliente con mismo archivo: idempotencia por SHA-256 devuelve la evidencia existente
    // =====================================================================

    const crypto = require('crypto');

    // PASO 1: Calcular SHA-256 + tamano del archivo en /tmp (sin tocar BD ni S3 aun)
    const { fileHash, bytesRead } = await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      let totalBytes = 0;
      const stream = fs.createReadStream(file.path, { highWaterMark: 16 * 1024 * 1024 });
      stream.on('data', chunk => {
        hash.update(chunk);
        totalBytes += chunk.length;
      });
      stream.on('end', () => resolve({ fileHash: hash.digest('hex'), bytesRead: totalBytes }));
      stream.on('error', reject);
    });
    const sha256CalculatedAtUtc = new Date().toISOString();

    // PASO 2: Validacion forense - archivo no puede estar vacio
    if (bytesRead === 0) {
      await fs.promises.unlink(file.path).catch(() => {});
      return res.status(422).json({
        success: false,
        error: {
          code: 'EMPTY_FILE',
          message: 'Archivo vacio o lectura invalida. No se puede procesar evidencia con 0 bytes.',
          canRetry: true
        }
      });
    }

    // PASO 3: IDEMPOTENCIA - Si este owner ya subio el mismo archivo (mismo hash) en estado
    // procesable (no ERROR), devolvemos esa evidencia y descartamos esta carga.
    const existingByHash = await prisma.hashRecord.findFirst({
      where: {
        hashHex: fileHash,
        evidenceFile: {
          fileRole: 'ORIGINAL',
          evidence: {
            ownerUserId: req.user.id,
            status: { not: 'ERROR' }
          }
        }
      },
      include: {
        evidenceFile: {
          include: { evidence: { select: { id: true, title: true, status: true } } }
        }
      }
    });

    if (existingByHash && existingByHash.evidenceFile?.evidence) {
      const existingEvidence = existingByHash.evidenceFile.evidence;
      console.log(`[EvidenceController] Carga idempotente: hash ${fileHash.substring(0, 16)}... ya existe como evidencia ${existingEvidence.id}`);
      await fs.promises.unlink(file.path).catch(() => {});
      return res.status(200).json({
        success: true,
        data: {
          id: existingEvidence.id,
          title: existingEvidence.title,
          status: existingEvidence.status,
          isDuplicate: true,
          message: 'Esta evidencia ya fue subida previamente. Se muestra la existente.'
        }
      });
    }

    // PASO 4: Subir a Wasabi con storageKey determinista por hash.
    // Si Railway mata el proceso aqui, NO queda BD huerfana.
    const predeterminedStorageKey = generateStorageKeyByHash(
      STORAGE_STRUCTURE.ORIGINAL,
      fileHash,
      req.user.id,
      file.originalname
    );

    // PRE-CHECK: si el archivo ya existe en S3 (carga paralela o reintento del cliente),
    // reusamos el archivo existente sin sobreescribirlo (evita romper el cifrado AES-GCM).
    let stored;
    const alreadyInStorage = await storageService.getFileInfo(predeterminedStorageKey);
    if (alreadyInStorage.exists) {
      console.log(`[EvidenceController] Archivo ya existe en S3 con key ${predeterminedStorageKey}, reusando.`);
      stored = {
        storageKey: predeterminedStorageKey,
        sizeBytes: alreadyInStorage.sizeBytes,
        hash: fileHash,
        isEncrypted: alreadyInStorage.encrypted
      };
      // Limpiar el archivo temporal local
      await fs.promises.unlink(file.path).catch(() => {});
    } else {
      try {
        stored = await storageService.storeOriginal(
          file.path,
          null, // evidenceId no se usa cuando se pasa options.storageKey
          file.originalname,
          req.detectedMimeType || file.mimetype,
          { storageKey: predeterminedStorageKey }
        );
      } catch (storageError) {
        console.error('[EvidenceController] Error almacenando archivo en S3:', storageError);
        // No hay BD que limpiar (aun no se creo). storeOriginal ya elimina el tmp en su catch.
        return res.status(500).json({
          success: false,
          error: {
            code: 'STORAGE_ERROR',
            message: 'Error al almacenar el archivo. Por favor, intente nuevamente.',
            details: storageError.message,
            canRetry: true
          }
        });
      }
    }

    // Validacion de integridad: el hash calculado durante la subida debe coincidir con el pre-calculado
    if (stored.hash !== fileHash) {
      console.error(`[EvidenceController] Hash mismatch: pre=${fileHash.substring(0, 16)}, post=${stored.hash.substring(0, 16)}`);
      await storageService.deleteFile(stored.storageKey).catch(() => {});
      return res.status(500).json({
        success: false,
        error: {
          code: 'HASH_MISMATCH',
          message: 'Inconsistencia detectada al subir el archivo. Por favor, intente nuevamente.',
          canRetry: true
        }
      });
    }

    // PASO 5: Crear evidencia + evidenceFile + hashRecord en transaccion atomica
    // CON storageKey DEFINITIVO (sin estado "pending/...")
    let evidence, evidenceFile;
    try {
      const txResult = await prisma.$transaction(async (tx) => {
        // Re-chequear idempotencia DENTRO de la transaccion para cubrir condiciones de carrera
        const raceCheck = await tx.hashRecord.findFirst({
          where: {
            hashHex: fileHash,
            evidenceFile: {
              fileRole: 'ORIGINAL',
              evidence: {
                ownerUserId: req.user.id,
                status: { not: 'ERROR' }
              }
            }
          },
          include: { evidenceFile: { include: { evidence: true } } }
        });
        if (raceCheck && raceCheck.evidenceFile?.evidence) {
          // Otro request paralelo creo la evidencia primero. Devolvemos la existente.
          return { evidence: raceCheck.evidenceFile.evidence, evidenceFile: raceCheck.evidenceFile, raced: true };
        }

        const newEvidence = await tx.evidence.create({
          data: {
            ownerUserId: req.user.id,
            caseId: parsedCaseId,
            title: title || file.originalname,
            description: description || null,
            sourceType: req.sourceType || 'OTHER',
            status: 'RECEIVED',
            isPublic: true,
            userIdRegistration: req.user.id
          }
        });

        const newFile = await tx.evidenceFile.create({
          data: {
            evidenceId: newEvidence.id,
            fileRole: 'ORIGINAL',
            storageKey: stored.storageKey, // DEFINITIVO desde el inicio
            originalFilename: file.originalname,
            mimeType: req.detectedMimeType || file.mimetype,
            sizeBytes: stored.sizeBytes,
            isEncrypted: stored.isEncrypted,
            version: 1,
            userIdRegistration: req.user.id
          }
        });

        // Persistir hash record desde aqui (el pipeline lo detectara y saltara la etapa Hash)
        await tx.hashRecord.create({
          data: {
            evidenceFileId: newFile.id,
            algorithm: 'SHA256',
            hashHex: fileHash,
            userIdRegistration: req.user.id
          }
        });

        return { evidence: newEvidence, evidenceFile: newFile, raced: false };
      });

      // Si hubo race condition, devolver la evidencia existente y limpiar el S3 que acabamos de subir
      if (txResult.raced) {
        console.log(`[EvidenceController] Race condition detectada: evidencia ya existia. Limpiando S3 redundante.`);
        // El storageKey predeterminado por hash es identico al ya existente, asi que NO eliminamos:
        // si lo eliminamos podriamos romper la evidencia previa que apunta a la misma key.
        // El cifrado nuevo sobreescribio el iv/authTag, lo cual SI puede romper la primera.
        // Para ser seguros, no hacer cleanup aqui; el archivo S3 quedo en estado consistente con la transaccion ganadora.
        return res.status(200).json({
          success: true,
          data: {
            id: txResult.evidence.id,
            title: txResult.evidence.title,
            status: txResult.evidence.status,
            isDuplicate: true,
            message: 'Esta evidencia ya fue subida en paralelo. Se muestra la existente.'
          }
        });
      }

      evidence = txResult.evidence;
      evidenceFile = txResult.evidenceFile;
    } catch (dbError) {
      console.error('[EvidenceController] Error creando registros en BD:', dbError);
      // Cleanup: eliminar archivo recien subido a S3 ya que no quedo BD asociada
      await storageService.deleteFile(stored.storageKey).catch(e =>
        console.error('[EvidenceController] Error limpiando S3 tras fallo BD:', e.message)
      );
      return res.status(500).json({
        success: false,
        error: {
          code: 'DATABASE_ERROR',
          message: 'Error al registrar la evidencia. Por favor, intente nuevamente.',
          details: dbError.message,
          canRetry: true
        }
      });
    }

    // Fecha de modificacion del archivo segun el filesystem del cliente (enviada por el frontend)
    // Es la unica fuente de verdad disponible: HTTP multipart NO transmite timestamps del FS original
    let fileLastModifiedIso = null;
    if (req.body.fileLastModifiedIso) {
      const parsed = new Date(req.body.fileLastModifiedIso);
      if (!Number.isNaN(parsed.getTime())) {
        fileLastModifiedIso = parsed.toISOString();
      }
    } else if (req.body.fileLastModified) {
      const ms = parseInt(req.body.fileLastModified, 10);
      if (!Number.isNaN(ms)) {
        fileLastModifiedIso = new Date(ms).toISOString();
      }
    }

    // Registrar evento de custodia inicial (Cambio 4: SHA-256 desde el primer evento)
    // Usar stored.sizeBytes que es el tamano real del archivo procesado
    await custodyService.registerUpload(
      evidence.id,
      req.user.id,
      {
        sizeBytes: stored.sizeBytes,  // Tamano REAL del archivo (correccion forense)
        filename: file.originalname,
        originalFilename: file.originalname,
        mimeType: req.detectedMimeType || file.mimetype,
        mimeDetected: req.detectedMimeType || file.mimetype,
        bytesReadMethod: 'stream-full-file',
        storageObjectId: stored.storageKey,
        evidenceSha256: fileHash,
        sha256CalculatedAtUtc,
        clientFileLastModifiedIso: fileLastModifiedIso,
        description: `Archivo original subido: ${file.originalname}`
      }
    );

    // Registrar auditoria
    await createAuditLog(
      req.user.id,
      'EVIDENCE_UPLOAD',
      'evidences',
      evidence.id,
      { title, caseId, filename: file.originalname },
      req.ip,
      req.get('User-Agent')
    );

    // Crear registro de aportante y generar acta (OBLIGATORIO)
    let actaGenerada = null;
    try {
      console.log(`[EvidenceController] Creando registro de aportante para evidencia ${evidence.id}...`);

      // Crear registro de aportante
      const contributorRecord = await actaService.createContributorRecord(
        evidence.id,
        contributorData,
        req.user.id
      );

      console.log(`[EvidenceController] Registro de aportante creado: ${contributorRecord.id}`);

      // Generar acta PDF inmediatamente
      const actaResult = await actaService.generateActaPdf(
        evidence.id,
        contributorRecord.id,
        req.user.id
      );

      actaGenerada = {
        id: actaResult.id,
        actaNumero: actaResult.actaNumero,
        actaUuid: actaResult.actaUuid
      };

      console.log(`[EvidenceController] Acta generada: ${actaResult.actaNumero}`);

      // Registrar auditoria de creacion de acta
      await createAuditLog(
        req.user.id,
        'ACTA_GENERATED_ON_UPLOAD',
        'generated_actas',
        actaResult.id,
        {
          evidenceId: evidence.id,
          actaNumero: actaResult.actaNumero,
          aportanteNombre: contributorData.aportanteNombreCompleto
        },
        req.ip,
        req.get('User-Agent')
      );

    } catch (actaError) {
      console.error(`[EvidenceController] Error creando acta para evidencia ${evidence.id}:`, actaError.message);
      // No fallar el upload por error en acta, solo loguear
    }

    // Disparar pipeline de procesamiento (asincrono)
    console.log(`[EvidenceController] Disparando pipeline para evidencia ${evidence.id}...`);
    pipelineService.processEvidence(evidence.id)
      .then(result => {
        console.log(`[EvidenceController] Pipeline COMPLETADO para evidencia ${evidence.id}:`, result.finalStatus);
      })
      .catch(err => {
        console.error(`[EvidenceController] ERROR en pipeline para evidencia ${evidence.id}:`, err.message);
      });

    res.status(201).json({
      success: true,
      data: {
        id: evidence.id,
        title: evidence.title,
        status: evidence.status,
        message: 'Evidencia subida y acta generada. El procesamiento ha iniciado.',
        warning: req.fileWarning || null,
        acta: actaGenerada
      }
    });

  } catch (error) {
    console.error('[EvidenceController] Error subiendo evidencia:', error);

    // Limpiar archivo temporal si existe
    if (req.file && req.file.path) {
      try {
        await fs.promises.unlink(req.file.path);
      } catch (e) {
        // Ignorar error de limpieza
      }
    }

    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al subir evidencia'
      }
    });
  }
};

// ============================================================================
// DESCARGAR ARCHIVO DE EVIDENCIA
// ============================================================================

/**
 * GET /api/evidences/:id/download/:fileRole
 * Descarga un archivo especifico de la evidencia
 */
const downloadFile = async (req, res) => {
  try {
    const { id, fileRole } = req.params;

    const evidence = await prisma.evidence.findUnique({
      where: { id: parseInt(id) },
      include: {
        case: { select: { ownerUserId: true } },
        files: {
          where: { fileRole: fileRole.toUpperCase() },
          orderBy: { version: 'desc' },
          take: 1
        }
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
    const caseOwnerIdDl = evidence.case?.ownerUserId;
    const evidenceOwnerIdDl = evidence.ownerUserId;
    const isOwnerDl = caseOwnerIdDl === req.user.id || evidenceOwnerIdDl === req.user.id;

    if (!req.user.roles.includes('SUPER_ADMIN') && !isOwnerDl) {
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

    const file = evidence.files[0];
    if (!file) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'FILE_NOT_FOUND',
          message: `Archivo ${fileRole} no encontrado`
        }
      });
    }

    // Registrar descarga - en AuditLog (la cadena de custodia puede estar sellada)
    // Las descargas post-sellado se registran en audit_log, no en custody_events
    await createAuditLog(
      req.user.id,
      'EVIDENCE_DOWNLOAD',
      'evidence_files',
      file.id,
      {
        evidenceId: evidence.id,
        fileRole: fileRole.toUpperCase(),
        filename: file.originalFilename,
        description: `Archivo ${fileRole.toUpperCase()} descargado`
      },
      req.ip,
      req.get('User-Agent')
    );

    // Obtener stream
    const stream = await storageService.getFileStream(file.storageKey, file.isEncrypted);

    // Configurar headers de descarga
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.originalFilename}"`);
    res.setHeader('Content-Length', Number(file.sizeBytes));

    // Pipe stream
    stream.pipe(res);

  } catch (error) {
    console.error('[EvidenceController] Error descargando archivo:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al descargar archivo'
      }
    });
  }
};

// ============================================================================
// TOGGLE PUBLICO
// ============================================================================

/**
 * PATCH /api/evidences/:id/toggle-public
 * Cambia el estado publico de una evidencia
 */
const togglePublic = async (req, res) => {
  try {
    const { id } = req.params;
    const { contactEmail, contactPhone } = req.body || {};

    const evidence = await prisma.evidence.findUnique({
      where: { id: parseInt(id) },
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

    // Verificar acceso: dueño de la evidencia o SUPER_ADMIN
    const caseOwnerIdTp = evidence.case?.ownerUserId;
    const evidenceOwnerIdTp = evidence.ownerUserId;
    const isOwnerTp = caseOwnerIdTp === req.user.id || evidenceOwnerIdTp === req.user.id;

    if (!req.user.roles.includes('SUPER_ADMIN') && !isOwnerTp) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'ACCESS_DENIED',
          message: 'No tiene acceso a esta evidencia'
        }
      });
    }

    const newIsPublic = !evidence.isPublic;

    // Si se va a hacer PRIVADA, validar que se proporcione al menos un dato de contacto
    if (!newIsPublic) {
      const hasEmail = contactEmail && contactEmail.trim().length > 0;
      const hasPhone = contactPhone && contactPhone.trim().length > 0;

      if (!hasEmail && !hasPhone) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'CONTACT_REQUIRED',
            message: 'Para hacer la evidencia privada debe proporcionar al menos un dato de contacto (correo o telefono)'
          }
        });
      }

      // Validar formato de email si se proporciona
      if (hasEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.trim())) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_EMAIL',
            message: 'El correo electronico proporcionado no es valido'
          }
        });
      }
    }

    // Preparar datos de actualizacion
    const updateData = {
      isPublic: newIsPublic,
      userIdModification: req.user.id
    };

    if (!newIsPublic) {
      // Haciendo privada: guardar datos de contacto
      updateData.contact_email = contactEmail ? contactEmail.trim() : null;
      updateData.contact_phone = contactPhone ? contactPhone.trim() : null;
    } else {
      // Haciendo publica: limpiar datos de contacto
      updateData.contact_email = null;
      updateData.contact_phone = null;
    }

    await prisma.evidence.update({
      where: { id: parseInt(id) },
      data: updateData
    });

    // Registrar evento de custodia (puede fallar si la cadena esta sellada)
    try {
      await custodyService.registerEvent(
        evidence.id,
        'VISIBILITY_CHANGE',
        'USER',
        req.user.id,
        {
          isPublic: newIsPublic,
          description: `Visibilidad cambiada a ${newIsPublic ? 'publica' : 'privada'}`
        }
      );
    } catch (custodyError) {
      // Si la cadena esta sellada, el cambio de visibilidad es administrativo
      // y se registra solo en audit_log (igual que descargas y exportaciones post-sellado)
      console.log(`[EvidenceController] Custodia sellada, visibilidad registrada solo en audit_log: ${custodyError.message}`);
    }

    // Registrar auditoria
    await createAuditLog(
      req.user.id,
      'EVIDENCE_TOGGLE_PUBLIC',
      'evidences',
      evidence.id,
      { isPublic: newIsPublic },
      req.ip,
      req.get('User-Agent')
    );

    res.json({
      success: true,
      data: {
        id: evidence.id,
        isPublic: newIsPublic,
        message: `Evidencia ahora es ${newIsPublic ? 'publica' : 'privada'}`
      }
    });

  } catch (error) {
    console.error('[EvidenceController] Error cambiando visibilidad:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al cambiar visibilidad'
      }
    });
  }
};

// ============================================================================
// REGENERAR PROCESAMIENTO
// ============================================================================

/**
 * POST /api/evidences/:id/regenerate
 * Regenera el procesamiento de una evidencia
 */
const regenerate = async (req, res) => {
  try {
    const { id } = req.params;

    const evidence = await prisma.evidence.findUnique({
      where: { id: parseInt(id) },
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
    const caseOwnerIdRg = evidence.case?.ownerUserId;
    const evidenceOwnerIdRg = evidence.ownerUserId;
    const isOwnerRg = caseOwnerIdRg === req.user.id || evidenceOwnerIdRg === req.user.id;

    if (!req.user.roles.includes('SUPER_ADMIN') && !isOwnerRg) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'ACCESS_DENIED',
          message: 'No tiene acceso a esta evidencia'
        }
      });
    }

    // Estados permitidos:
    // - Estados terminales (READY_FOR_EXPORT, EXPORTED, ERROR): regenerar siempre
    // - Estados activos (RECEIVED + intermedios): solo si lleva > 2 min sin actividad (atascada)
    const terminalStates = ['READY_FOR_EXPORT', 'EXPORTED', 'ERROR'];
    const activeStates = ['RECEIVED', 'SCANNED_OK', 'HASHED', 'CLONED_BITCOPY', 'SEALED', 'ANALYZED'];
    const isTerminal = terminalStates.includes(evidence.status);
    const isActive = activeStates.includes(evidence.status);

    if (!isTerminal && !isActive) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STATE',
          message: `Estado no soportado para regeneracion: ${evidence.status}`
        }
      });
    }

    // Si esta en estado activo, exigir periodo de gracia para evitar pisar pipeline en curso
    if (isActive) {
      const lastActivity = evidence.dateTimeModification || evidence.createdAt;
      const minutesSinceActivity = (Date.now() - new Date(lastActivity).getTime()) / 60000;
      if (minutesSinceActivity < 2) {
        return res.status(409).json({
          success: false,
          error: {
            code: 'PIPELINE_ACTIVE',
            message: `La evidencia esta siendo procesada (ultima actividad hace ${minutesSinceActivity.toFixed(1)} min). Intente nuevamente en unos minutos.`
          }
        });
      }
    }

    // PRECHECK: verificar que el archivo original realmente existe en Wasabi.
    // Si no esta, regenerar es inutil - hay que volver a subirlo.
    const originalFileRecord = await prisma.evidenceFile.findFirst({
      where: { evidenceId: parseInt(id), fileRole: 'ORIGINAL' },
      orderBy: { version: 'desc' }
    });

    if (!originalFileRecord) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'NO_ORIGINAL_FILE',
          message: 'Esta evidencia no tiene archivo original registrado. Debe subirla nuevamente.'
        }
      });
    }

    if (String(originalFileRecord.storageKey || '').startsWith('pending/')) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'UPLOAD_INCOMPLETE',
          message: 'La subida original nunca se completo. El archivo no esta en almacenamiento. Por favor, suba la evidencia nuevamente desde cero.',
          recoverable: false,
          action: 'reupload'
        }
      });
    }

    try {
      const fileInfo = await storageService.getFileInfo(originalFileRecord.storageKey);
      if (!fileInfo.exists) {
        return res.status(409).json({
          success: false,
          error: {
            code: 'FILE_NOT_IN_STORAGE',
            message: 'El archivo original no se encuentra en almacenamiento. Pudo haberse perdido o la subida no completo. Por favor, suba la evidencia nuevamente.',
            recoverable: false,
            action: 'reupload'
          }
        });
      }
    } catch (storageErr) {
      console.warn(`[EvidenceController] Precheck storage fallo para evidencia ${id}: ${storageErr.message}`);
      // Si el check falla por error transitorio (red), permitimos seguir y dejar que el pipeline reintente
    }

    // Actualizar estado a RECEIVED para reprocesar
    await prisma.evidence.update({
      where: { id: parseInt(id) },
      data: {
        status: 'RECEIVED',
        userIdModification: req.user.id,
        dateTimeModification: new Date()
      }
    });

    // Registrar evento de custodia solo si estaba en estado terminal (cambio explicito de version)
    // Si estaba activo (atascada), no registramos evento adicional para no contaminar el log
    if (isTerminal) {
      try {
        await custodyService.registerEvent(
          evidence.id,
          'REGENERATE_VERSION',
          'USER',
          req.user.id,
          { description: 'Procesamiento regenerado por el usuario', previousStatus: evidence.status }
        );
      } catch (custodyErr) {
        console.warn(`[EvidenceController] No se pudo registrar evento REGENERATE_VERSION: ${custodyErr.message}`);
      }
    }

    // Disparar pipeline
    pipelineService.processEvidence(evidence.id).catch(err => {
      console.error(`[EvidenceController] Error en regeneracion de evidencia ${evidence.id}:`, err);
    });

    res.json({
      success: true,
      data: {
        id: evidence.id,
        status: 'RECEIVED',
        previousStatus: evidence.status,
        message: isActive
          ? 'Evidencia destrabada y reprocesamiento iniciado'
          : 'Regeneracion iniciada'
      }
    });

  } catch (error) {
    console.error('[EvidenceController] Error regenerando evidencia:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al regenerar evidencia'
      }
    });
  }
};

// ============================================================================
// ELIMINAR EVIDENCIA
// ============================================================================

/**
 * DELETE /api/evidences/:id
 * Elimina una evidencia (marca como inactiva, no borra archivos)
 */
const deleteEvidence = async (req, res) => {
  try {
    const { id } = req.params;

    const evidence = await prisma.evidence.findUnique({
      where: { id: parseInt(id) },
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

    // Verificar acceso (usar ownerUserId de Evidence si no hay caso)
    const ownerId = evidence.case?.ownerUserId || evidence.ownerUserId;
    if (!req.user.roles.includes('SUPER_ADMIN') && ownerId !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'ACCESS_DENIED',
          message: 'No tiene acceso a esta evidencia'
        }
      });
    }

    // Registrar evento de custodia ANTES de eliminar (FK constraint)
    await custodyService.registerEvent(
      evidence.id,
      'DELETE',
      'USER',
      req.user.id,
      { description: 'Evidencia eliminada por el usuario' }
    );

    // Hard delete de la evidencia
    await prisma.evidence.delete({
      where: { id: parseInt(id) }
    });

    // Registrar auditoria
    await createAuditLog(
      req.user.id,
      'EVIDENCE_DELETE',
      'evidences',
      evidence.id,
      { title: evidence.title },
      req.ip,
      req.get('User-Agent')
    );

    res.json({
      success: true,
      data: {
        message: 'Evidencia archivada correctamente'
      }
    });

  } catch (error) {
    console.error('[EvidenceController] Error eliminando evidencia:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al eliminar evidencia'
      }
    });
  }
};

// ============================================================================
// EXPORTAR METADATA
// ============================================================================

/**
 * GET /api/evidences/:id/metadata/export
 * Exporta la metadata de una evidencia en formato PDF
 */
const exportMetadata = async (req, res) => {
  try {
    const { id } = req.params;
    const evidenceId = parseInt(id);

    // Obtener evidencia con metadata
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      include: {
        case: { select: { ownerUserId: true, title: true } },
        metadataReports: {
          orderBy: { version: 'desc' },
          take: 1
        },
        files: {
          where: { fileRole: 'ORIGINAL' },
          take: 1,
          include: {
            hashRecords: {
              orderBy: { computedAt: 'desc' },
              take: 1
            }
          }
        }
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

    // Verificar que existe metadata
    if (!evidence.metadataReports[0]) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'METADATA_NOT_FOUND',
          message: 'No hay metadata disponible para esta evidencia'
        }
      });
    }

    const metadataReport = evidence.metadataReports[0];
    const metadata = metadataReport.reportJson;
    const originalFile = evidence.files[0] || null;

    // Aplanar propiedades de technical/device/fileInfo al nivel raiz para el reporte
    const flatMetadata = { ...metadata };
    if (metadata.technical) {
      const techMappings = {
        format: 'format', width: 'width', height: 'height',
        fechaCaptura: 'creationDate', software: 'software',
        espacioColor: 'colorSpace', zonaHoraria: 'timezone',
        density: 'density', pageCount: 'pageCount',
        title: 'title', author: 'author', creator: 'creator',
        producer: 'producer', subject: 'subject', keywords: 'keywords',
        creationDate: 'creationDate', modificationDate: 'modificationDate',
        pdfVersion: 'pdfVersion', duracion: 'duracion', codec: 'codec',
        sampleRate: 'sampleRate', canales: 'canales',
        gps: 'gps'
      };
      for (const [techKey, flatKey] of Object.entries(techMappings)) {
        const val = metadata.technical[techKey];
        if (val !== undefined && val !== null && val !== 'N/A' && val !== 'No proporcionada') {
          if (flatMetadata[flatKey] === undefined) {
            flatMetadata[flatKey] = val;
          }
        }
      }
    }
    if (metadata.device) {
      for (const [key, val] of Object.entries(metadata.device)) {
        if (val && val !== 'No proporcionada') {
          flatMetadata[`device_${key}`] = val;
        }
      }
    }
    if (metadata.fileInfo) {
      if (metadata.fileInfo.mimeType && !flatMetadata.mimeType) {
        flatMetadata.mimeType = metadata.fileInfo.mimeType;
      }
      if (metadata.fileInfo.sizeBytes && !flatMetadata.fileSize) {
        flatMetadata.fileSize = metadata.fileInfo.sizeBytes;
      }
    }

    // Generar PDF
    const pdfBytes = await generateMetadataPdf(flatMetadata, metadataReport.version, evidence, originalFile);

    // Registrar auditoria
    await createAuditLog(
      req.user.id,
      'METADATA_EXPORT',
      'metadata_reports',
      metadataReport.id,
      { evidenceId, version: metadataReport.version, format: 'PDF' },
      req.ip,
      req.get('User-Agent')
    );

    // Configurar headers para descarga PDF
    const filename = `metadata_evidencia_${evidenceId}_v${metadataReport.version}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBytes.length);

    res.send(Buffer.from(pdfBytes));

  } catch (error) {
    console.error('[EvidenceController] Error exportando metadata:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al exportar metadata'
      }
    });
  }
};

/**
 * Genera un PDF con la metadata de la evidencia
 */
async function generateMetadataPdf(metadata, version, evidence, originalFile) {
  const pdfDoc = await PDFDocument.create();
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Colores
  const darkBlue = rgb(0.1, 0.2, 0.4);
  const darkGray = rgb(0.3, 0.3, 0.3);
  const lightGray = rgb(0.6, 0.6, 0.6);

  // Primera pagina
  let page = pdfDoc.addPage([595, 842]); // A4
  const { width, height } = page.getSize();
  let y = height - 50;
  const marginLeft = 50;
  const contentWidth = width - 100;

  // Funcion para sanitizar texto (WinAnsi no soporta newlines ni algunos caracteres especiales)
  const sanitizeText = (text) => {
    if (text === null || text === undefined) return '';
    return String(text)
      .replace(/[\r\n\t]/g, ' ')  // Reemplazar newlines y tabs por espacios
      .replace(/\s+/g, ' ')        // Colapsar espacios multiples
      .replace(/[^\x20-\x7E\xA0-\xFF]/g, '') // Solo caracteres WinAnsi validos
      .trim();
  };

  // Funcion auxiliar para agregar texto con overflow
  const addText = (text, options = {}) => {
    const {
      font = helvetica,
      size = 10,
      color = darkGray,
      maxWidth = contentWidth,
      lineHeight = size * 1.4
    } = options;

    // Sanitizar y dividir texto largo en lineas
    const cleanText = sanitizeText(text);
    if (!cleanText) return y;

    const words = cleanText.split(' ');
    let line = '';
    const lines = [];

    for (const word of words) {
      if (!word) continue;
      const testLine = line + (line ? ' ' : '') + word;
      const testWidth = font.widthOfTextAtSize(testLine, size);

      if (testWidth > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = testLine;
      }
    }
    if (line) lines.push(line);

    for (const ln of lines) {
      if (y < 60) {
        page = pdfDoc.addPage([595, 842]);
        y = height - 50;
      }
      page.drawText(ln, { x: marginLeft, y, font, size, color });
      y -= lineHeight;
    }

    return y;
  };

  // Funcion para agregar nueva pagina si es necesario
  const checkPage = (neededSpace = 60) => {
    if (y < neededSpace) {
      page = pdfDoc.addPage([595, 842]);
      y = height - 50;
    }
  };

  // ==================== ENCABEZADO ====================
  page.drawRectangle({
    x: 0,
    y: height - 100,
    width: width,
    height: 100,
    color: rgb(0.95, 0.95, 0.98)
  });

  page.drawText('REPORTE DE METADATA', {
    x: marginLeft,
    y: height - 45,
    font: helveticaBold,
    size: 20,
    color: darkBlue
  });

  page.drawText('Sistema de Evidencia Digital Forense - PRUEBA DIGITAL', {
    x: marginLeft,
    y: height - 65,
    font: helvetica,
    size: 10,
    color: lightGray
  });

  page.drawText(`Version ${version} | Generado: ${new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' })}`, {
    x: marginLeft,
    y: height - 80,
    font: helvetica,
    size: 9,
    color: lightGray
  });

  y = height - 130;

  // ==================== DATOS DE LA EVIDENCIA ====================
  page.drawText('DATOS DE LA EVIDENCIA', {
    x: marginLeft,
    y,
    font: helveticaBold,
    size: 12,
    color: darkBlue
  });
  y -= 25;

  const evidenceData = [
    ['ID de Evidencia:', String(evidence.id)],
    ['Titulo:', sanitizeText(evidence.title) || 'Sin titulo'],
    ['Caso:', sanitizeText(evidence.case?.title) || 'Sin caso asignado'],
    ['Estado:', evidence.status || 'N/A'],
    ['Fecha de Creacion:', new Date(evidence.createdAt).toLocaleString('es-PE', { timeZone: 'America/Lima' })]
  ];

  for (const [label, value] of evidenceData) {
    checkPage();
    page.drawText(label, { x: marginLeft, y, font: helveticaBold, size: 10, color: darkGray });
    page.drawText(sanitizeText(value), { x: marginLeft + 130, y, font: helvetica, size: 10, color: darkGray });
    y -= 18;
  }

  y -= 15;

  // ==================== ARCHIVO ORIGINAL ====================
  if (originalFile) {
    checkPage(100);
    page.drawText('ARCHIVO ORIGINAL', {
      x: marginLeft,
      y,
      font: helveticaBold,
      size: 12,
      color: darkBlue
    });
    y -= 25;

    const fileData = [
      ['Nombre:', sanitizeText(originalFile.originalFilename) || 'N/A'],
      ['Tipo MIME:', originalFile.mimeType || 'N/A'],
      ['Tamano:', originalFile.sizeBytes ? `${Number(originalFile.sizeBytes).toLocaleString()} bytes` : 'N/A']
    ];

    if (originalFile.hashRecords && originalFile.hashRecords[0]) {
      fileData.push(['Hash SHA-256:', originalFile.hashRecords[0].hashHex || 'N/A']);
    }

    for (const [label, value] of fileData) {
      checkPage();
      page.drawText(label, { x: marginLeft, y, font: helveticaBold, size: 10, color: darkGray });

      // Para hash SHA-256: mostrarlo completo en una sola linea con fuente mas pequena
      if (label === 'Hash SHA-256:' && value.length > 50) {
        // Hash completo en una linea (64 caracteres caben con fuente size 7)
        page.drawText(value, { x: marginLeft + 100, y, font: helvetica, size: 7, color: darkGray });
      } else {
        page.drawText(sanitizeText(value), { x: marginLeft + 100, y, font: helvetica, size: 10, color: darkGray });
      }
      y -= 18;
    }

    y -= 15;
  }

  // ==================== METADATA EXTRAIDA ====================
  checkPage(100);

  // Linea separadora
  page.drawLine({
    start: { x: marginLeft, y: y + 10 },
    end: { x: width - marginLeft, y: y + 10 },
    thickness: 1,
    color: rgb(0.85, 0.85, 0.85)
  });

  y -= 10;

  page.drawText('METADATA EXTRAIDA DEL DOCUMENTO', {
    x: marginLeft,
    y,
    font: helveticaBold,
    size: 12,
    color: darkBlue
  });
  y -= 25;

  // Propiedades principales (cubre PDF, imagen, video, audio)
  const mainProps = [
    'title', 'author', 'creator', 'producer', 'subject', 'keywords',
    'creationDate', 'modificationDate', 'pageCount',
    'format', 'width', 'height', 'mimeType', 'fileSize',
    'software', 'colorSpace', 'timezone', 'density', 'pdfVersion',
    'duracion', 'codec', 'sampleRate', 'canales',
    'device_fabricante', 'device_modelo', 'device_numeroSerie', 'device_lente'
  ];
  const propLabels = {
    title: 'Titulo',
    author: 'Autor',
    creator: 'Creador',
    producer: 'Productor',
    subject: 'Asunto',
    keywords: 'Palabras clave',
    creationDate: 'Fecha de creacion',
    modificationDate: 'Fecha de modificacion',
    pageCount: 'Numero de paginas',
    format: 'Formato',
    width: 'Ancho (px)',
    height: 'Alto (px)',
    mimeType: 'Tipo MIME',
    fileSize: 'Tamano de archivo',
    software: 'Software',
    colorSpace: 'Espacio de color',
    timezone: 'Zona horaria',
    density: 'Densidad (DPI)',
    pdfVersion: 'Version PDF',
    duracion: 'Duracion',
    codec: 'Codec',
    sampleRate: 'Frecuencia de muestreo',
    canales: 'Canales',
    device_fabricante: 'Fabricante',
    device_modelo: 'Modelo',
    device_numeroSerie: 'Numero de serie',
    device_lente: 'Lente'
  };

  let foundMainProps = false;
  for (const prop of mainProps) {
    if (metadata[prop] !== undefined && metadata[prop] !== null && metadata[prop] !== '') {
      checkPage();
      const label = propLabels[prop] || prop;
      const value = sanitizeText(metadata[prop]);
      if (!value) continue;

      page.drawText(`${label}:`, { x: marginLeft, y, font: helveticaBold, size: 10, color: darkGray });

      // Valores largos en siguiente linea
      if (value.length > 50) {
        y -= 14;
        y = addText(value, { maxWidth: contentWidth - 20 });
      } else {
        page.drawText(value, { x: marginLeft + 140, y, font: helvetica, size: 10, color: darkGray });
        y -= 18;
      }

      foundMainProps = true;
    }
  }

  if (!foundMainProps) {
    page.drawText('(No se encontraron propiedades principales)', {
      x: marginLeft,
      y,
      font: helvetica,
      size: 10,
      color: lightGray
    });
    y -= 18;
  }

  // Otras propiedades
  const otherProps = Object.keys(metadata).filter(k => !mainProps.includes(k));
  if (otherProps.length > 0) {
    y -= 15;
    checkPage(60);

    page.drawText('PROPIEDADES ADICIONALES', {
      x: marginLeft,
      y,
      font: helveticaBold,
      size: 11,
      color: darkBlue
    });
    y -= 20;

    for (const prop of otherProps) {
      const rawValue = metadata[prop];
      checkPage();

      page.drawText(`${sanitizeText(prop)}:`, { x: marginLeft, y, font: helveticaBold, size: 10, color: darkGray });

      if (typeof rawValue === 'object' && rawValue !== null) {
        y -= 14;
        const jsonStr = JSON.stringify(rawValue, null, 2);
        // Limitar a primeros 500 caracteres para objetos muy grandes
        const truncated = jsonStr.length > 500 ? jsonStr.substring(0, 500) + '...' : jsonStr;
        y = addText(truncated, { size: 9, color: lightGray });
      } else {
        const strValue = sanitizeText(rawValue);
        if (strValue.length > 50) {
          y -= 14;
          y = addText(strValue, { maxWidth: contentWidth - 20 });
        } else {
          page.drawText(strValue || 'N/A', { x: marginLeft + 140, y, font: helvetica, size: 10, color: darkGray });
          y -= 18;
        }
      }
    }
  }

  // ==================== NOTA TECNICA ====================
  y -= 30;
  checkPage(120);

  page.drawRectangle({
    x: marginLeft - 10,
    y: y - 70,
    width: contentWidth + 20,
    height: 85,
    color: rgb(0.97, 0.97, 0.99),
    borderColor: rgb(0.85, 0.85, 0.9),
    borderWidth: 1
  });

  y -= 5;
  page.drawText('NOTA TECNICA', {
    x: marginLeft,
    y,
    font: helveticaBold,
    size: 10,
    color: darkBlue
  });
  y -= 18;

  const notaLines = [
    'La metadata extraida corresponde a la informacion interna del archivo original.',
    'Esta informacion puede incluir datos del software que creo el archivo, fechas de',
    'creacion y modificacion, autor, y otros metadatos embebidos.',
    'Los metadatos NO han sido alterados durante el proceso de extraccion.'
  ];

  for (const line of notaLines) {
    page.drawText(line, { x: marginLeft, y, font: helvetica, size: 9, color: darkGray });
    y -= 13;
  }

  // ==================== PIE DE PAGINA ====================
  const totalPages = pdfDoc.getPageCount();
  const pages = pdfDoc.getPages();

  for (let i = 0; i < totalPages; i++) {
    const pg = pages[i];
    const { height: pgHeight } = pg.getSize();

    // Linea de pie
    pg.drawLine({
      start: { x: marginLeft, y: 35 },
      end: { x: width - marginLeft, y: 35 },
      thickness: 0.5,
      color: rgb(0.85, 0.85, 0.85)
    });

    pg.drawText(`Pagina ${i + 1} de ${totalPages}`, {
      x: width - marginLeft - 70,
      y: 20,
      font: helvetica,
      size: 8,
      color: lightGray
    });

    pg.drawText('PRUEBA DIGITAL - Reporte de Metadata', {
      x: marginLeft,
      y: 20,
      font: helvetica,
      size: 8,
      color: lightGray
    });
  }

  return await pdfDoc.save();
}

// ============================================================================
// IMPORTAR DESDE GOOGLE DRIVE
// ============================================================================

/**
 * POST /api/evidences/import-drive
 * Importa archivo(s) desde Google Drive preservando metadatos e integridad
 */
const importFromDrive = async (req, res) => {
  try {
    const { fileIds, accessToken, caseId, title, description } = req.body;

    // Datos del aportante (OBLIGATORIOS)
    const contributorData = {
      actaLugar: req.body.actaLugar,
      actaEntidadInterviniente: req.body.actaEntidadInterviniente,
      usuarioEntidad: req.body.usuarioEntidad || null,
      aportanteNombreCompleto: req.body.aportanteNombreCompleto,
      aportanteDocumentoTipo: req.body.aportanteDocumentoTipo || 'DNI',
      aportanteDocumentoNumero: req.body.aportanteDocumentoNumero,
      aportanteCondicion: req.body.aportanteCondicion,
      aportanteCondicionOtro: req.body.aportanteCondicionOtro || null,
      aportanteDomicilio: req.body.aportanteDomicilio || null,
      aportanteTelefono: req.body.aportanteTelefono || null,
      aportanteCorreo: req.body.aportanteCorreo || null,
      dispositivoOrigen: req.body.dispositivoOrigen || null,
      fechaObtencionArchivo: req.body.fechaObtencionArchivo || null
    };

    // Verificar caso si se proporciona
    const parsedCaseId = caseId ? parseInt(caseId) : null;
    if (parsedCaseId) {
      const caseRecord = await prisma.case.findUnique({
        where: { id: parsedCaseId }
      });

      if (!caseRecord) {
        return res.status(404).json({
          success: false,
          error: { code: 'CASE_NOT_FOUND', message: 'Caso no encontrado' }
        });
      }

      if (!req.user.roles.includes('SUPER_ADMIN') && caseRecord.ownerUserId !== req.user.id) {
        return res.status(403).json({
          success: false,
          error: { code: 'ACCESS_DENIED', message: 'No tiene acceso a este caso' }
        });
      }
    }

    const results = [];

    // Procesar cada archivo secuencialmente
    for (let i = 0; i < fileIds.length; i++) {
      const fileId = fileIds[i];
      console.log(`[ImportDrive] Procesando archivo ${i + 1}/${fileIds.length}: ${fileId}`);

      try {
        // 1. Obtener metadatos de Google Drive
        const googleMeta = await googleDriveService.getFileMetadata(accessToken, fileId);
        console.log(`[ImportDrive] Metadatos obtenidos: ${googleMeta.originalFilename} (${googleMeta.sizeBytes} bytes)`);

        // 2. Validar archivo
        const validation = googleDriveService.validateFile(googleMeta);
        if (!validation.valid) {
          results.push({
            fileId,
            fileName: googleMeta.name,
            success: false,
            error: validation.error
          });
          continue;
        }

        const evidenceTitle = fileIds.length === 1 && title
          ? title
          : (title ? `${title} - ${googleMeta.originalFilename}` : googleMeta.originalFilename);

        // 2.5 IDEMPOTENCIA PRE-DESCARGA: si Google reporta sha256Checksum y este owner
        // ya tiene una evidencia con ese hash en estado procesable, devolverla sin descargar.
        if (googleMeta.sha256Checksum) {
          const preExisting = await prisma.hashRecord.findFirst({
            where: {
              hashHex: googleMeta.sha256Checksum,
              evidenceFile: {
                fileRole: 'ORIGINAL',
                evidence: {
                  ownerUserId: req.user.id,
                  status: { not: 'ERROR' }
                }
              }
            },
            include: { evidenceFile: { include: { evidence: { select: { id: true, title: true, status: true } } } } }
          });
          if (preExisting && preExisting.evidenceFile?.evidence) {
            const ev = preExisting.evidenceFile.evidence;
            console.log(`[ImportDrive] Carga idempotente (pre-download): hash ${googleMeta.sha256Checksum.substring(0, 16)}... ya existe como evidencia ${ev.id}`);
            results.push({
              fileId,
              fileName: googleMeta.originalFilename,
              success: true,
              evidenceId: ev.id,
              integrityVerified: true,
              isDuplicate: true,
              message: 'Esta evidencia ya fue importada previamente'
            });
            continue;
          }
        }

        // 3. Subir a Wasabi PRIMERO (con storageKey por hash si Google da hash, sino UUID temporal)
        const predeterminedKey = googleMeta.sha256Checksum
          ? generateStorageKeyByHash(STORAGE_STRUCTURE.ORIGINAL, googleMeta.sha256Checksum, req.user.id, googleMeta.originalFilename)
          : null;

        // PRE-CHECK: si predeterminedKey existe en S3, reusarlo (carga paralela o reintento)
        let stored;
        if (predeterminedKey) {
          const exists = await storageService.getFileInfo(predeterminedKey);
          if (exists.exists) {
            console.log(`[ImportDrive] Archivo ya existe en S3 con key ${predeterminedKey}, reusando (sin descargar).`);
            stored = {
              storageKey: predeterminedKey,
              sizeBytes: exists.sizeBytes,
              hash: googleMeta.sha256Checksum,
              isEncrypted: exists.encrypted
            };
          }
        }

        if (!stored) {
          console.log(`[ImportDrive] Descargando archivo de Google Drive...`);
          const fileStream = await googleDriveService.downloadFileStream(accessToken, fileId);

          stored = await storageService.saveFileStream(
            fileStream,
            STORAGE_STRUCTURE.ORIGINAL,
            null, // evidenceId no se usa si options.storageKey esta presente
            googleMeta.originalFilename,
            true,
            predeterminedKey ? { storageKey: predeterminedKey } : {}
          );
        }

        // 4. Verificacion cruzada de integridad (si Google reporto hash)
        const integrityMatch = googleMeta.sha256Checksum
          ? stored.hash === googleMeta.sha256Checksum
          : null;

        if (integrityMatch === false) {
          console.error(`[ImportDrive] FALLO INTEGRIDAD: local=${stored.hash} vs google=${googleMeta.sha256Checksum}`);
          await storageService.deleteFile(stored.storageKey).catch(() => {});
          results.push({
            fileId,
            fileName: googleMeta.originalFilename,
            success: false,
            error: 'Verificacion de integridad fallida: el hash del archivo descargado no coincide con el hash reportado por Google Drive'
          });
          continue;
        }

        // 5. IDEMPOTENCIA POST-DESCARGA (cubre el caso donde Google no reporto hash)
        const postExisting = await prisma.hashRecord.findFirst({
          where: {
            hashHex: stored.hash,
            evidenceFile: {
              fileRole: 'ORIGINAL',
              evidence: {
                ownerUserId: req.user.id,
                status: { not: 'ERROR' }
              }
            }
          },
          include: { evidenceFile: { include: { evidence: { select: { id: true, title: true, status: true } } } } }
        });
        if (postExisting && postExisting.evidenceFile?.evidence) {
          const ev = postExisting.evidenceFile.evidence;
          console.log(`[ImportDrive] Carga idempotente (post-download): hash ${stored.hash.substring(0, 16)}... ya existe como evidencia ${ev.id}`);
          // Limpieza: si subimos a una key UUID nueva (no por hash), eliminarla
          if (!predeterminedKey) {
            await storageService.deleteFile(stored.storageKey).catch(() => {});
          }
          results.push({
            fileId,
            fileName: googleMeta.originalFilename,
            success: true,
            evidenceId: ev.id,
            integrityVerified: true,
            isDuplicate: true,
            message: 'Esta evidencia ya fue importada previamente'
          });
          continue;
        }

        // 6. Crear evidence + evidenceFile + hashRecord en transaccion atomica
        let evidence, evidenceFile;
        try {
          const txResult = await prisma.$transaction(async (tx) => {
            const newEvidence = await tx.evidence.create({
              data: {
                ownerUserId: req.user.id,
                caseId: parsedCaseId,
                title: evidenceTitle,
                description: description || null,
                sourceType: getMimeCategory(googleMeta.mimeType) || 'OTHER',
                status: 'RECEIVED',
                isPublic: true,
                userIdRegistration: req.user.id
              }
            });

            const newFile = await tx.evidenceFile.create({
              data: {
                evidenceId: newEvidence.id,
                fileRole: 'ORIGINAL',
                storageKey: stored.storageKey,
                originalFilename: googleMeta.originalFilename,
                mimeType: googleMeta.mimeType,
                sizeBytes: stored.sizeBytes,
                isEncrypted: stored.isEncrypted,
                version: 1,
                userIdRegistration: req.user.id
              }
            });

            await tx.hashRecord.create({
              data: {
                evidenceFileId: newFile.id,
                algorithm: 'SHA256',
                hashHex: stored.hash,
                userIdRegistration: req.user.id
              }
            });

            return { evidence: newEvidence, evidenceFile: newFile };
          });
          evidence = txResult.evidence;
          evidenceFile = txResult.evidenceFile;
        } catch (dbError) {
          console.error(`[ImportDrive] Error creando registros BD:`, dbError);
          if (!predeterminedKey) {
            await storageService.deleteFile(stored.storageKey).catch(() => {});
          }
          results.push({
            fileId,
            fileName: googleMeta.originalFilename,
            success: false,
            error: `Error al registrar la evidencia en base de datos: ${dbError.message}`
          });
          continue;
        }

        // 8. Registrar evento de custodia
        const sha256CalculatedAtUtc = new Date().toISOString();
        await custodyService.registerGoogleDriveUpload(
          evidence.id,
          req.user.id,
          {
            googleFileId: googleMeta.id,
            googleSha256: googleMeta.sha256Checksum,
            googleMd5: googleMeta.md5Checksum,
            googleCreatedTime: googleMeta.createdTime,
            googleModifiedTime: googleMeta.modifiedTime,
            googleOwnerEmail: googleMeta.ownerEmail,
            originalFilename: googleMeta.originalFilename,
            mimeType: googleMeta.mimeType,
            sizeBytes: stored.sizeBytes,
            localSha256: stored.hash,
            integrityMatch: integrityMatch !== false,
            storageKey: stored.storageKey,
            sha256CalculatedAtUtc
          }
        );

        // 9. Registrar auditoria
        await createAuditLog(
          req.user.id,
          'EVIDENCE_IMPORT_DRIVE',
          'evidences',
          evidence.id,
          {
            title: evidenceTitle,
            caseId: parsedCaseId,
            filename: googleMeta.originalFilename,
            googleFileId: googleMeta.id,
            source: 'GOOGLE_DRIVE'
          },
          req.ip,
          req.get('User-Agent')
        );

        // 10. Crear registro de aportante y generar acta
        let actaGenerada = null;
        try {
          const contributorRecord = await actaService.createContributorRecord(
            evidence.id,
            contributorData,
            req.user.id
          );

          const actaResult = await actaService.generateActaPdf(
            evidence.id,
            contributorRecord.id,
            req.user.id
          );

          actaGenerada = {
            id: actaResult.id,
            actaNumero: actaResult.actaNumero,
            actaUuid: actaResult.actaUuid
          };
        } catch (actaError) {
          console.error(`[ImportDrive] Error creando acta para evidencia ${evidence.id}:`, actaError.message);
        }

        // 11. Disparar pipeline (asincrono)
        pipelineService.processEvidence(evidence.id)
          .then(result => {
            console.log(`[ImportDrive] Pipeline COMPLETADO para evidencia ${evidence.id}:`, result.finalStatus);
          })
          .catch(err => {
            console.error(`[ImportDrive] ERROR en pipeline para evidencia ${evidence.id}:`, err.message);
          });

        results.push({
          fileId,
          fileName: googleMeta.originalFilename,
          success: true,
          evidenceId: evidence.id,
          integrityVerified: integrityMatch !== false,
          acta: actaGenerada
        });

        console.log(`[ImportDrive] Archivo ${i + 1}/${fileIds.length} procesado exitosamente (evidencia ${evidence.id})`);

      } catch (fileError) {
        console.error(`[ImportDrive] Error procesando archivo ${fileId}:`, fileError.message);

        // Determinar tipo de error
        let errorMessage = 'Error al procesar archivo desde Google Drive';
        const status = fileError.response?.status || fileError.code;

        if (status === 401 || status === 'UNAUTHENTICATED') {
          errorMessage = 'Token de Google expirado. Por favor, vuelva a seleccionar los archivos desde Google Drive';
        } else if (status === 403) {
          errorMessage = 'No tiene permiso para acceder a este archivo en Google Drive';
        } else if (status === 404) {
          errorMessage = 'Archivo no encontrado en Google Drive';
        }

        results.push({
          fileId,
          success: false,
          error: errorMessage
        });
      }
    }

    // Resumen de resultados
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    const statusCode = successCount > 0 ? 201 : 422;

    res.status(statusCode).json({
      success: successCount > 0,
      data: {
        message: `${successCount} evidencia(s) importada(s) exitosamente${failCount > 0 ? `, ${failCount} con errores` : ''}`,
        results,
        summary: {
          total: fileIds.length,
          success: successCount,
          failed: failCount
        }
      }
    });

  } catch (error) {
    console.error('[ImportDrive] Error general:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Error al importar desde Google Drive'
      }
    });
  }
};

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  listEvidences,
  getEvidenceById,
  uploadEvidence,
  downloadFile,
  togglePublic,
  regenerate,
  deleteEvidence,
  exportMetadata,
  importFromDrive
};
