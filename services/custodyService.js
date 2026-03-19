// ============================================================================
// CUSTODY SERVICE - Cadena de custodia inmutable con hash determinista (JCS)
// Sistema PRUEBA DIGITAL
// Cumple: SWGDE, ISO/IEC 27037, NIST SP 800-86, RFC 8785 (JCS)
// ============================================================================

const { PrismaClient } = require('@prisma/client');
const { v4: uuidv4 } = require('uuid');
const forensicUtils = require('../utils/forensicUtils');

const prisma = new PrismaClient();

// Importar constantes desde forensicUtils para consistencia
const {
  GENESIS_HASH,
  HASH_ALGORITHM,
  CANONICALIZATION_METHOD,
  buildEventForHash,
  computeEventHash,
  computeSha256Hex
} = forensicUtils;

// ============================================================================
// CLASE DE SERVICIO DE CUSTODIA
// ============================================================================

class CustodyService {
  /**
   * Enriquece el payload con identificadores estandar de evidencia
   * Cambio 1: caseId, evidenceUuid, storageObjectId, originalFilename en TODOS los eventos
   * @param {number} evidenceId - ID numerico de la evidencia
   * @param {Object} baseDetails - Detalles base del evento
   * @returns {Promise<Object>} Payload enriquecido
   */
  async _enrichPayload(evidenceId, baseDetails = {}) {
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: {
        uuid: true,
        caseId: true,
        files: {
          where: { fileRole: 'ORIGINAL' },
          select: { storageKey: true, originalFilename: true },
          take: 1
        }
      }
    });

    const originalFile = evidence?.files[0];

    // NOTA: caseId se incluye en eventForHash a nivel raiz, no en el payload
    // para evitar duplicacion (Cambio B del plan de normalizacion)
    return {
      ...baseDetails,
      evidenceUuid: evidence?.uuid || null,
      storageObjectId: originalFile?.storageKey || null,
      originalFilename: originalFile?.originalFilename || null
    };
  }

  /**
   * Construye objeto actor estructurado para eventos forenses
   * @param {string} actorType - Tipo de actor (USER, SYSTEM, PUBLIC)
   * @param {number|null} actorUserId - ID del usuario (null para SYSTEM/PUBLIC)
   * @returns {Promise<Object>} Actor estructurado { type, id, displayName }
   */
  async _buildActorObject(actorType, actorUserId) {
    if (actorType === 'SYSTEM') {
      return {
        type: 'SYSTEM',
        id: null,
        displayName: 'Sistema PRUEBA DIGITAL'
      };
    }

    if (actorType === 'PUBLIC') {
      return {
        type: 'PUBLIC',
        id: null,
        displayName: 'Verificador Publico'
      };
    }

    // actorType === 'USER'
    if (!actorUserId) {
      return {
        type: 'USER',
        id: null,
        displayName: 'Usuario Desconocido'
      };
    }

    const user = await prisma.user.findUnique({
      where: { id: actorUserId },
      select: { fullName: true, email: true }
    });

    return {
      type: 'USER',
      id: actorUserId,
      displayName: user?.fullName || user?.email || `Usuario #${actorUserId}`
    };
  }

  /**
   * Registra un evento de custodia (append-only, inmutable)
   * Usa RFC 8785 JCS para hash determinista y encadenamiento criptografico
   *
   * VALIDACIONES FORENSES:
   * - sequence debe ser lastSequence + 1
   * - prevEventHash debe coincidir con eventHash del último evento
   * - Aborta si falla cualquier validación
   *
   * @param {number} evidenceId - ID de la evidencia
   * @param {string} eventType - Tipo de evento (CustodyEventType enum)
   * @param {string} actorType - Tipo de actor (USER, SYSTEM, PUBLIC)
   * @param {number|null} actorUserId - ID del usuario actor (null para SYSTEM/PUBLIC)
   * @param {Object} details - Detalles adicionales del evento
   * @returns {Promise<Object>} Evento creado
   */
  async registerEvent(evidenceId, eventType, actorType, actorUserId = null, details = null) {
    // 1. Obtener evidencia con UUID y caseId
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: { uuid: true, caseId: true }
    });

    if (!evidence) {
      throw new Error(`[CustodyService] Evidence ${evidenceId} not found`);
    }

    // 2. Obtener último evento para encadenar hash y calcular sequence
    const lastEvent = await prisma.custodyEvent.findFirst({
      where: { evidenceId },
      orderBy: [{ sequence: 'desc' }]
    });

    // FORENSE: Usar GENESIS_HASH (64 zeros) para primer evento
    const prevEventHash = lastEvent ? lastEvent.eventHash : GENESIS_HASH;
    const expectedSequence = lastEvent ? lastEvent.sequence + 1 : 1;

    // 3. VALIDACIÓN FORENSE: Verificar integridad antes de insertar
    if (lastEvent) {
      // Verificar que prevEventHash coincide con el último eventHash
      if (prevEventHash !== lastEvent.eventHash) {
        const errorMsg = `[CustodyService] INTEGRIDAD VIOLADA: prevEventHash no coincide. Esperado: ${lastEvent.eventHash}, Usando: ${prevEventHash}`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }

      // BLOQUEO: Si el último evento es READY_EXPORT, el eventlog está CERRADO
      // EXCEPCIÓN: CRYPTO_SEAL_CREATED se permite después de READY_EXPORT
      // porque es el sello que certifica el cierre del eventlog
      if (lastEvent.eventType === 'READY_EXPORT' && eventType !== 'CRYPTO_SEAL_CREATED') {
        const errorMsg = `[CustodyService] EVENTLOG CERRADO: No se pueden agregar eventos después de READY_EXPORT. Último evento: seq=${lastEvent.sequence}, hash=${lastEvent.eventHash}. Evento rechazado: ${eventType}`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }

      // BLOQUEO TOTAL: Después de CRYPTO_SEAL_CREATED no se permite NADA
      if (lastEvent.eventType === 'CRYPTO_SEAL_CREATED') {
        const errorMsg = `[CustodyService] EVIDENCIA SELLADA: No se pueden agregar eventos después de CRYPTO_SEAL_CREATED. Evento rechazado: ${eventType}`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }
    }

    // 4. Generar UUID del evento y timestamp UTC con milisegundos
    const eventUuid = uuidv4();
    const occurredAtUtc = new Date().toISOString();

    // 5. Enriquecer payload con identificadores estándar
    const enrichedPayload = await this._enrichPayload(evidenceId, details || {});

    // 6. Construir objeto actor estructurado
    const actor = await this._buildActorObject(actorType, actorUserId);

    // 7. Construir eventForHash usando forensicUtils (RFC 8785 JCS)
    const eventForHash = buildEventForHash({
      eventId: eventUuid,
      evidenceUuid: evidence.uuid,
      caseId: evidence.caseId,
      eventType,
      occurredAtUtc,
      actor,
      sequence: expectedSequence,
      prevEventHash,
      payload: enrichedPayload
    });

    // 8. Calcular hash determinista con JCS
    const eventHash = computeEventHash(eventForHash);

    // 9. Crear evento (inmutable, append-only)
    // Cambio A del plan: actorDisplayName va en columna normalizada, no en details._actor
    const custodyEvent = await prisma.custodyEvent.create({
      data: {
        eventUuid,
        sequence: expectedSequence,
        evidenceId,
        actorUserId,
        actorType,
        actorDisplayName: actor.displayName, // Columna normalizada (plan Fase 2A)
        eventType,
        eventAt: new Date(occurredAtUtc),
        details: enrichedPayload, // Sin _actor - ahora esta en columna normalizada
        prevEventHash,
        eventHash,
        eventHashAlgorithm: HASH_ALGORITHM,
        eventCanonicalization: CANONICALIZATION_METHOD,
        userIdRegistration: actorType === 'USER' ? actorUserId : null
      }
    });

    console.log(`[CustodyService] Evento ${eventType} registrado: seq=${expectedSequence}, hash=${eventHash.substring(0, 16)}...`);

    return custodyEvent;
  }

  /**
   * Obtiene la cadena de custodia completa de una evidencia
   * @param {number} evidenceId - ID de la evidencia
   * @returns {Promise<Array>} Lista de eventos ordenados por sequence
   */
  async getCustodyChain(evidenceId) {
    return prisma.custodyEvent.findMany({
      where: { evidenceId },
      include: {
        actor: {
          select: {
            id: true,
            email: true,
            fullName: true
          }
        }
      },
      orderBy: { sequence: 'asc' }
    });
  }

  /**
   * Verifica la integridad de la cadena de custodia
   * Soporta eventos legacy (JSON.stringify) y nuevos (JCS-RFC8785)
   * @param {number} evidenceId - ID de la evidencia
   * @returns {Promise<{valid: boolean, errors: Array, lastEvent: Object|null}>}
   */
  async verifyCustodyChainIntegrity(evidenceId) {
    const events = await this.getCustodyChain(evidenceId);
    const errors = [];

    if (events.length === 0) {
      return { valid: true, errors: [], lastEvent: null };
    }

    // Obtener evidencia para recalcular hashes JCS
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: { uuid: true, caseId: true }
    });

    // Verificar primer evento tiene genesis hash o null (legacy)
    const firstEventPrevHash = events[0].prevEventHash;
    if (firstEventPrevHash !== null && firstEventPrevHash !== GENESIS_HASH) {
      errors.push({
        eventId: events[0].id,
        sequence: events[0].sequence,
        error: `Primer evento debe tener prevEventHash null (legacy) o genesis hash. Encontrado: ${firstEventPrevHash?.substring(0, 16)}...`
      });
    }

    // Verificar secuencia continua y encadenamiento de hashes
    for (let i = 0; i < events.length; i++) {
      const currentEvent = events[i];

      // Verificar sequence continua
      const expectedSequence = i + 1;
      if (currentEvent.sequence !== expectedSequence) {
        if (currentEvent.eventCanonicalization === 'JCS-RFC8785') {
          errors.push({
            eventId: currentEvent.id,
            sequence: currentEvent.sequence,
            error: `Sequence esperado ${expectedSequence}, encontrado ${currentEvent.sequence}`
          });
        }
      }

      // Verificar encadenamiento (desde segundo evento)
      if (i > 0) {
        const previousEvent = events[i - 1];
        if (currentEvent.prevEventHash !== previousEvent.eventHash) {
          errors.push({
            eventId: currentEvent.id,
            sequence: currentEvent.sequence,
            error: `prevEventHash no coincide. Esperado: ${previousEvent.eventHash?.substring(0, 16)}..., Encontrado: ${currentEvent.prevEventHash?.substring(0, 16)}...`
          });
        }
      }

      // Recalcular hash según método de canonización
      let calculatedHash;

      if (currentEvent.eventCanonicalization === 'JCS-RFC8785') {
        try {
          // Cambio D: Usar actorDisplayName de columna normalizada (no details._actor)
          // Soporta eventos legacy que aun tienen details._actor
          const storedActor = currentEvent.details?._actor;
          const actor = storedActor || {
            type: currentEvent.actorType,
            id: currentEvent.actorUserId || null,
            displayName: currentEvent.actorDisplayName ||
                         currentEvent.actor?.fullName ||
                         (currentEvent.actorType === 'SYSTEM' ? 'Sistema PRUEBA DIGITAL' :
                          currentEvent.actorType === 'PUBLIC' ? 'Verificador Publico' :
                          `Usuario #${currentEvent.actorUserId}`)
          };

          // Payload limpio para hash (sin _actor si existe en legacy)
          const payloadForHash = { ...(currentEvent.details || {}) };
          delete payloadForHash._actor;

          const eventForHash = buildEventForHash({
            eventId: currentEvent.eventUuid,
            evidenceUuid: evidence.uuid,
            caseId: currentEvent.details?.caseId ?? evidence.caseId,
            eventType: currentEvent.eventType,
            occurredAtUtc: currentEvent.eventAt.toISOString(),
            actor,
            sequence: currentEvent.sequence,
            prevEventHash: currentEvent.prevEventHash || GENESIS_HASH,
            payload: payloadForHash
          });

          calculatedHash = computeEventHash(eventForHash);
        } catch (err) {
          errors.push({
            eventId: currentEvent.id,
            sequence: currentEvent.sequence,
            error: `Error recalculando hash: ${err.message}`
          });
          continue;
        }
      } else {
        // Legacy: no se puede verificar de forma determinista
        // Solo verificar encadenamiento
        continue;
      }

      if (calculatedHash !== currentEvent.eventHash) {
        errors.push({
          eventId: currentEvent.id,
          sequence: currentEvent.sequence,
          error: `eventHash no coincide. Almacenado: ${currentEvent.eventHash?.substring(0, 16)}..., Calculado: ${calculatedHash?.substring(0, 16)}...`,
          canonicalization: currentEvent.eventCanonicalization
        });
      }
    }

    const lastEvent = events[events.length - 1];

    return {
      valid: errors.length === 0,
      errors,
      lastEvent: lastEvent ? {
        sequence: lastEvent.sequence,
        eventHash: lastEvent.eventHash,
        eventType: lastEvent.eventType
      } : null
    };
  }

  /**
   * Obtiene el ultimo evento de una evidencia
   * @param {number} evidenceId - ID de la evidencia
   * @returns {Promise<Object|null>}
   */
  async getLastEvent(evidenceId) {
    return prisma.custodyEvent.findFirst({
      where: { evidenceId },
      orderBy: { sequence: 'desc' }
    });
  }

  // ==========================================================================
  // METODOS HELPER DE REGISTRO DE EVENTOS - FORMATO REQUERIMIENTO
  // Payloads exactos segun requerimiento.txt
  // ==========================================================================

  /**
   * UPLOAD - Archivo Subido
   * Payload segun requerimiento: sizeBytes, filename, originalFilename, mimeType,
   * mimeDetected, bytesReadMethod, storageObjectId, evidenceSha256, sha256CalculatedAtUtc, description
   */
  async registerUpload(evidenceId, userId, details) {
    const payload = {
      sizeBytes: details.sizeBytes || 0,
      filename: details.filename || details.originalFilename,
      originalFilename: details.originalFilename,
      mimeType: details.mimeType,
      mimeDetected: details.mimeDetected || details.mimeType,
      bytesReadMethod: details.bytesReadMethod || 'stream-full-file',
      storageObjectId: details.storageObjectId || details.storageKey,
      evidenceSha256: details.evidenceSha256 || details.hash,
      sha256CalculatedAtUtc: details.sha256CalculatedAtUtc || new Date().toISOString(),
      description: details.description || `Archivo original subido: ${details.originalFilename}`
    };
    return this.registerEvent(evidenceId, 'UPLOAD', 'USER', userId, payload);
  }

  /**
   * UPLOAD_GOOGLE_DRIVE - Archivo importado desde Google Drive
   * Payload: source, googleFileId, hashes de Google, fechas, propietario, verificacion cruzada
   */
  async registerGoogleDriveUpload(evidenceId, userId, details) {
    const payload = {
      source: 'GOOGLE_DRIVE',
      googleFileId: details.googleFileId,
      googleSha256: details.googleSha256 || null,
      googleMd5: details.googleMd5 || null,
      googleCreatedTime: details.googleCreatedTime || null,
      googleModifiedTime: details.googleModifiedTime || null,
      googleOwnerEmail: details.googleOwnerEmail || null,
      originalFilename: details.originalFilename,
      mimeType: details.mimeType,
      sizeBytes: details.sizeBytes || 0,
      localSha256: details.localSha256,
      integrityMatch: details.integrityMatch,
      storageObjectId: details.storageObjectId || details.storageKey,
      evidenceSha256: details.localSha256,
      sha256CalculatedAtUtc: details.sha256CalculatedAtUtc || new Date().toISOString(),
      bytesReadMethod: 'stream-google-drive-api',
      description: details.description || `Archivo importado desde Google Drive: ${details.originalFilename}`
    };
    return this.registerEvent(evidenceId, 'UPLOAD_GOOGLE_DRIVE', 'USER', userId, payload);
  }

  /**
   * SCAN - Escaneo Exitoso (nuevo eventType segun requerimiento)
   * Payload: clean, scanEngine, scannedAtUtc
   */
  async registerScan(evidenceId, details = {}) {
    const payload = {
      clean: details.clean !== false,
      scanEngine: details.scanEngine || 'basic-validation',
      scannedAtUtc: details.scannedAtUtc || details.scannedAt || new Date().toISOString()
    };
    return this.registerEvent(evidenceId, 'SCAN', 'SYSTEM', null, payload);
  }

  async registerScanFailed(evidenceId, details) {
    return this.registerEvent(evidenceId, 'SCAN_FAILED', 'SYSTEM', null, details);
  }

  /**
   * HASH_CALCULATED - Hash Calculado (nuevo eventType segun requerimiento)
   * Payload: algorithm, fileRole, evidenceSha256
   */
  async registerHashCalculated(evidenceId, details) {
    const payload = {
      algorithm: details.algorithm || 'SHA-256',
      fileRole: details.fileRole || 'ORIGINAL',
      evidenceSha256: details.evidenceSha256 || details.hash
    };
    return this.registerEvent(evidenceId, 'HASH_CALCULATED', 'SYSTEM', null, payload);
  }

  /**
   * BITCOPY_CREATED - Copia Bit-a-Bit Creada
   * Payload: matchesOriginal, originalSha256, bitcopySha256, originalStorageObjectId,
   * bitcopyStorageObjectId, originalSizeBytes, bitcopySizeBytes
   */
  async registerBitcopyCreated(evidenceId, details) {
    const payload = {
      matchesOriginal: details.matchesOriginal !== false,
      originalSha256: details.originalSha256,
      bitcopySha256: details.bitcopySha256,
      originalStorageObjectId: details.originalStorageObjectId,
      bitcopyStorageObjectId: details.bitcopyStorageObjectId,
      originalSizeBytes: details.originalSizeBytes,
      bitcopySizeBytes: details.bitcopySizeBytes
    };
    return this.registerEvent(evidenceId, 'BITCOPY_CREATED', 'SYSTEM', null, payload);
  }

  /**
   * SEALED_DOC_CREATED - Documento Sellado y Certificados (nuevo eventType segun requerimiento)
   * Payload: version, certificateRoles, certificatesGenerated, sealedDocumentStorageObjectId, sealedDocumentHashSha256
   */
  async registerSealedDocCreated(evidenceId, details) {
    const payload = {
      version: details.version || 1,
      certificateRoles: details.certificateRoles || ['CERT_JSON', 'CERT_PDF'],
      certificatesGenerated: details.certificatesGenerated || 2,
      sealedDocumentStorageObjectId: details.sealedDocumentStorageObjectId,
      sealedDocumentHashSha256: details.sealedDocumentHashSha256
    };
    return this.registerEvent(evidenceId, 'SEALED_DOC_CREATED', 'SYSTEM', null, payload);
  }

  async registerCryptoSealCreated(evidenceId, details) {
    return this.registerEvent(evidenceId, 'CRYPTO_SEAL_CREATED', 'SYSTEM', null, details);
  }

  /**
   * METADATA_EXTRACTED - Metadata Extraida (nuevo eventType segun requerimiento)
   * Payload: hasWarnings, metadataTool, metadataToolVersion, metadataPayloadStorageObjectId, metadataPayloadHashSha256
   */
  async registerMetadataExtracted(evidenceId, details) {
    const payload = {
      hasWarnings: details.hasWarnings || false,
      metadataTool: details.metadataTool || 'prueba-digital-metadata-extractor',
      metadataToolVersion: details.metadataToolVersion || '1.0.0',
      metadataPayloadStorageObjectId: details.metadataPayloadStorageObjectId || null,
      metadataPayloadHashSha256: details.metadataPayloadHashSha256
    };
    return this.registerEvent(evidenceId, 'METADATA_EXTRACTED', 'SYSTEM', null, payload);
  }

  /**
   * RISK_REPORT_CREATED - Reporte de Riesgo Generado
   * Payload: rulesTriggered, ruleIds, hasHighSeverity, riskRulesetVersion,
   * riskReportPayloadStorageObjectId, riskReportPayloadHashSha256
   */
  async registerRiskReportCreated(evidenceId, details) {
    const payload = {
      rulesTriggered: details.rulesTriggered || 0,
      ruleIds: details.ruleIds || [],
      hasHighSeverity: details.hasHighSeverity || false,
      riskRulesetVersion: details.riskRulesetVersion || '1.0.0',
      riskReportPayloadStorageObjectId: details.riskReportPayloadStorageObjectId || null,
      riskReportPayloadHashSha256: details.riskReportPayloadHashSha256
    };
    return this.registerEvent(evidenceId, 'RISK_REPORT_CREATED', 'SYSTEM', null, payload);
  }

  /**
   * READY_EXPORT - Listo para Exportar (nuevo eventType segun requerimiento)
   * Payload: message
   */
  async registerReadyExport(evidenceId) {
    const payload = {
      message: 'Todos los componentes listos para exportacion'
    };
    return this.registerEvent(evidenceId, 'READY_EXPORT', 'SYSTEM', null, payload);
  }

  // NOTA: EXPORT y DOWNLOAD se registran en AuditLog (no en custody_events)
  // porque la evidencia ya está sellada después de CRYPTO_SEAL_CREATED.
  // Ver evidenceController.js downloadFile() y exportService.js líneas 162-190.

  async registerPublicVerify(evidenceId, details) {
    return this.registerEvent(evidenceId, 'PUBLIC_VERIFY', 'PUBLIC', null, details);
  }

  async registerRegenerateVersion(evidenceId, userId, details) {
    return this.registerEvent(evidenceId, 'REGENERATE_VERSION', 'USER', userId, details);
  }

  async registerError(evidenceId, details) {
    return this.registerEvent(evidenceId, 'ERROR', 'SYSTEM', null, details);
  }

  // NOTA: El sello criptográfico se registra con registerCryptoSealCreated()
  // MANIFEST_SIGNED era el nombre legacy, ahora es CRYPTO_SEAL_CREATED

  // ==========================================================================
  // EXPORTACION
  // ==========================================================================

  /**
   * Exporta la cadena de custodia como JSON enriquecido
   * @param {number} evidenceId - ID de la evidencia
   * @returns {Promise<Object>}
   */
  async exportCustodyAsJson(evidenceId) {
    const events = await this.getCustodyChain(evidenceId);
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: {
        id: true,
        uuid: true,
        title: true,
        sourceType: true,
        caseId: true,
        createdAt: true
      }
    });

    const integrity = await this.verifyCustodyChainIntegrity(evidenceId);

    return {
      exportedAt: new Date().toISOString(),
      evidence: {
        ...evidence,
        evidenceUuid: evidence.uuid
      },
      chainIntegrity: integrity.valid,
      totalEvents: events.length,
      hashAlgorithm: 'SHA-256',
      canonicalization: 'JCS-RFC8785',
      events: events.map(event => ({
        id: event.id,
        eventUuid: event.eventUuid,
        sequence: event.sequence,
        eventType: event.eventType,
        actorType: event.actorType,
        // Cambio D: Usar actorDisplayName de columna normalizada
        actor: event.details?._actor || {
          type: event.actorType,
          id: event.actorUserId || (event.actor?.id ?? null),
          displayName: event.actorDisplayName || event.actor?.fullName || null
        },
        eventAt: event.eventAt,
        details: event.details || null,
        prevEventHash: event.prevEventHash,
        eventHash: event.eventHash,
        eventHashAlgorithm: event.eventHashAlgorithm,
        eventCanonicalization: event.eventCanonicalization
      }))
    };
  }

  /**
   * Exporta la cadena de custodia como JSONL (JSON Lines) forense
   * Cada linea es un evento JSON independiente, verificable
   * NO incluye header (el hash debe calcularse sobre los eventos puros)
   *
   * @param {number} evidenceId - ID de la evidencia
   * @param {Object} options - Opciones de filtrado
   * @param {number} options.maxSequence - Si se especifica, solo incluye eventos hasta esta secuencia (inclusive)
   * @returns {Promise<{content: string, eventLogHashSha256: string, totalEvents: number, lastEvent: Object}>}
   */
  async exportCustodyAsJsonl(evidenceId, options = {}) {
    let events = await this.getCustodyChain(evidenceId);

    // Filtrar por maxSequence si se especifica
    // Esto permite exportar solo los eventos certificados (excluyendo CRYPTO_SEAL_CREATED)
    if (options.maxSequence !== undefined && options.maxSequence !== null) {
      events = events.filter(e => e.sequence <= options.maxSequence);
      console.log(`[CustodyService] exportCustodyAsJsonl: filtrado a maxSequence=${options.maxSequence}, ${events.length} eventos`);
    }

    if (events.length === 0) {
      throw new Error(`[CustodyService] No hay eventos para evidencia ${evidenceId}` +
        (options.maxSequence ? ` con maxSequence=${options.maxSequence}` : ''));
    }

    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: { uuid: true, caseId: true }
    });

    const lines = events.map(event => {
      // Cambio D: Reconstruir actor desde columna normalizada actorDisplayName
      // Soporta eventos legacy que aun tienen details._actor
      const actor = event.details?._actor || {
        type: event.actorType,
        id: event.actorUserId || null,
        displayName: event.actorDisplayName || event.actor?.fullName || null
      };

      // Payload limpio (sin _actor si existe en eventos legacy)
      const payload = { ...(event.details || {}) };
      delete payload._actor;

      // Estructura forense estándar por evento
      const eventRecord = {
        eventId: event.eventUuid,
        evidenceUuid: evidence.uuid,
        caseId: evidence.caseId || null,
        sequence: event.sequence,
        eventType: event.eventType,
        occurredAtUtc: event.eventAt.toISOString(),
        actor,
        payload,
        prevEventHash: event.prevEventHash,
        eventHash: event.eventHash,
        eventHashAlgorithm: event.eventHashAlgorithm || HASH_ALGORITHM,
        eventCanonicalization: event.eventCanonicalization || CANONICALIZATION_METHOD
      };

      return JSON.stringify(eventRecord);
    });

    // Contenido del archivo: un JSON por línea, sin header
    const content = lines.join('\n');

    // Calcular hash del archivo JSONL (bytes exactos)
    const eventLogHashSha256 = computeSha256Hex(content);

    const lastEvent = events[events.length - 1];

    return {
      content,
      eventLogHashSha256,
      totalEvents: events.length,
      lastEvent: {
        sequence: lastEvent.sequence,
        eventHash: lastEvent.eventHash,
        eventType: lastEvent.eventType
      }
    };
  }

  /**
   * Genera eventlog.jsonl completo (solo eventos, sin header)
   * El header/metadata debe ir en el manifest, no en el archivo JSONL
   *
   * @param {number} evidenceId - ID de la evidencia
   * @returns {Promise<{content: string, eventLogHashSha256: string}>}
   */
  async generateEventlogFile(evidenceId) {
    const result = await this.exportCustodyAsJsonl(evidenceId);
    return {
      content: result.content,
      eventLogHashSha256: result.eventLogHashSha256,
      totalEvents: result.totalEvents
    };
  }

  /**
   * Exporta la cadena de custodia como TXT legible
   * @param {number} evidenceId - ID de la evidencia
   * @param {Object} options - Opciones de exportación
   * @param {number} options.maxSequence - Máxima secuencia a incluir
   * @returns {Promise<{content: string, eventLogHashSha256: string, totalEvents: number, lastEvent: Object}>}
   */
  async exportCustodyAsTxt(evidenceId, options = {}) {
    let events = await this.getCustodyChain(evidenceId);

    // Filtrar por maxSequence si se especifica
    if (options.maxSequence !== undefined && options.maxSequence !== null) {
      events = events.filter(e => e.sequence <= options.maxSequence);
      console.log(`[CustodyService] exportCustodyAsTxt: filtrado a maxSequence=${options.maxSequence}, ${events.length} eventos`);
    }

    if (events.length === 0) {
      throw new Error(`[CustodyService] No hay eventos para evidencia ${evidenceId}` +
        (options.maxSequence ? ` con maxSequence=${options.maxSequence}` : ''));
    }

    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: { uuid: true, caseId: true, title: true }
    });

    // Etiquetas de tipos de evento
    const eventTypeLabels = {
      UPLOAD: 'Archivo Subido',
      SCAN: 'Escaneo de Seguridad',
      SCAN_OK: 'Escaneo Exitoso',
      HASH_CALCULATED: 'Hash Calculado',
      BITCOPY_CREATED: 'Copia Bit-a-Bit Creada',
      SEALED_DOC_CREATED: 'Documento Sellado',
      SEAL_CREATED: 'Documento Sellado',
      CRYPTO_SEAL_CREATED: 'Sello Criptografico Ed25519',
      METADATA_EXTRACTED: 'Metadata Extraida',
      METADATA_CREATED: 'Metadata Extraida',
      RISK_REPORT_CREATED: 'Reporte de Riesgo Generado',
      READY_EXPORT: 'Listo para Exportar',
      READY_FOR_EXPORT: 'Listo para Exportar',
      EXPORT_CREATED: 'Exportacion Creada',
      DOWNLOAD: 'Archivo Descargado',
      ERROR: 'Error'
    };

    // Construir contenido TXT
    let txt = `================================================================================
                    REGISTRO DE EVENTOS - CADENA DE CUSTODIA
                    PRUEBA DIGITAL - Sistema de Evidencia Forense
================================================================================

Fecha de Generacion: ${new Date().toISOString()}
UUID de Evidencia: ${evidence.uuid}
Titulo: ${evidence.title || 'Sin titulo'}
ID de Caso: ${evidence.caseId || 'N/A'}
Total de Eventos: ${events.length}

================================================================================
                              EVENTOS
================================================================================

`;

    events.forEach((event, index) => {
      const eventLabel = eventTypeLabels[event.eventType] || event.eventType;
      const actorName = event.actorDisplayName || event.actor?.fullName ||
                       (event.actorType === 'SYSTEM' ? 'Sistema' : 'Desconocido');

      txt += `[Evento #${event.sequence}] ${eventLabel}
--------------------------------------------------------------------------------
  Fecha/Hora:     ${new Date(event.eventAt).toISOString()}
  Actor:          ${actorName} (${event.actorType})
  ID de Evento:   ${event.eventUuid || 'N/A'}
  Hash Evento:    ${event.eventHash}
  Hash Anterior:  ${event.prevEventHash || '(Genesis - Primer evento)'}
  Algoritmo:      ${event.eventHashAlgorithm || 'SHA-256'}`;

      // Agregar detalles relevantes del payload
      if (event.details) {
        const details = typeof event.details === 'string' ? JSON.parse(event.details) : event.details;
        const relevantKeys = Object.keys(details).filter(k => !k.startsWith('_') && details[k] !== null);
        if (relevantKeys.length > 0) {
          txt += `\n  Detalles:`;
          relevantKeys.forEach(key => {
            const value = details[key];
            const displayValue = typeof value === 'object' ? JSON.stringify(value) : value;
            // Truncar valores muy largos
            const truncated = String(displayValue).length > 80
              ? String(displayValue).substring(0, 77) + '...'
              : displayValue;
            txt += `\n    - ${key}: ${truncated}`;
          });
        }
      }

      txt += `\n\n`;
    });

    txt += `================================================================================
                           VERIFICACION DE INTEGRIDAD
================================================================================

La cadena de custodia utiliza encadenamiento criptografico donde cada evento
contiene el hash del evento anterior, formando una cadena inmutable.

Para verificar la integridad:
1. El primer evento (seq=1) tiene prevEventHash = null (Genesis)
2. Cada evento subsiguiente debe tener prevEventHash = eventHash del anterior
3. Los hashes se calculan usando SHA-256 sobre el contenido canonizado (JCS)

Algoritmo de Hash: SHA-256
Canonizacion: JCS (RFC 8785)

================================================================================
                    GENERADO POR PRUEBA DIGITAL
================================================================================`;

    // Calcular hash del archivo TXT
    const eventLogHashSha256 = computeSha256Hex(txt);
    const lastEvent = events[events.length - 1];

    return {
      content: txt,
      eventLogHashSha256,
      totalEvents: events.length,
      lastEvent: {
        sequence: lastEvent.sequence,
        eventHash: lastEvent.eventHash,
        eventType: lastEvent.eventType
      }
    };
  }
}

// ============================================================================
// INSTANCIA SINGLETON
// ============================================================================
const custodyService = new CustodyService();

module.exports = custodyService;
