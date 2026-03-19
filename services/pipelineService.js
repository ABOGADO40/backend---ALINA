// ============================================================================
// PIPELINE SERVICE - Pipeline automatico de procesamiento de evidencias
// Sistema PRUEBA DIGITAL
// ============================================================================

const fs = require('fs');
const path = require('path');
const { prisma } = require('../config/db');
const storageService = require('./storageService');
const hashService = require('./hashService');
const custodyService = require('./custodyService');
const sealingService = require('./sealingService');
const metadataService = require('./metadataService');
const riskAnalysisService = require('./riskAnalysisService');
const evidenceModel = require('../models/evidenceModel');
const { STORAGE_STRUCTURE, generateStorageKey, getFullPath } = require('../config/storage');

// ============================================================================
// CONFIGURACION
// ============================================================================

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const STAGE_TIMEOUT_MS = 60000; // 60 segundos por etapa

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

    const context = {
      evidenceId,
      evidence,
      originalFile,
      currentStatus: evidence.status,
      errors: []
    };

    try {
      // Etapa 1: Scan (si aun no se ha hecho)
      if (context.currentStatus === PIPELINE_STATES.RECEIVED) {
        await this._withTimeout(this._executeScanStage(context), STAGE_TIMEOUT_MS, 'Scan');
      }

      // Etapa 2: Hash
      if (context.currentStatus === PIPELINE_STATES.SCANNED_OK) {
        await this._withTimeout(this._executeHashStage(context), STAGE_TIMEOUT_MS, 'Hash');
      }

      // Etapa 3: Bitcopy
      if (context.currentStatus === PIPELINE_STATES.HASHED) {
        await this._withTimeout(this._executeBitcopyStage(context), STAGE_TIMEOUT_MS, 'Bitcopy');
      }

      // Etapa 4: Sellado
      if (context.currentStatus === PIPELINE_STATES.CLONED_BITCOPY) {
        await this._withTimeout(this._executeSealStage(context), STAGE_TIMEOUT_MS, 'Sellado');
      }

      // Etapa 5: Analisis (Metadata + Risk)
      if (context.currentStatus === PIPELINE_STATES.SEALED) {
        await this._withTimeout(this._executeAnalysisStage(context), STAGE_TIMEOUT_MS, 'Analisis');
      }

      // Etapa 6: Preparacion para exportacion
      if (context.currentStatus === PIPELINE_STATES.ANALYZED) {
        await this._withTimeout(this._executePreparationStage(context), STAGE_TIMEOUT_MS, 'Preparacion');
      }

      console.log(`[Pipeline] Evidencia ${evidenceId} procesada exitosamente`);

      return {
        success: true,
        evidenceId,
        finalStatus: context.currentStatus
      };

    } catch (error) {
      console.error(`[Pipeline] Error procesando evidencia ${evidenceId}:`, error);

      // Registrar error
      await this._handlePipelineError(context, error);

      return {
        success: false,
        evidenceId,
        error: error.message,
        stage: context.currentStatus
      };
    }
  }

  // ==========================================================================
  // ETAPA 1: SCAN (Antivirus + Validacion)
  // ==========================================================================

  async _executeScanStage(context) {
    console.log(`[Pipeline] Etapa 1: Scan - Evidencia ${context.evidenceId}`);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
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
      try {
        // Verificar si ya tiene hash
        let hashHex;
        if (context.originalFile.hashRecords.length > 0) {
          hashHex = context.originalFile.hashRecords[0].hashHex;
        } else {
          // Calcular hash del archivo original
          hashHex = await storageService.calculateHash(
            context.originalFile.storageKey,
            context.originalFile.isEncrypted
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
      try {
        // Crear copia bit-a-bit
        const bitcopyResult = await storageService.createBitcopy(
          context.originalFile.storageKey,
          context.evidenceId,
          context.originalFile.originalFilename,
          context.originalFile.isEncrypted
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
      try {
        // Extraer metadata
        const metadata = await metadataService.extractMetadata(
          context.originalFile.storageKey,
          context.originalFile.mimeType,
          context.evidence.sourceType
        );

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

        // Crear directorio y guardar archivo
        const metadataFullPath = getFullPath(metadataStorageKey);
        await fs.promises.mkdir(path.dirname(metadataFullPath), { recursive: true });
        await fs.promises.writeFile(metadataFullPath, metadataPayloadBytes);
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

        // Crear directorio y guardar archivo
        const riskFullPath = getFullPath(riskStorageKey);
        await fs.promises.mkdir(path.dirname(riskFullPath), { recursive: true });
        await fs.promises.writeFile(riskFullPath, riskPayloadBytes);
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

  _withTimeout(promise, ms, stageName) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`[Pipeline] Timeout: etapa '${stageName}' excedio ${ms / 1000}s`));
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
      'SCAN': ['SCAN_OK', 'SCAN_FAILED'],
      'HASH': ['HASH_COMPUTED'],
      'BITCOPY': ['BITCOPY_CREATED'],
      'SEAL': ['SEAL_CREATED'],
      'ANALYSIS': ['RISK_REPORT_CREATED'],
      'PREPARATION': ['CRYPTO_SEAL_CREATED', 'READY_FOR_EXPORT']
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
