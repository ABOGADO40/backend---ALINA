// ============================================================================
// PIPELINE SERVICE - Pipeline automatico de procesamiento de evidencias
// Sistema PRUEBA DIGITAL
// ============================================================================

const { prisma } = require('../config/db');
const storageService = require('./storageService');
const hashService = require('./hashService');
const custodyService = require('./custodyService');
const sealingService = require('./sealingService');
const metadataService = require('./metadataService');
const riskAnalysisService = require('./riskAnalysisService');
const evidenceModel = require('../models/evidenceModel');
const { STORAGE_STRUCTURE, generateStorageKey } = require('../config/storage');

// ============================================================================
// CONFIGURACION
// ============================================================================

const MAX_RETRIES = 2; // 2 reintentos (3 intentos totales) para no agotar timeout adaptativo
const RETRY_DELAY_MS = 3000; // 3 segundos entre reintentos
const STAGE_TIMEOUT_BASE_MS = 60000; // 60 segundos base por etapa

// Calculo adaptativo de timeout segun tamaño y tipo de etapa.
// Asume bandwidth efectivo conservador de 2 MB/s (Wasabi <-> Railway en condiciones lentas).
const ASSUMED_BANDWIDTH_BYTES_PER_SEC = 2 * 1024 * 1024;
const MAX_STAGE_TIMEOUT_MS = 30 * 60 * 1000; // Tope absoluto: 30 minutos por etapa
// Multiplicador por etapa segun cuantas operaciones de I/O ejecuta sobre el archivo completo
const STAGE_IO_MULTIPLIER = {
  Scan: 0, // Solo HEAD, no descarga
  Hash: 1, // Una descarga completa
  Bitcopy: 3, // Descarga + descifrado + cifrado + subida (~3 pasadas)
  Sellado: 1, // Lectura del original
  Analisis: 1, // Lectura del original (imagen completa; video limitado a 10MB)
  Preparacion: 0 // Solo metadata BD/storage
};

function _computeStageTimeout(stageName, fileSizeBytes = 0) {
  const multiplier = STAGE_IO_MULTIPLIER[stageName] ?? 1;
  const sizeFactor = (fileSizeBytes * multiplier) / ASSUMED_BANDWIDTH_BYTES_PER_SEC;
  const adaptive = sizeFactor * 1000; // a ms
  const total = STAGE_TIMEOUT_BASE_MS + adaptive;
  return Math.min(MAX_STAGE_TIMEOUT_MS, Math.max(STAGE_TIMEOUT_BASE_MS, total));
}

// Estados del pipeline
const PIPELINE_STATES = {
  RECEIVED: 'RECEIVED',
  SCANNED_OK: 'SCANNED_OK',
  HASHED: 'HASHED',
  CLONED_BITCOPY: 'CLONED_BITCOPY',
  SEALED: 'SEALED',
  ANALYZED: 'ANALYZED',
  READY_FOR_EXPORT: 'READY_FOR_EXPORT',
  ERROR: 'ERROR'
};

// ============================================================================
// CLASE DE SERVICIO DE PIPELINE
// ============================================================================

class PipelineService {
  // ==========================================================================
  // PROCESAR EVIDENCIA COMPLETA
  // ==========================================================================

  /**
   * Ejecuta el pipeline completo de procesamiento
   * @param {number} evidenceId - ID de la evidencia
   * @returns {Promise<Object>}
   */
  async processEvidence(evidenceId) {
    const pipelineStartedAt = Date.now();
    console.log(`[Pipeline] Iniciando procesamiento de evidencia ${evidenceId}`);

    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      include: {
        files: {
          where: { fileRole: 'ORIGINAL' },
          include: { hashRecords: true }
        }
      }
    });

    if (!evidence) {
      throw new Error('Evidencia no encontrada');
    }

    const originalFile = evidence.files[0];
    if (!originalFile) {
      throw new Error('Archivo original no encontrado');
    }

    // AbortController global del pipeline para propagar cancelacion a operaciones I/O
    const abortController = new AbortController();
    const fileSizeBytes = Number(originalFile.sizeBytes || 0);

    const context = {
      evidenceId,
      evidence,
      originalFile,
      currentStatus: evidence.status,
      errors: [],
      fileSizeBytes,
      abortSignal: abortController.signal,
      abortController
    };

    // Marcar inmediatamente como "en proceso" actualizando dateTimeModification
    // Esto evita que el worker la reclame mientras el pipeline esta arrancando
    await prisma.evidence.update({
      where: { id: evidenceId },
      data: { dateTimeModification: new Date() }
    }).catch(err => console.warn(`[Pipeline] No se pudo marcar evidencia ${evidenceId} al inicio:`, err.message));

    // Heartbeat: actualizar dateTimeModification cada 30s para que el worker no considere "atascada"
    const heartbeatTimer = setInterval(() => {
      prisma.evidence.update({
        where: { id: evidenceId },
        data: { dateTimeModification: new Date() }
      }).catch(err => console.warn(`[Pipeline] Heartbeat fallo para ${evidenceId}:`, err.message));
    }, 30000);

    const stageRun = (stageName, stageFn) => {
      const timeout = _computeStageTimeout(stageName, fileSizeBytes);
      console.log(`[Pipeline][${stageName}] Timeout adaptativo: ${(timeout / 1000).toFixed(1)}s (sizeBytes=${fileSizeBytes})`);
      const stageStartedAt = Date.now();
      return this._withTimeout(stageFn(context), timeout, stageName, abortController).then(result => {
        const duration = ((Date.now() - stageStartedAt) / 1000).toFixed(2);
        console.log(`[Pipeline][${stageName}] Completada en ${duration}s`);
        return result;
      });
    };

    try {
      // Etapa 1: Scan (si aun no se ha hecho)
      if (context.currentStatus === PIPELINE_STATES.RECEIVED) {
        await stageRun('Scan', (ctx) => this._executeScanStage(ctx));
      }

      // Etapa 2: Hash
      if (context.currentStatus === PIPELINE_STATES.SCANNED_OK) {
        await stageRun('Hash', (ctx) => this._executeHashStage(ctx));
      }

      // Etapa 3: Bitcopy
      if (context.currentStatus === PIPELINE_STATES.HASHED) {
        await stageRun('Bitcopy', (ctx) => this._executeBitcopyStage(ctx));
      }

      // Etapa 4: Sellado
      if (context.currentStatus === PIPELINE_STATES.CLONED_BITCOPY) {
        await stageRun('Sellado', (ctx) => this._executeSealStage(ctx));
      }

      // Etapa 5: Analisis (Metadata + Risk)
      if (context.currentStatus === PIPELINE_STATES.SEALED) {
        await stageRun('Analisis', (ctx) => this._executeAnalysisStage(ctx));
      }

      // Etapa 6: Preparacion para exportacion
      if (context.currentStatus === PIPELINE_STATES.ANALYZED) {
        await stageRun('Preparacion', (ctx) => this._executePreparationStage(ctx));
      }

      const totalDuration = ((Date.now() - pipelineStartedAt) / 1000).toFixed(2);
      console.log(`[Pipeline] Evidencia ${evidenceId} procesada exitosamente en ${totalDuration}s`);

      return {
        success: true,
        evidenceId,
        finalStatus: context.currentStatus,
        durationSeconds: parseFloat(totalDuration)
      };

    } catch (error) {
      const totalDuration = ((Date.now() - pipelineStartedAt) / 1000).toFixed(2);
      console.error(`[Pipeline] Error procesando evidencia ${evidenceId} (tras ${totalDuration}s, stage=${context.currentStatus}):`, error.message);

      // Cancelar operaciones I/O pendientes
      try { abortController.abort(); } catch (_) { /* noop */ }

      // Registrar error
      await this._handlePipelineError(context, error);

      return {
        success: false,
        evidenceId,
        error: error.message,
        stage: context.currentStatus,
        durationSeconds: parseFloat(totalDuration)
      };
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  // ==========================================================================
  // ETAPA 1: SCAN (Antivirus + Validacion)
  // ==========================================================================

  async _executeScanStage(context) {
    console.log(`[Pipeline] Etapa 1: Scan - Evidencia ${context.evidenceId}`);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (context.abortSignal?.aborted) throw new Error('Pipeline aborted');
      try {
        // Validacion de tipo de archivo
        const fileInfo = await storageService.getFileInfo(context.originalFile.storageKey);

        if (!fileInfo.exists) {
          throw new Error('Archivo original no encontrado en storage');
        }

        // Aqui iria la integracion con ClamAV para escaneo real
        // Por ahora, simulamos validacion basica
        const scanResult = {
          clean: true,
          scanEngine: 'basic-validation',
          scannedAtUtc: new Date().toISOString()
        };

        // Validacion adicional: verificar que no es ejecutable peligroso
        const { isBlockedExtension } = require('../config/storage');
        if (isBlockedExtension(context.originalFile.originalFilename)) {
          throw new Error('Tipo de archivo bloqueado por politica de seguridad');
        }

        // Actualizar estado
        await evidenceModel.updateStatus(context.evidenceId, PIPELINE_STATES.SCANNED_OK);
        context.currentStatus = PIPELINE_STATES.SCANNED_OK;

        // Registrar evento de custodia con payload segun requerimiento
        await custodyService.registerScan(context.evidenceId, scanResult);

        console.log(`[Pipeline] Scan completado para evidencia ${context.evidenceId}`);
        return;

      } catch (error) {
        console.error(`[Pipeline] Scan intento ${attempt}/${MAX_RETRIES} fallido:`, error);
        if (attempt === MAX_RETRIES) {
          await custodyService.registerScanFailed(context.evidenceId, {
            error: error.message,
            attempts: MAX_RETRIES
          });
          throw error;
        }
        await this._delay(RETRY_DELAY_MS);
      }
    }
  }

  // ==========================================================================
  // ETAPA 2: HASH DEL ORIGINAL
  // ==========================================================================

  async _executeHashStage(context) {
    console.log(`[Pipeline] Etapa 2: Hash - Evidencia ${context.evidenceId}`);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (context.abortSignal?.aborted) throw new Error('Pipeline aborted');
      try {
        // Verificar si ya tiene hash
        let hashHex;
        if (context.originalFile.hashRecords.length > 0) {
          hashHex = context.originalFile.hashRecords[0].hashHex;
        } else {
          // Calcular hash del archivo original (con cancelacion)
          hashHex = await storageService.calculateHash(
            context.originalFile.storageKey,
            context.originalFile.isEncrypted,
            context.abortSignal
          );

          // Guardar registro de hash
          await hashService.saveHashRecord(
            context.originalFile.id,
            hashHex,
            null // Sistema
          );
        }

        // Actualizar estado
        await evidenceModel.updateStatus(context.evidenceId, PIPELINE_STATES.HASHED);
        context.currentStatus = PIPELINE_STATES.HASHED;
        context.originalHash = hashHex;

        // Registrar evento de custodia con payload segun requerimiento
        await custodyService.registerHashCalculated(context.evidenceId, {
          algorithm: 'SHA-256',
          fileRole: 'ORIGINAL',
          evidenceSha256: hashHex
        });

        console.log(`[Pipeline] Hash calculado para evidencia ${context.evidenceId}: ${hashHex.substring(0, 16)}...`);
        return;

      } catch (error) {
        console.error(`[Pipeline] Hash intento ${attempt}/${MAX_RETRIES} fallido:`, error);
        if (attempt === MAX_RETRIES) throw error;
        await this._delay(RETRY_DELAY_MS);
      }
    }
  }

  // ==========================================================================
  // ETAPA 3: COPIA BIT-A-BIT
  // ==========================================================================

  async _executeBitcopyStage(context) {
    console.log(`[Pipeline] Etapa 3: Bitcopy - Evidencia ${context.evidenceId}`);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (context.abortSignal?.aborted) throw new Error('Pipeline aborted');
      try {
        // Crear copia bit-a-bit (con cancelacion propagada)
        const bitcopyResult = await storageService.createBitcopy(
          context.originalFile.storageKey,
          context.evidenceId,
          context.originalFile.originalFilename,
          context.originalFile.isEncrypted,
          context.abortSignal
        );

        // Obtener version actual
        const maxVersion = await evidenceModel.getMaxVersion(context.evidenceId, 'BITCOPY');

        // Crear registro de archivo
        const bitcopyFile = await evidenceModel.createEvidenceFile({
          evidenceId: context.evidenceId,
          fileRole: 'BITCOPY',
          version: maxVersion + 1,
          storageKey: bitcopyResult.storageKey,
          originalFilename: context.originalFile.originalFilename.replace(
            /(\.[^.]+)$/,
            '_bitcopy$1'
          ),
          mimeType: context.originalFile.mimeType,
          sizeBytes: bitcopyResult.sizeBytes,
          isEncrypted: true
        }, null);

        // Guardar hash de la copia
        await hashService.saveHashRecord(bitcopyFile.id, bitcopyResult.hash, null);

        // Verificar que el hash coincide con el original
        if (bitcopyResult.hash !== context.originalHash) {
          throw new Error('Hash de bitcopy no coincide con original');
        }

        // Actualizar estado
        await evidenceModel.updateStatus(context.evidenceId, PIPELINE_STATES.CLONED_BITCOPY);
        context.currentStatus = PIPELINE_STATES.CLONED_BITCOPY;

        // Registrar evento de custodia con payload segun requerimiento
        await custodyService.registerBitcopyCreated(context.evidenceId, {
          matchesOriginal: bitcopyResult.hash === context.originalHash,
          originalSha256: context.originalHash,
          bitcopySha256: bitcopyResult.hash,
          originalStorageObjectId: context.originalFile.storageKey,
          bitcopyStorageObjectId: bitcopyResult.storageKey,
          originalSizeBytes: Number(context.originalFile.sizeBytes),
          bitcopySizeBytes: bitcopyResult.sizeBytes
        });

        console.log(`[Pipeline] Bitcopy creado para evidencia ${context.evidenceId}`);
        return;

      } catch (error) {
        console.error(`[Pipeline] Bitcopy intento ${attempt}/${MAX_RETRIES} fallido:`, error);
        if (attempt === MAX_RETRIES) throw error;
        await this._delay(RETRY_DELAY_MS);
      }
    }
  }

  // ==========================================================================
  // ETAPA 4: SELLADO
  // ==========================================================================

  async _executeSealStage(context) {
    console.log(`[Pipeline] Etapa 4: Sellado - Evidencia ${context.evidenceId}`);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (context.abortSignal?.aborted) throw new Error('Pipeline aborted');
      try {
        // Obtener version actual
        const maxVersion = await evidenceModel.getMaxVersion(context.evidenceId, 'SEALED');
        const version = maxVersion + 1;

        // Sellar documento
        const sealResult = await sealingService.sealDocument(
          context.originalFile.storageKey,
          context.evidenceId,
          context.originalFile.mimeType,
          context.originalFile.originalFilename,
          context.originalHash,
          version
        );

        // Crear registro de archivo sellado
        const sealedFile = await evidenceModel.createEvidenceFile({
          evidenceId: context.evidenceId,
          fileRole: 'SEALED',
          version,
          storageKey: sealResult.storageKey,
          originalFilename: sealResult.filename,
          mimeType: sealResult.mimeType,
          sizeBytes: sealResult.sizeBytes,
          isEncrypted: sealResult.isEncrypted || false
        }, null);

        // Guardar hash del sellado
        await hashService.saveHashRecord(sealedFile.id, sealResult.hash, null);

        // Generar certificados
        const certs = await sealingService.generateCertificates(context.evidenceId, {
          title: context.evidence.title,
          sourceType: context.evidence.sourceType,
          originalFilename: context.originalFile.originalFilename,
          hashes: {
            original: context.originalHash,
            sealed: sealResult.hash
          },
          createdAt: context.evidence.createdAt
        }, version);

        // Guardar certificados
        for (const cert of certs) {
          const certFile = await evidenceModel.createEvidenceFile({
            evidenceId: context.evidenceId,
            fileRole: cert.fileRole,
            version,
            storageKey: cert.storageKey,
            originalFilename: cert.filename,
            mimeType: cert.mimeType,
            sizeBytes: cert.sizeBytes,
            isEncrypted: false
          }, null);

          await hashService.saveHashRecord(certFile.id, cert.hash, null);
        }

        // Actualizar estado
        await evidenceModel.updateStatus(context.evidenceId, PIPELINE_STATES.SEALED);
        context.currentStatus = PIPELINE_STATES.SEALED;

        // Registrar evento de custodia con payload segun requerimiento
        await custodyService.registerSealedDocCreated(context.evidenceId, {
          version,
          certificateRoles: certs.map(c => c.fileRole),
          certificatesGenerated: certs.length,
          sealedDocumentStorageObjectId: sealResult.storageKey,
          sealedDocumentHashSha256: sealResult.hash
        });

        console.log(`[Pipeline] Sellado completado para evidencia ${context.evidenceId}`);
        return;

      } catch (error) {
        console.error(`[Pipeline] Sellado intento ${attempt}/${MAX_RETRIES} fallido:`, error);
        if (attempt === MAX_RETRIES) throw error;
        await this._delay(RETRY_DELAY_MS);
      }
    }
  }

  // ==========================================================================
  // ETAPA 5: ANALISIS (METADATA + RIESGO)
  // ==========================================================================

  async _executeAnalysisStage(context) {
    console.log(`[Pipeline] Etapa 5: Analisis - Evidencia ${context.evidenceId}`);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (context.abortSignal?.aborted) throw new Error('Pipeline aborted');
      try {
        // Extraer metadata
        const metadata = await metadataService.extractMetadata(
          context.originalFile.storageKey,
          context.originalFile.mimeType,
          context.evidence.sourceType
        );

        // Recuperar fecha de modificacion del archivo segun filesystem del cliente
        // (capturada al momento del upload o import desde Google Drive)
        try {
          const uploadEvent = await prisma.custodyEvent.findFirst({
            where: {
              evidenceId: context.evidenceId,
              eventType: { in: ['UPLOAD', 'UPLOAD_GOOGLE_DRIVE'] }
            },
            orderBy: { sequence: 'asc' }
          });
          if (uploadEvent && uploadEvent.details) {
            const det = uploadEvent.details;
            const clientLm = det.clientFileLastModifiedIso || det.googleModifiedTime || null;
            const clientCreated = det.googleCreatedTime || null;
            if (!metadata.fileInfo) metadata.fileInfo = {};
            if (clientLm) metadata.fileInfo.clientFileLastModifiedIso = clientLm;
            if (clientCreated) metadata.fileInfo.clientFileCreatedIso = clientCreated;
          }
        } catch (fsDateErr) {
          console.warn('[Pipeline] No se pudo recuperar fecha del filesystem cliente:', fsDateErr.message);
        }

        // Guardar reporte de metadata en BD
        await metadataService.saveMetadataReport(context.evidenceId, metadata, null);

        // PERSISTIR payload de metadata en storage (inmutable)
        const metadataPayloadStr = JSON.stringify(metadata, null, 2);
        const metadataPayloadBytes = Buffer.from(metadataPayloadStr, 'utf8');
        const metadataPayloadHash = hashService.calculateFromBuffer(metadataPayloadBytes);
        const metadataStorageKey = generateStorageKey(
          STORAGE_STRUCTURE.DERIVED,
          context.evidenceId,
          'metadata.json'
        );

        // Guardar archivo en storage
        await storageService.putBuffer(metadataStorageKey, metadataPayloadBytes, 'application/json');
        console.log(`[Pipeline] Metadata payload persistido: ${metadataStorageKey}`);

        // Registrar evento de custodia con storageObjectId REAL
        await custodyService.registerMetadataExtracted(context.evidenceId, {
          hasWarnings: (metadata.warnings || []).length > 0,
          metadataTool: 'prueba-digital-metadata-extractor',
          metadataToolVersion: '1.0.0',
          metadataPayloadStorageObjectId: metadataStorageKey,
          metadataPayloadHashSha256: metadataPayloadHash
        });

        // Analizar riesgos/indicios
        const riskAnalysis = riskAnalysisService.analyze(
          context.evidence.sourceType,
          metadata
        );

        // Guardar reporte de riesgo en BD
        await riskAnalysisService.saveRiskReport(context.evidenceId, riskAnalysis, null);

        // PERSISTIR payload de risk report en storage (inmutable)
        const riskPayloadStr = JSON.stringify(riskAnalysis, null, 2);
        const riskPayloadBytes = Buffer.from(riskPayloadStr, 'utf8');
        const riskPayloadHash = hashService.calculateFromBuffer(riskPayloadBytes);
        const riskStorageKey = generateStorageKey(
          STORAGE_STRUCTURE.DERIVED,
          context.evidenceId,
          'risk_report.json'
        );

        // Guardar archivo en storage
        await storageService.putBuffer(riskStorageKey, riskPayloadBytes, 'application/json');
        console.log(`[Pipeline] Risk report payload persistido: ${riskStorageKey}`);

        // Actualizar estado
        await evidenceModel.updateStatus(context.evidenceId, PIPELINE_STATES.ANALYZED);
        context.currentStatus = PIPELINE_STATES.ANALYZED;

        // Registrar evento de custodia con storageObjectId REAL
        await custodyService.registerRiskReportCreated(context.evidenceId, {
          rulesTriggered: riskAnalysis.rulesTriggered.length,
          ruleIds: riskAnalysis.rulesTriggered.map(r => r.code || r.id || r.name),
          hasHighSeverity: riskAnalysis.rulesTriggered.some(r => r.severity === 'HIGH'),
          riskRulesetVersion: '1.0.0',
          riskReportPayloadStorageObjectId: riskStorageKey,
          riskReportPayloadHashSha256: riskPayloadHash
        });

        console.log(`[Pipeline] Analisis completado para evidencia ${context.evidenceId}`);
        return;

      } catch (error) {
        console.error(`[Pipeline] Analisis intento ${attempt}/${MAX_RETRIES} fallido:`, error);
        if (attempt === MAX_RETRIES) throw error;
        await this._delay(RETRY_DELAY_MS);
      }
    }
  }

  // ==========================================================================
  // ETAPA 6: PREPARACION PARA EXPORTACION
  // ==========================================================================

  async _executePreparationStage(context) {
    console.log(`[Pipeline] Etapa 6: Preparacion - Evidencia ${context.evidenceId}`);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (context.abortSignal?.aborted) throw new Error('Pipeline aborted');
      try {
        // Verificar que existen todos los componentes obligatorios
        const requiredRoles = ['ORIGINAL', 'BITCOPY', 'SEALED', 'CERT_PDF', 'CERT_TXT'];
        const files = await prisma.evidenceFile.findMany({
          where: { evidenceId: context.evidenceId }
        });

        const existingRoles = new Set(files.map(f => f.fileRole));
        const missingRoles = requiredRoles.filter(r => !existingRoles.has(r));

        if (missingRoles.length > 0) {
          throw new Error(`Componentes faltantes: ${missingRoles.join(', ')}`);
        }

        // Verificar reportes
        const metadataReport = await metadataService.getLatestReport(context.evidenceId);
        const riskReport = await riskAnalysisService.getLatestReport(context.evidenceId);

        if (!metadataReport || !riskReport) {
          throw new Error('Reportes de analisis faltantes');
        }

        // Verificar integridad de custodia
        const custodyIntegrity = await custodyService.verifyCustodyChainIntegrity(context.evidenceId);
        if (!custodyIntegrity.valid) {
          console.warn(`[Pipeline] Advertencia: Integridad de custodia con errores`);
        }

        // =====================================================================
        // FLUJO según requerimiento.txt:
        // 1. READY_EXPORT indica que el procesamiento terminó (evento N)
        // 2. CRYPTO_SEAL_CREATED certifica el eventlog con manifest firmado
        // 3. Después de CRYPTO_SEAL_CREATED, el eventlog queda SELLADO
        // =====================================================================

        // PASO 1: Registrar READY_EXPORT
        console.log(`[Pipeline][DEBUG] Registrando evento READY_EXPORT...`);
        const readyExportEvent = await custodyService.registerReadyExport(context.evidenceId);
        console.log(`[Pipeline][DEBUG] READY_EXPORT registrado: seq=${readyExportEvent.sequence}, hash=${readyExportEvent.eventHash.substring(0, 16)}...`);

        // PASO 2: Actualizar estado de la evidencia
        console.log(`[Pipeline][DEBUG] Actualizando status a READY_FOR_EXPORT...`);
        await evidenceModel.updateStatus(context.evidenceId, PIPELINE_STATES.READY_FOR_EXPORT);
        console.log(`[Pipeline][DEBUG] Status actualizado OK`);
        context.currentStatus = PIPELINE_STATES.READY_FOR_EXPORT;

        // PASO 3: Generar sello criptográfico (certifica READY_EXPORT como último evento)
        console.log(`[Pipeline][DEBUG] Generando sello criptográfico...`);
        const cryptoSeal = await sealingService.createCryptographicSeal(context.evidenceId);

        // Verificar que el manifest certifica READY_EXPORT
        console.log(`[Pipeline] Sello criptográfico generado:`);
        console.log(`[Pipeline]   - lastEventHash: ${cryptoSeal.manifestContent.lastEventHash?.substring(0, 16)}...`);
        console.log(`[Pipeline]   - lastEventSequence: ${cryptoSeal.manifestContent.lastEventSequence}`);
        console.log(`[Pipeline]   - Fingerprint: ${cryptoSeal.signingKeyFingerprint}`);

        // PASO 4: Registrar CRYPTO_SEAL_CREATED (único evento permitido después de READY_EXPORT)
        console.log(`[Pipeline][DEBUG] Registrando CRYPTO_SEAL_CREATED...`);
        await custodyService.registerCryptoSealCreated(context.evidenceId, {
          signatureAlgorithm: cryptoSeal.signatureAlgorithm,
          signedContent: cryptoSeal.signedContent,
          signatureEncoding: cryptoSeal.signatureEncoding,
          signature: cryptoSeal.signature,
          publicKeyPem: cryptoSeal.publicKeyPem,
          signingKeyFingerprint: cryptoSeal.signingKeyFingerprint,
          manifestHashSha256: cryptoSeal.manifestHashSha256,
          manifestContent: cryptoSeal.manifestContent
        });
        console.log(`[Pipeline][DEBUG] CRYPTO_SEAL_CREATED registrado OK`);

        console.log(`[Pipeline] Evidencia ${context.evidenceId} procesada y sellada.`);
        console.log(`[Pipeline] Eventlog cerrado. No se permiten más eventos.`);
        return;

      } catch (error) {
        console.error(`[Pipeline] Preparacion intento ${attempt}/${MAX_RETRIES} fallido:`, error);
        if (attempt === MAX_RETRIES) throw error;
        await this._delay(RETRY_DELAY_MS);
      }
    }
  }

  // ==========================================================================
  // MANEJO DE ERRORES
  // ==========================================================================

  async _handlePipelineError(context, error) {
    // 1. Actualizar estado (maxima prioridad)
    try {
      await prisma.evidence.update({
        where: { id: context.evidenceId },
        data: { status: PIPELINE_STATES.ERROR, dateTimeModification: new Date() }
      });
    } catch (e) {
      console.error('[Pipeline] CRITICO: No se pudo actualizar estado a ERROR:', e.message);
    }

    // 2. Registrar evento de custodia (secundario, independiente)
    try {
      await custodyService.registerError(context.evidenceId, {
        stage: context.currentStatus,
        error: error.message,
        stack: error.stack
      });
    } catch (e) {
      console.error('[Pipeline] Error registrando evento de custodia:', e.message);
    }
  }

  // ==========================================================================
  // UTILIDADES
  // ==========================================================================

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  _withTimeout(promise, ms, stageName, abortController = null) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Cancelar operaciones subyacentes para evitar huerfanos
        if (abortController && !abortController.signal.aborted) {
          try { abortController.abort(); } catch (_) { /* noop */ }
        }
        reject(new Error(`[Pipeline] Timeout: etapa '${stageName}' excedio ${(ms / 1000).toFixed(1)}s`));
      }, ms);

      promise
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * Obtiene el estado del pipeline de una evidencia
   * @param {number} evidenceId - ID de la evidencia
   * @returns {Promise<Object>}
   */
  async getPipelineStatus(evidenceId) {
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: {
        id: true,
        status: true,
        custodyEvents: {
          select: {
            eventType: true,
            eventAt: true
          },
          orderBy: { eventAt: 'asc' }
        }
      }
    });

    if (!evidence) return null;

    const stages = ['SCAN', 'HASH', 'BITCOPY', 'SEAL', 'ANALYSIS', 'PREPARATION'];
    const stageEventMap = {
      'SCAN': ['SCAN', 'SCAN_OK', 'SCAN_FAILED'],
      'HASH': ['HASH_CALCULATED', 'HASH_COMPUTED'],
      'BITCOPY': ['BITCOPY_CREATED'],
      'SEAL': ['SEALED_DOC_CREATED', 'SEAL_CREATED'],
      'ANALYSIS': ['METADATA_EXTRACTED', 'RISK_REPORT_CREATED', 'METADATA_CREATED'],
      'PREPARATION': ['CRYPTO_SEAL_CREATED', 'READY_EXPORT', 'READY_FOR_EXPORT']
    };

    const pipeline = {};
    for (const stage of stages) {
      const events = stageEventMap[stage];
      const stageEvent = evidence.custodyEvents.find(e => events.includes(e.eventType));
      pipeline[stage.toLowerCase()] = {
        completed: !!stageEvent,
        timestamp: stageEvent?.eventAt || null
      };
    }

    return {
      evidenceId,
      status: evidence.status,
      pipeline
    };
  }
}

// ============================================================================
// INSTANCIA SINGLETON
// ============================================================================
const pipelineService = new PipelineService();

module.exports = pipelineService;
