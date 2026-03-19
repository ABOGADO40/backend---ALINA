// ============================================================================
// VERIFICATION SERVICE - Verificacion forense completa de cadena de custodia
// Sistema PRUEBA DIGITAL
// Cumple: SWGDE, ISO/IEC 27037, NIST SP 800-86, RFC 8785 (JCS)
// ============================================================================

const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const forensicUtils = require('../utils/forensicUtils');
const signingService = require('./signingService');
const custodyService = require('./custodyService');
const storageService = require('./storageService');
const { getFullPath } = require('../config/storage');

const prisma = new PrismaClient();

// ============================================================================
// CLASE DE SERVICIO DE VERIFICACION
// ============================================================================

class VerificationService {
  /**
   * Verifica la integridad completa de una evidencia:
   * 1. Cadena de eventos (encadenamiento + hashes)
   * 2. eventlog.jsonl hash
   * 3. manifestHashSha256
   * 4. Firma Ed25519
   *
   * @param {string} evidenceUuid - UUID de la evidencia
   * @returns {Promise<Object>} Resultado completo de verificacion
   */
  async verifyChain(evidenceUuid) {
    const startTime = Date.now();
    const result = {
      evidenceUuid,
      verifiedAt: new Date().toISOString(),
      valid: true,
      checks: {
        eventChain: { valid: false, errors: [], details: {} },
        eventLogHash: { valid: false, errors: [], details: {} },
        manifestHash: { valid: false, errors: [], details: {} },
        manifestSignature: { valid: false, errors: [], details: {} },
        crossValidation: { valid: false, errors: [], details: {} },
        // Nuevos checks de storage (verificación profunda)
        originalFileHash: { valid: false, errors: [], details: {} },
        bitcopyFileHash: { valid: false, errors: [], details: {} },
        sealedFileHash: { valid: false, errors: [], details: {} },
        derivedFilesHash: { valid: false, errors: [], details: {} },
        eventlogFromStorage: { valid: false, errors: [], details: {} }
      },
      summary: {
        totalChecks: 10,
        passedChecks: 0,
        failedChecks: 0
      }
    };

    try {
      // 1. Obtener evidencia por UUID
      const evidence = await prisma.evidence.findUnique({
        where: { uuid: evidenceUuid },
        include: {
          files: {
            include: {
              hashRecords: { orderBy: { computedAt: 'desc' }, take: 1 }
            }
          }
        }
      });

      if (!evidence) {
        throw new Error(`Evidencia no encontrada: ${evidenceUuid}`);
      }

      result.evidenceId = evidence.id;

      // 2. VERIFICAR CADENA DE EVENTOS
      console.log(`[VerificationService] Verificando cadena de eventos...`);
      const chainResult = await this._verifyEventChain(evidence.id, evidenceUuid);
      result.checks.eventChain = chainResult;
      if (!chainResult.valid) result.valid = false;

      // 3. VERIFICAR HASH DEL EVENTLOG
      console.log(`[VerificationService] Verificando hash de eventlog...`);
      const eventlogResult = await this._verifyEventLogHash(evidence.id);
      result.checks.eventLogHash = eventlogResult;
      if (!eventlogResult.valid) result.valid = false;

      // 4. OBTENER CRYPTO_SEAL_CREATED (sello criptográfico con manifest firmado)
      // Soporta también MANIFEST_SIGNED para eventos legacy
      const manifestEvent = await prisma.custodyEvent.findFirst({
        where: {
          evidenceId: evidence.id,
          eventType: { in: ['CRYPTO_SEAL_CREATED', 'MANIFEST_SIGNED'] }
        },
        orderBy: { eventAt: 'desc' }
      });

      if (manifestEvent) {
        // 5. VERIFICAR HASH DEL MANIFEST
        console.log(`[VerificationService] Verificando hash de manifest...`);
        const manifestHashResult = await this._verifyManifestHash(evidence, manifestEvent);
        result.checks.manifestHash = manifestHashResult;
        if (!manifestHashResult.valid) result.valid = false;

        // 6. VERIFICAR FIRMA ED25519
        console.log(`[VerificationService] Verificando firma Ed25519...`);
        const signatureResult = await this._verifyManifestSignature(manifestEvent);
        result.checks.manifestSignature = signatureResult;
        if (!signatureResult.valid) result.valid = false;

        // 7. VERIFICACION CRUZADA
        console.log(`[VerificationService] Verificacion cruzada...`);
        const crossResult = await this._verifyCrossValidation(
          evidence.id,
          chainResult,
          eventlogResult,
          manifestEvent
        );
        result.checks.crossValidation = crossResult;
        if (!crossResult.valid) result.valid = false;

        // 8. VERIFICAR ORIGINAL DESDE STORAGE
        console.log(`[VerificationService] Verificando ORIGINAL desde storage...`);
        const originalResult = await this._verifyFileFromStorage(evidence, 'ORIGINAL');
        result.checks.originalFileHash = originalResult;
        if (!originalResult.valid) result.valid = false;

        // 9. VERIFICAR BITCOPY DESDE STORAGE
        console.log(`[VerificationService] Verificando BITCOPY desde storage...`);
        const bitcopyResult = await this._verifyFileFromStorage(evidence, 'BITCOPY');
        result.checks.bitcopyFileHash = bitcopyResult;
        if (!bitcopyResult.valid) result.valid = false;

        // 10. VERIFICAR SEALED DESDE STORAGE
        console.log(`[VerificationService] Verificando SEALED desde storage...`);
        const sealedResult = await this._verifyFileFromStorage(evidence, 'SEALED');
        result.checks.sealedFileHash = sealedResult;
        if (!sealedResult.valid) result.valid = false;

        // 11. VERIFICAR DERIVED FILES (metadata, risk report)
        console.log(`[VerificationService] Verificando archivos derivados...`);
        const derivedResult = await this._verifyDerivedFiles(evidence.id, manifestEvent);
        result.checks.derivedFilesHash = derivedResult;
        if (!derivedResult.valid) result.valid = false;

        // 12. VERIFICAR EVENTLOG DESDE STORAGE
        console.log(`[VerificationService] Verificando eventlog desde storage...`);
        const eventlogStorageResult = await this._verifyEventlogFromStorage(evidence.id, manifestEvent);
        result.checks.eventlogFromStorage = eventlogStorageResult;
        if (!eventlogStorageResult.valid) result.valid = false;
      } else {
        result.checks.manifestHash = {
          valid: false,
          errors: ['No se encontro evento CRYPTO_SEAL_CREATED'],
          details: { note: 'La evidencia no ha sido sellada criptograficamente' }
        };
        result.checks.manifestSignature = {
          valid: false,
          errors: ['No hay firma para verificar'],
          details: {}
        };
        result.checks.crossValidation = {
          valid: false,
          errors: ['No hay manifest para validacion cruzada'],
          details: {}
        };
        result.checks.originalFileHash = {
          valid: false,
          errors: ['No hay manifest para verificar hashes'],
          details: {}
        };
        result.checks.bitcopyFileHash = {
          valid: false,
          errors: ['No hay manifest para verificar hashes'],
          details: {}
        };
        result.checks.sealedFileHash = {
          valid: false,
          errors: ['No hay manifest para verificar hashes'],
          details: {}
        };
        result.checks.derivedFilesHash = {
          valid: false,
          errors: ['No hay manifest para verificar hashes'],
          details: {}
        };
        result.checks.eventlogFromStorage = {
          valid: false,
          errors: ['No hay manifest para verificar eventlog'],
          details: {}
        };
        result.valid = false;
      }

      // Calcular resumen
      for (const [checkName, checkResult] of Object.entries(result.checks)) {
        if (checkResult.valid) {
          result.summary.passedChecks++;
        } else {
          result.summary.failedChecks++;
        }
      }

      result.durationMs = Date.now() - startTime;
      console.log(`[VerificationService] Verificacion completada en ${result.durationMs}ms: ${result.valid ? 'VALIDA' : 'FALLIDA'}`);

      return result;

    } catch (error) {
      result.valid = false;
      result.error = error.message;
      result.durationMs = Date.now() - startTime;
      console.error(`[VerificationService] Error en verificacion:`, error);
      return result;
    }
  }

  /**
   * Verifica la cadena de eventos: sequence, prevEventHash, eventHash
   */
  async _verifyEventChain(evidenceId, evidenceUuid) {
    const events = await custodyService.getCustodyChain(evidenceId);
    const errors = [];
    const details = {
      totalEvents: events.length,
      firstEventSequence: events[0]?.sequence,
      lastEventSequence: events[events.length - 1]?.sequence,
      lastEventHash: events[events.length - 1]?.eventHash
    };

    if (events.length === 0) {
      return {
        valid: false,
        errors: ['No hay eventos en la cadena'],
        details
      };
    }

    // Verificar primer evento usa genesis hash o null
    const firstPrev = events[0].prevEventHash;
    if (firstPrev !== forensicUtils.GENESIS_HASH && firstPrev !== null) {
      errors.push(`Primer evento tiene prevEventHash invalido: ${firstPrev?.substring(0, 16)}...`);
    }

    // Verificar cada evento
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const expectedSeq = i + 1;

      // Verificar sequence
      if (event.sequence !== expectedSeq) {
        errors.push(`Evento ${i}: sequence esperado ${expectedSeq}, encontrado ${event.sequence}`);
      }

      // Verificar prevEventHash (desde evento 2)
      if (i > 0 && event.prevEventHash !== events[i - 1].eventHash) {
        errors.push(`Evento seq=${event.sequence}: prevEventHash no coincide con hash del evento anterior`);
      }

      // Recalcular hash para eventos JCS
      if (event.eventCanonicalization === 'JCS-RFC8785') {
        try {
          // Fase 4: Usar actorDisplayName de columna normalizada
          // Soporta eventos legacy que aun tienen details._actor
          const actor = event.details?._actor || {
            type: event.actorType,
            id: event.actorUserId || null,
            displayName: event.actorDisplayName || null
          };

          // Payload limpio (sin _actor si existe en eventos legacy)
          const payload = { ...(event.details || {}) };
          delete payload._actor;

          const eventForHash = forensicUtils.buildEventForHash({
            eventId: event.eventUuid,
            evidenceUuid,
            caseId: event.details?.caseId || null,
            eventType: event.eventType,
            occurredAtUtc: event.eventAt.toISOString(),
            actor,
            sequence: event.sequence,
            prevEventHash: event.prevEventHash || forensicUtils.GENESIS_HASH,
            payload
          });

          const computed = forensicUtils.computeEventHash(eventForHash);

          if (computed !== event.eventHash) {
            errors.push(`Evento seq=${event.sequence}: eventHash no coincide (esperado: ${event.eventHash?.substring(0, 16)}..., calculado: ${computed.substring(0, 16)}...)`);
          }
        } catch (err) {
          errors.push(`Evento seq=${event.sequence}: Error recalculando hash: ${err.message}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      details
    };
  }

  /**
   * Verifica el hash del eventlog.jsonl
   */
  async _verifyEventLogHash(evidenceId) {
    const errors = [];
    const details = {};

    try {
      const { content, eventLogHashSha256 } = await custodyService.exportCustodyAsJsonl(evidenceId);

      // Recalcular hash
      const computed = forensicUtils.computeSha256Hex(content);
      details.computedHash = computed;
      details.expectedHash = eventLogHashSha256;
      details.contentLength = content.length;

      if (computed !== eventLogHashSha256) {
        errors.push(`eventLogHash no coincide: esperado ${eventLogHashSha256?.substring(0, 16)}..., calculado ${computed.substring(0, 16)}...`);
      }

      return {
        valid: errors.length === 0,
        errors,
        details
      };
    } catch (err) {
      return {
        valid: false,
        errors: [`Error generando eventlog: ${err.message}`],
        details
      };
    }
  }

  /**
   * Verifica el hash del manifest reconstruyendolo
   */
  async _verifyManifestHash(evidence, manifestEvent) {
    const errors = [];
    const details = {};

    try {
      const manifestDetails = manifestEvent.details || {};
      details.storedManifestHash = manifestDetails.manifestHashSha256;

      // Obtener datos para reconstruir manifest
      const originalFile = evidence.files?.find(f => f.fileRole === 'ORIGINAL');
      const bitcopyFile = evidence.files?.find(f => f.fileRole === 'BITCOPY');
      const sealedFile = evidence.files?.find(f => f.fileRole === 'SEALED');

      // Obtener hashes de metadata y risk
      const metadataEvent = await prisma.custodyEvent.findFirst({
        where: { evidenceId: evidence.id, eventType: 'METADATA_CREATED' },
        orderBy: { eventAt: 'desc' }
      });

      const riskEvent = await prisma.custodyEvent.findFirst({
        where: { evidenceId: evidence.id, eventType: 'RISK_REPORT_CREATED' },
        orderBy: { eventAt: 'desc' }
      });

      // Reconstruir manifestContent (checklist H)
      const originalSizeBytes = originalFile ? Number(originalFile.sizeBytes) : null;

      // Parsear details como objeto si es string
      const parseDetails = (d) => {
        if (!d) return null;
        if (typeof d === 'string') {
          try { return JSON.parse(d); } catch { return null; }
        }
        return d;
      };

      const metadataDetails = parseDetails(metadataEvent?.details);
      const riskDetails = parseDetails(riskEvent?.details);

      // Extraer eventLogHashSha256 de la estructura correcta (puede ser objeto o string)
      const manifestContent_ = manifestDetails.manifestContent || manifestDetails;
      const eventLogHash = manifestContent_.eventlog?.hashSha256 ||
                           manifestDetails.eventLogHashSha256;

      const manifestContent = forensicUtils.buildManifestContent({
        version: '1.0',
        evidenceUuid: evidence.uuid,
        caseId: evidence.caseId,
        original: originalFile ? {
          storageObjectId: originalFile.storageKey,
          sha256: originalFile.hashRecords?.[0]?.hashHex || null,
          sizeBytes: originalSizeBytes,
          mimeDetected: originalFile.mimeType
        } : null,
        bitcopy: bitcopyFile ? {
          storageObjectId: bitcopyFile.storageKey,
          sha256: bitcopyFile.hashRecords?.[0]?.hashHex || null,
          sizeBytes: Number(bitcopyFile.sizeBytes)
        } : null,
        sealedDocument: sealedFile ? {
          storageObjectId: sealedFile.storageKey,
          sha256: sealedFile.hashRecords?.[0]?.hashHex || null
        } : null,
        metadataPayloadHashSha256: metadataDetails?.metadataPayloadHashSha256 || null,
        metadataPayloadStorageObjectId: metadataDetails?.metadataPayloadStorageObjectId || null,
        riskReportPayloadHashSha256: riskDetails?.riskReportPayloadHashSha256 || null,
        riskReportPayloadStorageObjectId: riskDetails?.riskReportPayloadStorageObjectId || null,
        eventlog: {
          storageObjectId: manifestContent_.eventlog?.storageObjectId || null,
          hashSha256: eventLogHash
        },
        lastEventHash: manifestContent_.lastEventHash || manifestDetails.lastEventHash,
        lastEventSequence: manifestContent_.lastEventSequence || manifestDetails.lastEventSequence,
        sealedAtUtc: manifestContent_.sealedAtUtc || manifestEvent.eventAt?.toISOString()
      });

      // Calcular hash
      const computed = forensicUtils.computeManifestHash(manifestContent);
      details.computedHash = computed;

      if (computed !== manifestDetails.manifestHashSha256) {
        errors.push(`manifestHash no coincide: esperado ${manifestDetails.manifestHashSha256?.substring(0, 16)}..., calculado ${computed.substring(0, 16)}...`);
      }

      return {
        valid: errors.length === 0,
        errors,
        details
      };
    } catch (err) {
      return {
        valid: false,
        errors: [`Error verificando manifest: ${err.message}`],
        details
      };
    }
  }

  /**
   * Verifica la firma Ed25519 del manifest
   */
  async _verifyManifestSignature(manifestEvent) {
    const errors = [];
    const details = {};

    try {
      const manifestDetails = manifestEvent.details || {};

      details.signatureAlgorithm = manifestDetails.signatureAlgorithm;
      details.keyFingerprint = manifestDetails.publicKeyFingerprint;

      // Obtener clave publica
      let publicKeyPem;
      if (manifestDetails.publicKeyPem) {
        publicKeyPem = manifestDetails.publicKeyPem;
      } else {
        // Buscar por fingerprint en BD
        const keyRecord = await prisma.signingKey.findUnique({
          where: { fingerprint: manifestDetails.publicKeyFingerprint }
        });
        if (!keyRecord) {
          return {
            valid: false,
            errors: ['Clave publica no encontrada para verificar firma'],
            details
          };
        }
        publicKeyPem = keyRecord.publicKeyPem;
      }

      // Verificar firma (la firma es sobre el manifestHashSha256)
      const isValid = signingService.verifyManifestSignature(
        manifestDetails.manifestHashSha256,
        manifestDetails.signature,
        publicKeyPem
      );

      details.signatureValid = isValid;

      if (!isValid) {
        errors.push('Firma Ed25519 invalida');
      }

      return {
        valid: errors.length === 0,
        errors,
        details
      };
    } catch (err) {
      return {
        valid: false,
        errors: [`Error verificando firma: ${err.message}`],
        details
      };
    }
  }

  /**
   * Verificacion cruzada: lastEventHash en manifest debe coincidir con cadena
   */
  async _verifyCrossValidation(evidenceId, chainResult, eventlogResult, manifestEvent) {
    const errors = [];
    const details = {};

    try {
      const manifestDetails = manifestEvent.details || {};

      // Verificar lastEventHash coincide
      details.manifestLastEventHash = manifestDetails.lastEventHash;
      details.chainLastEventHash = chainResult.details?.lastEventHash;
      details.manifestLastEventSequence = manifestDetails.lastEventSequence;
      details.chainLastEventSequence = chainResult.details?.lastEventSequence;

      if (manifestDetails.lastEventHash !== chainResult.details?.lastEventHash) {
        errors.push(`lastEventHash en manifest (${manifestDetails.lastEventHash?.substring(0, 16)}...) no coincide con cadena (${chainResult.details?.lastEventHash?.substring(0, 16)}...)`);
      }

      // Verificar eventLogHash coincide (soporta estructura nueva y legacy)
      const manifestEventLogHash = manifestDetails.eventlog?.hashSha256 ||
                                   manifestDetails.eventLogHashSha256;
      details.manifestEventLogHash = manifestEventLogHash;
      details.computedEventLogHash = eventlogResult.details?.computedHash;

      if (manifestEventLogHash !== eventlogResult.details?.computedHash) {
        errors.push(`eventLogHash en manifest no coincide con eventlog actual`);
      }

      return {
        valid: errors.length === 0,
        errors,
        details
      };
    } catch (err) {
      return {
        valid: false,
        errors: [`Error en validacion cruzada: ${err.message}`],
        details
      };
    }
  }

  // ==========================================================================
  // VERIFICACION DE ARCHIVOS DESDE STORAGE (CHECKS 6-10)
  // ==========================================================================

  /**
   * Verifica un archivo desde storage recalculando su hash SHA-256
   * @param {Object} evidence - Evidencia con files incluidos
   * @param {string} fileRole - ORIGINAL, BITCOPY, SEALED
   * @returns {Promise<Object>} Resultado de verificacion
   */
  async _verifyFileFromStorage(evidence, fileRole) {
    const errors = [];
    const details = { fileRole };

    try {
      const file = evidence.files?.find(f => f.fileRole === fileRole);

      if (!file) {
        return {
          valid: true, // No es error si el archivo no existe
          errors: [],
          details: { fileRole, note: `Archivo ${fileRole} no existe`, skipped: true }
        };
      }

      details.storageKey = file.storageKey;
      details.expectedHash = file.hashRecords?.[0]?.hashHex || null;
      details.sizeBytes = Number(file.sizeBytes);
      details.isEncrypted = file.isEncrypted;

      if (!details.expectedHash) {
        errors.push(`No hay hash registrado para ${fileRole}`);
        return { valid: false, errors, details };
      }

      // Calcular hash desde storage (bytes reales)
      const computedHash = await storageService.calculateHash(
        file.storageKey,
        file.isEncrypted
      );

      details.computedHash = computedHash;
      details.hashMatch = computedHash === details.expectedHash;

      if (!details.hashMatch) {
        errors.push(`${fileRole}: Hash no coincide (storage: ${computedHash.substring(0, 16)}..., DB: ${details.expectedHash.substring(0, 16)}...)`);
      }

      // Para BITCOPY, verificar que coincide con ORIGINAL
      if (fileRole === 'BITCOPY') {
        const originalFile = evidence.files?.find(f => f.fileRole === 'ORIGINAL');
        const originalHash = originalFile?.hashRecords?.[0]?.hashHex;
        details.originalHash = originalHash;
        details.matchesOriginal = computedHash === originalHash;

        if (originalHash && computedHash !== originalHash) {
          errors.push('BITCOPY no coincide con ORIGINAL (no es copia bit-a-bit valida)');
        }
      }

      return {
        valid: errors.length === 0,
        errors,
        details
      };

    } catch (err) {
      return {
        valid: false,
        errors: [`Error leyendo ${fileRole} desde storage: ${err.message}`],
        details
      };
    }
  }

  /**
   * Verifica archivos derivados (metadata, risk report) desde storage
   * @param {number} evidenceId - ID de evidencia
   * @param {Object} manifestEvent - Evento CRYPTO_SEAL_CREATED
   * @returns {Promise<Object>} Resultado de verificacion
   */
  async _verifyDerivedFiles(evidenceId, manifestEvent) {
    const errors = [];
    const details = { metadataCheck: null, riskReportCheck: null };

    try {
      const manifestDetails = manifestEvent.details || {};
      const manifestContent = manifestDetails.manifestContent || manifestDetails;

      // Verificar metadata payload
      const metadataStorageId = manifestContent.metadataPayloadStorageObjectId;
      const metadataExpectedHash = manifestContent.metadataPayloadHashSha256;

      if (metadataStorageId && metadataExpectedHash) {
        details.metadataCheck = { storageObjectId: metadataStorageId, expectedHash: metadataExpectedHash };

        try {
          const fullPath = getFullPath(metadataStorageId);
          if (fs.existsSync(fullPath)) {
            const content = await fs.promises.readFile(fullPath, 'utf8');
            const computedHash = forensicUtils.computeSha256Hex(content);
            details.metadataCheck.computedHash = computedHash;
            details.metadataCheck.valid = computedHash === metadataExpectedHash;

            if (!details.metadataCheck.valid) {
              errors.push(`Metadata payload hash no coincide`);
            }
          } else {
            details.metadataCheck.error = 'Archivo no encontrado en storage';
            errors.push(`Metadata payload no encontrado: ${metadataStorageId}`);
          }
        } catch (err) {
          details.metadataCheck.error = err.message;
          errors.push(`Error verificando metadata: ${err.message}`);
        }
      } else {
        details.metadataCheck = { skipped: true, reason: 'No metadataPayloadStorageObjectId en manifest' };
      }

      // Verificar risk report payload
      const riskStorageId = manifestContent.riskReportPayloadStorageObjectId;
      const riskExpectedHash = manifestContent.riskReportPayloadHashSha256;

      if (riskStorageId && riskExpectedHash) {
        details.riskReportCheck = { storageObjectId: riskStorageId, expectedHash: riskExpectedHash };

        try {
          const fullPath = getFullPath(riskStorageId);
          if (fs.existsSync(fullPath)) {
            const content = await fs.promises.readFile(fullPath, 'utf8');
            const computedHash = forensicUtils.computeSha256Hex(content);
            details.riskReportCheck.computedHash = computedHash;
            details.riskReportCheck.valid = computedHash === riskExpectedHash;

            if (!details.riskReportCheck.valid) {
              errors.push(`Risk report payload hash no coincide`);
            }
          } else {
            details.riskReportCheck.error = 'Archivo no encontrado en storage';
            errors.push(`Risk report no encontrado: ${riskStorageId}`);
          }
        } catch (err) {
          details.riskReportCheck.error = err.message;
          errors.push(`Error verificando risk report: ${err.message}`);
        }
      } else {
        details.riskReportCheck = { skipped: true, reason: 'No riskReportPayloadStorageObjectId en manifest' };
      }

      // Si ambos fueron omitidos, marcar como valido (no es error)
      const metadataSkipped = details.metadataCheck?.skipped;
      const riskSkipped = details.riskReportCheck?.skipped;

      if (metadataSkipped && riskSkipped) {
        return { valid: true, errors: [], details };
      }

      return {
        valid: errors.length === 0,
        errors,
        details
      };

    } catch (err) {
      return {
        valid: false,
        errors: [`Error verificando archivos derivados: ${err.message}`],
        details
      };
    }
  }

  /**
   * Verifica eventlog.jsonl desde storage (no regenerado desde DB)
   * @param {number} evidenceId - ID de evidencia
   * @param {Object} manifestEvent - Evento CRYPTO_SEAL_CREATED
   * @returns {Promise<Object>} Resultado de verificacion
   */
  async _verifyEventlogFromStorage(evidenceId, manifestEvent) {
    const errors = [];
    const details = {};

    try {
      const manifestDetails = manifestEvent.details || {};
      const manifestContent = manifestDetails.manifestContent || manifestDetails;

      const eventlogStorageId = manifestContent.eventlog?.storageObjectId;
      const eventlogExpectedHash = manifestContent.eventlog?.hashSha256 ||
                                   manifestContent.eventLogHashSha256;

      if (!eventlogStorageId) {
        return {
          valid: true,
          errors: [],
          details: { skipped: true, reason: 'No eventlog.storageObjectId en manifest (legacy)' }
        };
      }

      details.storageObjectId = eventlogStorageId;
      details.expectedHash = eventlogExpectedHash;

      const fullPath = getFullPath(eventlogStorageId);

      if (!fs.existsSync(fullPath)) {
        errors.push(`Eventlog no encontrado en storage: ${eventlogStorageId}`);
        return { valid: false, errors, details };
      }

      // Leer eventlog desde storage
      const content = await fs.promises.readFile(fullPath, 'utf8');
      const computedHash = forensicUtils.computeSha256Hex(content);

      details.computedHash = computedHash;
      details.contentLength = content.length;
      details.linesCount = content.trim().split('\n').length;

      if (computedHash !== eventlogExpectedHash) {
        errors.push(`Eventlog hash no coincide (storage: ${computedHash.substring(0, 16)}..., manifest: ${eventlogExpectedHash.substring(0, 16)}...)`);
      }

      // Verificar que el ultimo evento en el archivo coincide con manifest
      const lines = content.trim().split('\n');
      const lastEventLine = lines[lines.length - 1];
      const lastEvent = JSON.parse(lastEventLine);

      details.lastEventInFile = {
        sequence: lastEvent.sequence,
        eventType: lastEvent.eventType,
        eventHash: lastEvent.eventHash?.substring(0, 16) + '...'
      };

      if (manifestContent.lastEventSequence && lastEvent.sequence !== manifestContent.lastEventSequence) {
        errors.push(`Ultimo evento en archivo (seq=${lastEvent.sequence}) no coincide con manifest (seq=${manifestContent.lastEventSequence})`);
      }

      if (manifestContent.lastEventHash && lastEvent.eventHash !== manifestContent.lastEventHash) {
        errors.push(`Hash de ultimo evento no coincide con manifest`);
      }

      return {
        valid: errors.length === 0,
        errors,
        details
      };

    } catch (err) {
      return {
        valid: false,
        errors: [`Error verificando eventlog desde storage: ${err.message}`],
        details
      };
    }
  }

  // ==========================================================================
  // FIN DE CHECKS DE STORAGE
  // ==========================================================================

  /**
   * Obtiene un resumen rapido de integridad sin verificacion completa
   */
  async getIntegrityStatus(evidenceId) {
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: { uuid: true, status: true }
    });

    if (!evidence) {
      return { found: false };
    }

    const custodyIntegrity = await custodyService.verifyCustodyChainIntegrity(evidenceId);

    const manifestEvent = await prisma.custodyEvent.findFirst({
      where: {
        evidenceId,
        eventType: { in: ['CRYPTO_SEAL_CREATED', 'MANIFEST_SIGNED'] }
      },
      orderBy: { eventAt: 'desc' }
    });

    return {
      found: true,
      evidenceUuid: evidence.uuid,
      status: evidence.status,
      chainIntegrity: custodyIntegrity.valid,
      chainErrors: custodyIntegrity.errors.length,
      lastEvent: custodyIntegrity.lastEvent,
      hasSealedManifest: !!manifestEvent,
      manifestSignedAt: manifestEvent?.eventAt || null
    };
  }

  // ==========================================================================
  // VERIFICADOR COMPLETO - CHECKLIST L
  // ==========================================================================

  /**
   * Verifica un paquete de evidencia completo (checklist L).
   * Implementa la interfaz exacta requerida:
   * - L1) Leer eventos ordenados por sequence
   * - L2) Recalcular eventHash de cada evento y comparar
   * - L3) Verificar prevEventHash encadenado
   * - L4) Generar eventlog.jsonl, recalcular hash y comparar con manifest
   * - L5) Recalcular manifestHashSha256 y comparar
   * - L6) Verificar firma Ed25519 con publicKeyPem
   * - L7) Devolver resultado con PASS/FAIL y primer motivo de falla
   *
   * @param {string} evidenceUuid - UUID de la evidencia
   * @returns {Promise<{result: 'PASS'|'FAIL', firstFailureReason: string|null, details: Object}>}
   */
  async verifyEvidencePackage(evidenceUuid) {
    console.log(`[VerificationService] verifyEvidencePackage iniciado para ${evidenceUuid}`);

    // Ejecutar verificacion completa
    const fullResult = await this.verifyChain(evidenceUuid);

    // Determinar resultado segun checklist L7
    if (fullResult.valid) {
      return {
        result: 'PASS',
        firstFailureReason: null,
        details: {
          evidenceUuid,
          verifiedAt: fullResult.verifiedAt,
          checksPerformed: Object.keys(fullResult.checks),
          summary: fullResult.summary
        }
      };
    }

    // Encontrar primer error
    let firstFailureReason = null;
    const checkOrder = [
      'eventChain',
      'eventLogHash',
      'manifestHash',
      'manifestSignature',
      'crossValidation',
      'originalFileHash',
      'bitcopyFileHash',
      'sealedFileHash',
      'derivedFilesHash',
      'eventlogFromStorage'
    ];

    for (const checkName of checkOrder) {
      const check = fullResult.checks[checkName];
      if (!check.valid && check.errors.length > 0) {
        firstFailureReason = `[${checkName}] ${check.errors[0]}`;
        break;
      }
    }

    if (!firstFailureReason && fullResult.error) {
      firstFailureReason = fullResult.error;
    }

    return {
      result: 'FAIL',
      firstFailureReason: firstFailureReason || 'Error desconocido en verificacion',
      details: {
        evidenceUuid,
        verifiedAt: fullResult.verifiedAt,
        failedChecks: Object.entries(fullResult.checks)
          .filter(([, v]) => !v.valid)
          .map(([k]) => k),
        summary: fullResult.summary
      }
    };
  }
}

// ============================================================================
// INSTANCIA SINGLETON
// ============================================================================
const verificationService = new VerificationService();

module.exports = verificationService;
