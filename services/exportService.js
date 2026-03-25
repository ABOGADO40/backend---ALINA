// ============================================================================
// EXPORT SERVICE - Generacion de ZIP forense cifrado
// Sistema PRUEBA DIGITAL
// ============================================================================

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { prisma } = require('../config/db');
const storageService = require('./storageService');
const hashService = require('./hashService');
const custodyService = require('./custodyService');
const sealingService = require('./sealingService');
const signingService = require('./signingService');
const actaService = require('./actaService');
const forensicUtils = require('../utils/forensicUtils');
const { STORAGE_STRUCTURE, generateStorageKey, UPLOAD_BASE_DIR } = require('../config/storage');

// Registrar formato de ZIP encriptado
const archiverZipEncrypted = require('archiver-zip-encrypted');
archiver.registerFormat('zip-encrypted', archiverZipEncrypted);

// ============================================================================
// CLASE DE SERVICIO DE EXPORTACION
// ============================================================================

class ExportService {
  // ==========================================================================
  // CREAR EXPORTACION ZIP FORENSE
  // ==========================================================================

  /**
   * Crea un ZIP forense cifrado con todos los componentes obligatorios
   * @param {number} exportId - ID de la exportacion
   * @param {Array<number>} evidenceIds - IDs de las evidencias a incluir
   * @param {string} password - Contrasena para cifrar el ZIP
   * @param {number} userId - ID del usuario
   * @returns {Promise<Object>}
   */
  async createForensicZip(exportId, evidenceIds, password, userId) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const zipFilename = `export_${exportId}_${timestamp}.zip`;
    const storageKey = generateStorageKey(STORAGE_STRUCTURE.EXPORTS, exportId, zipFilename);
    const tempPath = path.join(UPLOAD_BASE_DIR, 'temp', `export_${exportId}_${Date.now()}.zip.tmp`);

    console.log(`[ExportService] Iniciando exportacion #${exportId}`);
    console.log(`[ExportService] Evidencias: ${evidenceIds.join(', ')}`);

    // Crear directorio temporal
    await fs.promises.mkdir(path.dirname(tempPath), { recursive: true });

    // Construir el ZIP
    const manifest = {
      exportId,
      createdAt: new Date().toISOString(),
      version: '1.0',
      totalEvidences: evidenceIds.length,
      contents: [],
      hashes: {}
    };

    // Crear archivo ZIP con cifrado ZipCrypto (compatible con Windows/Mac nativo)
    console.log(`[ExportService] Creando ZIP cifrado con ZipCrypto...`);
    const archive = archiver('zip-encrypted', {
      zlib: { level: 9 },
      encryptionMethod: 'zip20',
      password: password
    });

    // Registrar en el manifiesto que está protegido
    manifest.passwordProtected = true;
    manifest.encryptionMethod = 'ZipCrypto';

    const output = fs.createWriteStream(tempPath);

    // IMPORTANTE: Conectar pipe ANTES de agregar contenido
    archive.pipe(output);

    // Crear promesa para cuando termine
    const archivePromise = new Promise((resolve, reject) => {
      output.on('close', () => {
        console.log(`[ExportService] ZIP cerrado exitosamente`);
        resolve();
      });
      output.on('error', (err) => {
        console.error(`[ExportService] Error en output:`, err);
        reject(err);
      });
      archive.on('error', (err) => {
        console.error(`[ExportService] Error en archive:`, err);
        reject(err);
      });
    });

    // Procesar evidencias
    console.log(`[ExportService] Preparando contenido del ZIP...`);
    for (const evidenceId of evidenceIds) {
      await this._addEvidenceToArchive(archive, evidenceId, manifest);
    }

    // Agregar readme de verificacion
    const readme = this._generateReadme(manifest);
    archive.append(readme, { name: 'readme_verificacion.txt' });
    manifest.contents.push({
      path: 'readme_verificacion.txt',
      role: 'README',
      hash: hashService.calculateFromBuffer(readme)
    });

    // Agregar manifiesto
    const manifestJson = JSON.stringify(manifest, null, 2);
    archive.append(manifestJson, { name: 'manifest.txt' });

    // Finalizar y esperar
    console.log(`[ExportService] Finalizando archivo ZIP...`);
    archive.finalize();
    await archivePromise;

    // Read temp file and upload to S3
    const zipBuffer = await fs.promises.readFile(tempPath);
    await storageService.putBuffer(storageKey, zipBuffer, 'application/zip');
    // Clean up local temp
    await fs.promises.unlink(tempPath);
    const stats = { size: zipBuffer.length };
    console.log(`[ExportService] ZIP subido a S3: ${storageKey}`);
    console.log(`[ExportService] Tamano: ${stats.size} bytes`);

    // Calcular hash del ZIP desde buffer
    const zipHash = hashService.calculateFromBuffer(zipBuffer);
    console.log(`[ExportService] Hash: ${zipHash}`);

    // Crear registro de archivo en la base de datos
    // Usamos la primera evidencia como referencia para el EvidenceFile
    const primaryEvidenceId = evidenceIds[0];

    const evidenceFile = await prisma.evidenceFile.create({
      data: {
        evidenceId: primaryEvidenceId,
        fileRole: 'EXPORT_ZIP',
        version: 1,
        storageKey: storageKey,
        originalFilename: zipFilename,
        mimeType: 'application/zip',
        sizeBytes: BigInt(stats.size),
        isEncrypted: false,
        userIdRegistration: userId
      }
    });
    console.log(`[ExportService] EvidenceFile creado: #${evidenceFile.id}`);

    // Crear registro de hash
    await prisma.hashRecord.create({
      data: {
        evidenceFileId: evidenceFile.id,
        algorithm: 'SHA256',
        hashHex: zipHash,
        userIdRegistration: userId
      }
    });
    console.log(`[ExportService] HashRecord creado`);

    // =========================================================================
    // REGISTRO DE EXPORT EN AUDIT_LOG (NO en custody_events)
    // El eventlog queda cerrado con READY_EXPORT. No se agregan más eventos
    // de custody para preservar la integridad del manifest firmado.
    // =========================================================================
    for (const evidenceId of evidenceIds) {
      const evidence = await prisma.evidence.findUnique({
        where: { id: evidenceId },
        select: { uuid: true }
      });

      // Registrar en AuditLog en lugar de custody_events
      await prisma.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'EXPORT',
          entityType: 'Evidence',
          entityId: evidenceId,
          metadata: {
            exportId,
            requestedAtUtc: new Date().toISOString(),
            evidenceUuid: evidence.uuid,
            exportStorageObjectId: storageKey,
            exportPackageHashSha256: zipHash
          }
        }
      });
      console.log(`[ExportService] Export registrado en AuditLog para evidencia #${evidenceId}`);
    }

    console.log(`[ExportService] Exportacion #${exportId} completada exitosamente`);

    return {
      fileId: evidenceFile.id,
      storageKey,
      filename: zipFilename,
      sizeBytes: stats.size,
      hash: zipHash,
      manifest,
      isEncrypted: true // ZIP protegido con ZipCrypto
    };
  }

  // ==========================================================================
  // AGREGAR EVIDENCIA AL ARCHIVO
  // ==========================================================================

  async _addEvidenceToArchive(archive, evidenceId, manifest) {
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      include: {
        files: {
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
        }
      }
    });

    if (!evidence) return;

    const evidencePrefix = `evidence_${evidenceId}`;

    // 1. Original
    const originalFile = evidence.files.find(f => f.fileRole === 'ORIGINAL');
    if (originalFile) {
      await this._addFileToArchive(
        archive,
        originalFile,
        `${evidencePrefix}/01_original/${originalFile.originalFilename}`,
        manifest
      );
    }

    // 2. Bitcopy
    const bitcopyFile = evidence.files.find(f => f.fileRole === 'BITCOPY');
    if (bitcopyFile) {
      await this._addFileToArchive(
        archive,
        bitcopyFile,
        `${evidencePrefix}/02_bitcopy/${bitcopyFile.originalFilename}`,
        manifest
      );
    }

    // 3. Sealed
    const sealedFile = evidence.files.find(f => f.fileRole === 'SEALED');
    if (sealedFile) {
      await this._addFileToArchive(
        archive,
        sealedFile,
        `${evidencePrefix}/03_sealed/${sealedFile.originalFilename}`,
        manifest
      );
    }

    // 4. Certificados
    const certPdf = evidence.files.find(f => f.fileRole === 'CERT_PDF');
    // Buscar CERT_TXT primero, luego CERT_JSON para compatibilidad con archivos antiguos
    const certTxt = evidence.files.find(f => f.fileRole === 'CERT_TXT') ||
                    evidence.files.find(f => f.fileRole === 'CERT_JSON');

    if (certPdf) {
      await this._addFileToArchive(
        archive,
        certPdf,
        `${evidencePrefix}/04_cert/${certPdf.originalFilename}`,
        manifest
      );
    }

    if (certTxt) {
      // Si es CERT_JSON legacy, forzar extension .txt en el ZIP
      const certTxtFilename = certTxt.fileRole === 'CERT_JSON'
        ? certTxt.originalFilename.replace(/\.json$/i, '.txt')
        : certTxt.originalFilename;
      await this._addFileToArchive(
        archive,
        certTxt,
        `${evidencePrefix}/04_cert/${certTxtFilename}`,
        manifest
      );
    }

    // 5. Reportes (formato TXT legible)
    if (evidence.metadataReports[0]) {
      const metadataTxt = this._formatMetadataAsTxt(evidence.metadataReports[0].reportJson, evidence.metadataReports[0].version);
      archive.append(metadataTxt, {
        name: `${evidencePrefix}/05_reports/metadata_report_v${evidence.metadataReports[0].version}.txt`
      });
      manifest.contents.push({
        path: `${evidencePrefix}/05_reports/metadata_report_v${evidence.metadataReports[0].version}.txt`,
        role: 'METADATA_REPORT',
        hash: hashService.calculateFromBuffer(metadataTxt),
        version: evidence.metadataReports[0].version
      });
    }

    if (evidence.riskReports[0]) {
      const riskTxt = this._formatRiskReportAsTxt({
        rulesTriggered: evidence.riskReports[0].rulesTriggered,
        summary: evidence.riskReports[0].summary,
        createdAt: evidence.riskReports[0].createdAt
      }, evidence.riskReports[0].version);
      archive.append(riskTxt, {
        name: `${evidencePrefix}/05_reports/risk_report_v${evidence.riskReports[0].version}.txt`
      });
      manifest.contents.push({
        path: `${evidencePrefix}/05_reports/risk_report_v${evidence.riskReports[0].version}.txt`,
        role: 'RISK_REPORT',
        hash: hashService.calculateFromBuffer(riskTxt),
        version: evidence.riskReports[0].version
      });
    }

    // 6. Documentos de Actas (Tab "Actas" del frontend)
    // Incluye: Actas de Obtención, Certificado, Cadena de Custodia, Metadatos
    await this._addActasDocuments(archive, evidenceId, evidence, evidencePrefix, manifest);

    // 7. Kit de verificacion (formato oficial: eventlog.txt)
    const verificationKit = await this._buildVerificationKit(evidenceId, evidence);

    // eventlog.txt
    archive.append(verificationKit.eventlogTxt, {
      name: `${evidencePrefix}/07_verification/eventlog.txt`
    });
    manifest.contents.push({
      path: `${evidencePrefix}/07_verification/eventlog.txt`,
      role: 'EVENTLOG_TXT',
      hash: hashService.calculateFromBuffer(verificationKit.eventlogTxt)
    });

    // manifest.txt (criptografico)
    archive.append(verificationKit.manifestJson, {
      name: `${evidencePrefix}/07_verification/manifest.txt`
    });
    manifest.contents.push({
      path: `${evidencePrefix}/07_verification/manifest.txt`,
      role: 'CRYPTO_MANIFEST',
      hash: hashService.calculateFromBuffer(verificationKit.manifestJson)
    });

    // manifest.sig (firma Ed25519 base64)
    archive.append(verificationKit.signatureBase64, {
      name: `${evidencePrefix}/07_verification/manifest.sig`
    });
    manifest.contents.push({
      path: `${evidencePrefix}/07_verification/manifest.sig`,
      role: 'MANIFEST_SIGNATURE',
      hash: hashService.calculateFromBuffer(verificationKit.signatureBase64)
    });

    // public_key.pem
    archive.append(verificationKit.publicKeyPem, {
      name: `${evidencePrefix}/07_verification/public_key.pem`
    });
    manifest.contents.push({
      path: `${evidencePrefix}/07_verification/public_key.pem`,
      role: 'PUBLIC_KEY',
      hash: hashService.calculateFromBuffer(verificationKit.publicKeyPem)
    });

    // VERIFY.md
    archive.append(verificationKit.verifyMd, {
      name: `${evidencePrefix}/07_verification/VERIFY.md`
    });
    manifest.contents.push({
      path: `${evidencePrefix}/07_verification/VERIFY.md`,
      role: 'VERIFY_INSTRUCTIONS',
      hash: hashService.calculateFromBuffer(verificationKit.verifyMd)
    });
  }

  // ==========================================================================
  // AGREGAR DOCUMENTOS DE ACTAS AL ZIP
  // ==========================================================================

  /**
   * Agrega los 4 documentos del tab "Actas" al ZIP de exportación:
   * 1. Actas de Obtención de Evidencia Digital (generadas previamente)
   * 2. Certificado de Evidencia Digital (PDF)
   * 3. Reporte de Cadena de Custodia (PDF)
   * 4. Reporte de Metadatos (PDF)
   */
  async _addActasDocuments(archive, evidenceId, evidence, evidencePrefix, manifest) {
    console.log(`[ExportService] Agregando documentos de Actas para evidencia ${evidenceId}...`);

    const actasFolder = `${evidencePrefix}/06_actas`;

    try {
      // 1. Actas de Obtención de Evidencia Digital (ya generadas)
      const generatedActas = await prisma.generated_actas.findMany({
        where: { evidence_id: evidenceId },
        include: {
          evidence_contributor_records: true
        },
        orderBy: { generated_at: 'asc' }
      });

      for (const acta of generatedActas) {
        if (acta.pdf_storage_key) {
          try {
            if (await storageService.exists(acta.pdf_storage_key)) {
              const actaBuffer = await storageService.getBuffer(acta.pdf_storage_key);
              const actaFilename = `acta_obtencion_${acta.acta_numero || acta.id}.pdf`;
              archive.append(actaBuffer, { name: `${actasFolder}/01_actas_obtencion/${actaFilename}` });
              manifest.contents.push({
                path: `${actasFolder}/01_actas_obtencion/${actaFilename}`,
                role: 'ACTA_OBTENCION',
                actaNumero: acta.acta_numero,
                hash: acta.pdf_hash_sha256 || 'N/A'
              });
              console.log(`[ExportService] Acta de obtención agregada: ${actaFilename}`);
            }
          } catch (err) {
            console.warn(`[ExportService] Error agregando acta ${acta.id}:`, err.message);
          }
        }
      }

      // 2. Certificado de Evidencia Digital (generar PDF)
      try {
        const certResult = await actaService.generateCertificadoPdf(evidenceId, evidence.ownerUserId);
        if (await storageService.exists(certResult.storageKey)) {
          const certBuffer = await storageService.getBuffer(certResult.storageKey);
          archive.append(certBuffer, { name: `${actasFolder}/02_certificado/${certResult.filename}` });
          manifest.contents.push({
            path: `${actasFolder}/02_certificado/${certResult.filename}`,
            role: 'CERTIFICADO_EVIDENCIA_DIGITAL',
            certNumero: certResult.certNumero,
            hash: certResult.pdfHash
          });
          console.log(`[ExportService] Certificado de Evidencia Digital agregado: ${certResult.filename}`);
        }
      } catch (err) {
        console.warn(`[ExportService] Error generando Certificado de Evidencia Digital:`, err.message);
        manifest.contents.push({
          path: `${actasFolder}/02_certificado/`,
          role: 'CERTIFICADO_EVIDENCIA_DIGITAL',
          skipped: true,
          reason: err.message
        });
      }

      // 3. Reporte de Cadena de Custodia (generar PDF)
      try {
        const custodiaResult = await actaService.generateCadenaCustodiaPdf(evidenceId, evidence.ownerUserId);
        if (await storageService.exists(custodiaResult.storageKey)) {
          const custodiaBuffer = await storageService.getBuffer(custodiaResult.storageKey);
          archive.append(custodiaBuffer, { name: `${actasFolder}/03_cadena_custodia/${custodiaResult.filename}` });
          manifest.contents.push({
            path: `${actasFolder}/03_cadena_custodia/${custodiaResult.filename}`,
            role: 'REPORTE_CADENA_CUSTODIA',
            reporteNumero: custodiaResult.reporteNumero,
            hash: custodiaResult.pdfHash
          });
          console.log(`[ExportService] Reporte de Cadena de Custodia agregado: ${custodiaResult.filename}`);
        }
      } catch (err) {
        console.warn(`[ExportService] Error generando Reporte de Cadena de Custodia:`, err.message);
        manifest.contents.push({
          path: `${actasFolder}/03_cadena_custodia/`,
          role: 'REPORTE_CADENA_CUSTODIA',
          skipped: true,
          reason: err.message
        });
      }

      // 4. Reporte de Metadatos (generar PDF)
      try {
        const metadatosResult = await actaService.generateMetadatosPdf(evidenceId, evidence.ownerUserId);
        if (await storageService.exists(metadatosResult.storageKey)) {
          const metadatosBuffer = await storageService.getBuffer(metadatosResult.storageKey);
          archive.append(metadatosBuffer, { name: `${actasFolder}/04_metadatos/${metadatosResult.filename}` });
          manifest.contents.push({
            path: `${actasFolder}/04_metadatos/${metadatosResult.filename}`,
            role: 'REPORTE_METADATOS',
            reporteNumero: metadatosResult.reporteNumero,
            hash: metadatosResult.pdfHash
          });
          console.log(`[ExportService] Reporte de Metadatos agregado: ${metadatosResult.filename}`);
        }
      } catch (err) {
        console.warn(`[ExportService] Error generando Reporte de Metadatos:`, err.message);
        manifest.contents.push({
          path: `${actasFolder}/04_metadatos/`,
          role: 'REPORTE_METADATOS',
          skipped: true,
          reason: err.message
        });
      }

      console.log(`[ExportService] Documentos de Actas completados para evidencia ${evidenceId}`);
    } catch (error) {
      console.error(`[ExportService] Error agregando documentos de Actas:`, error);
    }
  }

  // ==========================================================================
  // AGREGAR ARCHIVO AL ZIP
  // ==========================================================================

  async _addFileToArchive(archive, fileRecord, archivePath, manifest) {
    try {
      // Verificar si el archivo existe en S3 antes de intentar agregarlo
      const actualKey = fileRecord.isEncrypted ? `${fileRecord.storageKey}.enc` : fileRecord.storageKey;

      if (!(await storageService.exists(actualKey))) {
        console.warn(`[ExportService] Archivo no existe, omitiendo: ${archivePath}`);
        manifest.contents.push({
          path: archivePath,
          role: fileRecord.fileRole,
          originalFilename: fileRecord.originalFilename,
          skipped: true,
          reason: 'Archivo no encontrado en storage'
        });
        return;
      }

      // Para archivos NO encriptados, descargar buffer desde S3
      if (!fileRecord.isEncrypted) {
        console.log(`[ExportService] Agregando archivo sin cifrar: ${archivePath}`);
        const buffer = await storageService.getBuffer(fileRecord.storageKey);
        archive.append(buffer, { name: archivePath });
      } else {
        // Para archivos encriptados, intentar descifrar
        // NOTA: Si el descifrado falla, agregamos placeholder con metadata
        console.log(`[ExportService] Intentando descifrar: ${archivePath}`);
        try {
          const stream = await storageService.getFileStream(
            fileRecord.storageKey,
            true // encrypted
          );

          // Leer el stream completo en buffer primero para verificar que funciona
          const chunks = [];
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error('Timeout leyendo archivo encriptado'));
            }, 30000);

            stream.on('data', chunk => chunks.push(chunk));
            stream.on('end', () => {
              clearTimeout(timeout);
              resolve();
            });
            stream.on('error', (err) => {
              clearTimeout(timeout);
              reject(err);
            });
          });

          const buffer = Buffer.concat(chunks);
          archive.append(buffer, { name: archivePath });
          console.log(`[ExportService] Archivo descifrado agregado: ${buffer.length} bytes`);

        } catch (decryptError) {
          // Descifrado fallo - agregar placeholder con informacion
          console.warn(`[ExportService] Error descifrando, agregando placeholder: ${decryptError.message}`);

          const placeholder = [
            '================================================================================',
            '  ARCHIVO ENCRIPTADO - NO SE PUDO DESCIFRAR PARA EXPORTACION',
            '================================================================================',
            '',
            `Archivo original: ${fileRecord.originalFilename}`,
            `Rol: ${fileRecord.fileRole}`,
            `Tipo MIME: ${fileRecord.mimeType}`,
            `Tamano: ${Number(fileRecord.sizeBytes)} bytes`,
            `Hash: ${fileRecord.hashRecords[0]?.hashHex || 'N/A'}`,
            `Error: ${decryptError.message}`,
            '',
            'NOTA: El archivo original esta almacenado de forma segura en el sistema.',
            'Contacte al administrador para recuperacion manual.',
            '',
            '================================================================================'
          ].join('\n');

          archive.append(placeholder, { name: `${archivePath}.NOT_DECRYPTED.txt` });

          manifest.contents.push({
            path: `${archivePath}.NOT_DECRYPTED.txt`,
            role: fileRecord.fileRole,
            originalFilename: fileRecord.originalFilename,
            decryptionFailed: true,
            error: decryptError.message,
            hash: fileRecord.hashRecords[0]?.hashHex || null
          });
          return;
        }
      }

      manifest.contents.push({
        path: archivePath,
        role: fileRecord.fileRole,
        originalFilename: fileRecord.originalFilename,
        mimeType: fileRecord.mimeType,
        sizeBytes: Number(fileRecord.sizeBytes),
        hash: fileRecord.hashRecords[0]?.hashHex || null,
        version: fileRecord.version
      });

      if (fileRecord.hashRecords[0]) {
        manifest.hashes[archivePath] = fileRecord.hashRecords[0].hashHex;
      }
    } catch (error) {
      console.error(`[ExportService] Error agregando archivo ${archivePath}:`, error.message);
      manifest.contents.push({
        path: archivePath,
        role: fileRecord.fileRole,
        error: error.message
      });
    }
  }

  // ==========================================================================
  // CONSTRUIR KIT DE VERIFICACION FORENSE
  // ==========================================================================

  /**
   * Construye el kit de verificación completo para una evidencia.
   *
   * FLUJO:
   * 1. Obtener el evento CRYPTO_SEAL_CREATED que ya contiene el manifest firmado
   * 2. LEER el eventlog.txt guardado durante el sellado (NO regenerar)
   * 3. Usar el manifest del CRYPTO_SEAL_CREATED (no generar uno nuevo)
   * 4. Incluir todo en el ZIP
   *
   * IMPORTANTE: El eventlog.txt incluye una fecha de generación que lo hace
   * no-determinístico. Por eso DEBEMOS leer el archivo guardado, no regenerarlo.
   *
   * @param {number} evidenceId - ID de la evidencia
   * @param {Object} evidence - Objeto evidence con relaciones
   * @returns {Promise<Object>} Kit con eventlog, manifest, signature, publicKey, verifyMd
   */
  async _buildVerificationKit(evidenceId, evidence) {
    console.log(`[ExportService] Construyendo kit de verificacion para evidencia #${evidenceId}...`);

    // Función helper para parsear details (defensivo: maneja string JSON o objeto)
    const parseDetails = (details) => {
      if (!details) return null;
      if (typeof details === 'string') {
        try {
          return JSON.parse(details);
        } catch (e) {
          console.error(`[ExportService] Error parseando details como JSON:`, e.message);
          return null;
        }
      }
      return details;
    };

    // 1. Obtener el evento CRYPTO_SEAL_CREATED que contiene el manifest firmado
    const cryptoSealEvent = await prisma.custodyEvent.findFirst({
      where: { evidenceId, eventType: 'CRYPTO_SEAL_CREATED' },
      orderBy: { eventAt: 'desc' },
      select: {
        id: true,
        eventType: true,
        details: true
      }
    });

    // Si no hay CRYPTO_SEAL_CREATED, generar kit de verificación simplificado
    if (!cryptoSealEvent) {
      console.warn(`[ExportService] ADVERTENCIA: No se encontró CRYPTO_SEAL_CREATED para evidencia #${evidenceId}. Generando kit simplificado...`);
      return await this._buildSimplifiedVerificationKit(evidenceId, evidence);
    }

    const cryptoSealDetails = parseDetails(cryptoSealEvent.details);
    if (!cryptoSealDetails || !cryptoSealDetails.manifestContent) {
      throw new Error(`[ExportService] ERROR: Evento CRYPTO_SEAL_CREATED no contiene manifestContent válido.`);
    }

    console.log(`[ExportService] CRYPTO_SEAL_CREATED encontrado:`);
    console.log(`[ExportService]   - manifestHashSha256: ${cryptoSealDetails.manifestHashSha256?.substring(0, 16)}...`);
    console.log(`[ExportService]   - lastEventSequence: ${cryptoSealDetails.manifestContent.lastEventSequence}`);

    // 2. LEER el eventlog.txt guardado durante el sellado (NO regenerar)
    // El eventlog incluye "Fecha de Generacion" que cambia si se regenera,
    // por lo que DEBEMOS leer el archivo original guardado en storage.
    const eventlogStorageObjectId = cryptoSealDetails.manifestContent.eventlog?.storageObjectId;
    const expectedHash = cryptoSealDetails.manifestContent.eventlog?.hashSha256;

    if (!eventlogStorageObjectId) {
      throw new Error(`[ExportService] ERROR: manifest no contiene eventlog.storageObjectId`);
    }

    console.log(`[ExportService] Leyendo eventlog desde storage: ${eventlogStorageObjectId}`);

    let eventlogTxt;

    try {
      eventlogTxt = await storageService.getString(eventlogStorageObjectId);
      console.log(`[ExportService] eventlog.txt leído: ${eventlogTxt.length} bytes`);
    } catch (readError) {
      console.error(`[ExportService] ERROR leyendo eventlog desde storage: ${readError.message}`);
      throw new Error(`No se pudo leer el eventlog guardado: ${eventlogStorageObjectId}`);
    }

    // Verificar hash del archivo leído
    const eventLogHashSha256 = hashService.calculateFromBuffer(eventlogTxt);
    console.log(`[ExportService] Hash del eventlog leído: ${eventLogHashSha256.substring(0, 16)}...`);

    // Obtener info del último evento certificado para logs
    const certifiedLastSequence = cryptoSealDetails.manifestContent.lastEventSequence;
    const lastEventHash = cryptoSealDetails.manifestContent.lastEventHash;

    console.log(`[ExportService] Último evento certificado: seq=${certifiedLastSequence}`);

    // Verificar que el hash coincide con el del manifest (sanity check)
    if (expectedHash && eventLogHashSha256 !== expectedHash) {
      console.error(`[ExportService] ERROR CRÍTICO: Hash de eventlog no coincide con manifest!`);
      console.error(`[ExportService]   Manifest: ${expectedHash}`);
      console.error(`[ExportService]   Calculado: ${eventLogHashSha256}`);
      throw new Error('Integridad comprometida: hash de eventlog no coincide con manifest certificado');
    }
    console.log(`[ExportService] Hash de eventlog verificado: ${eventLogHashSha256.substring(0, 16)}...`);

    // 3. Usar el manifest YA FIRMADO del evento CRYPTO_SEAL_CREATED
    // NO generamos nuevo manifest - usamos el que ya fue creado y firmado
    const manifestContent = cryptoSealDetails.manifestContent;
    const manifestHashSha256 = cryptoSealDetails.manifestHashSha256;
    const signature = cryptoSealDetails.signature;
    const publicKeyPem = cryptoSealDetails.publicKeyPem;
    const signingKeyFingerprint = cryptoSealDetails.signingKeyFingerprint;

    console.log(`[ExportService] Usando manifest del CRYPTO_SEAL_CREATED:`);
    console.log(`[ExportService]   - manifestHashSha256: ${manifestHashSha256.substring(0, 16)}...`);
    console.log(`[ExportService]   - lastEventSequence: ${manifestContent.lastEventSequence}`);
    console.log(`[ExportService]   - lastEventHash: ${manifestContent.lastEventHash?.substring(0, 16)}...`);

    // 4. Construir JSON del manifest completo (con metadatos de firma)
    // Exactamente como se guardó en CRYPTO_SEAL_CREATED
    const manifestWithSignature = {
      ...manifestContent,
      manifestHashSha256,
      signature,
      signatureAlgorithm: cryptoSealDetails.signatureAlgorithm || forensicUtils.SIGNATURE_ALGORITHM,
      signatureEncoding: cryptoSealDetails.signatureEncoding || forensicUtils.SIGNATURE_ENCODING,
      signedContent: cryptoSealDetails.signedContent || 'manifestHashSha256',
      signingKeyFingerprint
    };

    const manifestJson = JSON.stringify(manifestWithSignature, null, 2);

    console.log(`[ExportService] Manifest preparado para exportación`);
    console.log(`[ExportService] Verificación: lastEventSequence=${certifiedLastSequence}`);

    // 5. Generar VERIFY.md con instrucciones
    const verifyMd = this._generateVerifyMdForensic(evidence, manifestWithSignature, eventLogHashSha256);

    return {
      eventlogTxt,
      manifestJson,
      signatureBase64: signature,
      publicKeyPem,
      verifyMd,
      eventLogHashSha256,
      manifestHashSha256
    };
  }

  /**
   * Genera el archivo VERIFY.md con instrucciones de verificacion forense completas
   * @param {Object} evidence - Objeto evidence
   * @param {Object} manifest - Manifest con firma
   * @param {string} eventLogHashSha256 - Hash del eventlog.txt
   * @returns {string} Contenido del archivo VERIFY.md
   */
  _generateVerifyMdForensic(evidence, manifest, eventLogHashSha256) {
    return `# Guia de Verificacion Forense - PRUEBA DIGITAL

## Evidencia
- **Titulo**: ${evidence.title || 'N/A'}
- **UUID**: ${manifest.evidenceId}
- **Case ID**: ${manifest.caseId || 'N/A'}
- **Sellado**: ${manifest.sealedAtUtc}

---

## 1. Verificar Hash del Archivo Original (SHA-256)

El hash SHA-256 garantiza que el archivo no ha sido modificado.

### Hash esperado:
\`\`\`
${manifest.original?.sha256 || 'No disponible'}
\`\`\`

### Comandos para verificar:

**Linux/macOS:**
\`\`\`bash
sha256sum evidence_*/01_original/*
\`\`\`

**Windows PowerShell:**
\`\`\`powershell
Get-FileHash -Algorithm SHA256 evidence_*\\01_original\\*
\`\`\`

**Python:**
\`\`\`python
import hashlib
with open('archivo', 'rb') as f:
    print(hashlib.sha256(f.read()).hexdigest())
\`\`\`

El hash calculado DEBE coincidir exactamente con el esperado.

---

## 2. Verificar Hash de la Copia Bit-a-Bit

La copia bit-a-bit debe tener el mismo hash que el original.

### Hash esperado (debe ser identico al original):
\`\`\`
${manifest.bitcopy?.sha256 || 'No disponible'}
\`\`\`

---

## 3. Verificar Hash del eventlog.txt

El eventlog contiene todos los eventos de la cadena de custodia.

### Hash esperado:
\`\`\`
${eventLogHashSha256}
\`\`\`

### Comando:
\`\`\`bash
sha256sum eventlog.txt
\`\`\`

---

## 4. Verificar Hash del Manifest

### manifestHashSha256 esperado:
\`\`\`
${manifest.manifestHashSha256}
\`\`\`

### Recalcular usando JCS (RFC 8785):

\`\`\`javascript
const crypto = require('crypto');
const canonicalize = require('canonicalize'); // npm install canonicalize

// Leer manifest.txt y extraer solo el manifestContent (sin firma)
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync('manifest.txt', 'utf8'));

// Campos del manifestContent (excluir signature, signatureAlgorithm, etc.)
// IMPORTANTE: El orden de campos no importa - JCS ordena alfabéticamente
const manifestContent = {
  version: manifest.version,
  caseId: manifest.caseId,
  evidenceId: manifest.evidenceId,
  sealedAtUtc: manifest.sealedAtUtc,
  original: manifest.original,
  bitcopy: manifest.bitcopy,
  sealedDocument: manifest.sealedDocument,
  metadataPayloadHashSha256: manifest.metadataPayloadHashSha256,
  riskReportPayloadHashSha256: manifest.riskReportPayloadHashSha256,
  eventlog: manifest.eventlog,
  lastEventHash: manifest.lastEventHash,
  lastEventSequence: manifest.lastEventSequence
};

const canonical = canonicalize(manifestContent);
const hash = crypto.createHash('sha256').update(canonical).digest('hex');
console.log('manifestHashSha256 calculado:', hash);
console.log('Coincide:', hash === manifest.manifestHashSha256);
\`\`\`

---

## 5. Verificar Firma Ed25519 del Manifest

La firma Ed25519 garantiza que el manifest fue creado por el sistema autorizado.

### Datos de firma:
- **Algoritmo**: ${manifest.signatureAlgorithm}
- **Encoding**: ${manifest.signatureEncoding}
- **Contenido firmado**: ${manifest.signedContent} (se firma el hash, no el JSON completo)
- **Fingerprint clave**: ${manifest.signingKeyFingerprint}

### Verificar con Node.js:

\`\`\`javascript
const crypto = require('crypto');
const fs = require('fs');

const publicKeyPem = fs.readFileSync('public_key.pem', 'utf8');
const manifest = JSON.parse(fs.readFileSync('manifest.txt', 'utf8'));

// La firma es sobre el manifestHashSha256 (string UTF-8)
const dataToVerify = manifest.manifestHashSha256;
const signature = Buffer.from(manifest.signature, 'base64');

const isValid = crypto.verify(
  null, // Ed25519 no usa algoritmo de hash adicional
  Buffer.from(dataToVerify, 'utf8'),
  publicKeyPem,
  signature
);

console.log('Firma valida:', isValid);
\`\`\`

### Verificar con OpenSSL (Linux/macOS):

\`\`\`bash
# 1. Extraer el manifestHashSha256 del manifest.txt
echo -n "${manifest.manifestHashSha256}" > hash_to_verify.txt

# 2. Decodificar la firma de base64
echo "${manifest.signature}" | base64 -d > manifest.sig.bin

# 3. Verificar firma Ed25519
openssl pkeyutl -verify \\
  -pubin -inkey public_key.pem \\
  -sigfile manifest.sig.bin \\
  -rawin -in hash_to_verify.txt
\`\`\`

---

## 6. Verificar Encadenamiento de Eventos (Cadena de Custodia)

Cada evento tiene un hash que depende del evento anterior, formando una cadena tamper-evident.

### Ultimo evento:
- **Sequence**: ${manifest.lastEventSequence}
- **Hash**: ${manifest.lastEventHash}

### Verificar cadena completa:

\`\`\`javascript
const crypto = require('crypto');
const fs = require('fs');
const canonicalize = require('canonicalize');

const GENESIS_HASH = '0'.repeat(64);
const lines = fs.readFileSync('eventlog.txt', 'utf8').trim().split('\\n');

let prevHash = GENESIS_HASH;
let allValid = true;

for (const line of lines) {
  const event = JSON.parse(line);

  // Verificar encadenamiento
  const expectedPrev = event.sequence === 1 ? GENESIS_HASH : prevHash;
  if (event.prevEventHash !== expectedPrev && event.prevEventHash !== null) {
    console.error(\`ERROR seq \${event.sequence}: prevEventHash incorrecto\`);
    allValid = false;
  }

  // Recalcular hash si es JCS-RFC8785
  if (event.eventCanonicalization === 'JCS-RFC8785') {
    const eventForHash = {
      eventId: event.eventId,
      evidenceUuid: event.evidenceUuid,
      caseId: event.caseId,
      eventType: event.eventType,
      occurredAtUtc: event.occurredAtUtc,
      actor: event.actor,
      sequence: event.sequence,
      prevEventHash: event.prevEventHash,
      payload: event.payload
    };

    const computed = crypto.createHash('sha256')
      .update(canonicalize(eventForHash))
      .digest('hex');

    if (computed !== event.eventHash) {
      console.error(\`ERROR seq \${event.sequence}: eventHash no coincide\`);
      console.error(\`  Esperado: \${event.eventHash}\`);
      console.error(\`  Calculado: \${computed}\`);
      allValid = false;
    }
  }

  prevHash = event.eventHash;
}

// Verificar que el ultimo hash coincide con el manifest
if (prevHash !== '${manifest.lastEventHash}') {
  console.error('ERROR: lastEventHash no coincide con manifest');
  allValid = false;
}

console.log('Cadena de custodia:', allValid ? 'VERIFICADA' : 'FALLIDA');
\`\`\`

---

## Resumen de Algoritmos y Estandares

| Componente | Algoritmo/Estandar |
|------------|-------------------|
| Hash de archivos | SHA-256 |
| Hash de eventos | SHA-256 |
| Canonizacion JSON | RFC 8785 (JCS) |
| Firma digital | Ed25519 |
| Encoding de firma | Base64 |
| Genesis hash | 64 ceros (primer evento) |

---

## Que Prueba Cada Verificacion

1. **Hash de archivo**: El contenido no ha sido modificado
2. **Hash de eventlog**: La cadena de eventos exportada es integra
3. **Hash de manifest**: Los metadatos del paquete no han sido alterados
4. **Firma Ed25519**: El paquete fue sellado por el sistema PRUEBA DIGITAL
5. **Encadenamiento**: Ningun evento fue alterado, eliminado o insertado

---

**Generado por PRUEBA DIGITAL - Sistema de Evidencia Digital Forense**
**Fecha**: ${new Date().toISOString()}
**Version del formato**: 1.0
`;
  }

  // NOTA: El metodo legacy _generateVerifyMd fue eliminado
  // Usar _generateVerifyMdForensic que cumple con el checklist forense

  // ==========================================================================
  // KIT DE VERIFICACION SIMPLIFICADO (para evidencias sin CRYPTO_SEAL)
  // ==========================================================================

  /**
   * Genera un kit de verificación simplificado para evidencias antiguas
   * que no tienen evento CRYPTO_SEAL_CREATED.
   *
   * NOTA: Este kit NO tiene firma criptográfica, solo hashes.
   */
  async _buildSimplifiedVerificationKit(evidenceId, evidence) {
    console.log(`[ExportService] Generando kit simplificado para evidencia #${evidenceId}...`);

    // 1. Obtener todos los eventos de custodia
    const custodyEvents = await prisma.custodyEvent.findMany({
      where: { evidenceId },
      orderBy: { sequence: 'asc' },
      include: {
        actor: { select: { fullName: true, email: true } }
      }
    });

    // 2. Generar eventlog.txt simplificado
    const eventlogLines = custodyEvents.map(event => {
      return JSON.stringify({
        eventId: event.eventUuid,
        evidenceUuid: evidence.uuid,
        caseId: evidence.caseId,
        eventType: event.eventType,
        occurredAtUtc: event.eventAt.toISOString(),
        actor: {
          type: event.actorType,
          displayName: event.actorDisplayName || event.actor?.fullName || 'Sistema'
        },
        sequence: event.sequence,
        prevEventHash: event.prevEventHash,
        eventHash: event.eventHash,
        payload: event.details || {}
      });
    });

    const eventlogTxt = eventlogLines.join('\n');
    const eventLogHashSha256 = hashService.calculateFromBuffer(eventlogTxt);

    // 3. Obtener hashes de archivos
    const originalFile = evidence.files?.find(f => f.fileRole === 'ORIGINAL');
    const bitcopiedFile = evidence.files?.find(f => f.fileRole === 'BITCOPY');
    const sealedFile = evidence.files?.find(f => f.fileRole === 'SEALED');

    const originalHash = originalFile?.hashRecords?.[0]?.hashHex || 'No disponible';
    const bitcopiedHash = bitcopiedFile?.hashRecords?.[0]?.hashHex || 'No disponible';
    const sealedHash = sealedFile?.hashRecords?.[0]?.hashHex || 'No disponible';

    // 4. Crear manifest simplificado (sin firma)
    const manifestContent = {
      version: '1.0-simplified',
      evidenceId: evidence.uuid,
      caseId: evidence.caseId,
      generatedAt: new Date().toISOString(),
      warning: 'Este manifest NO tiene firma criptográfica. La evidencia fue procesada antes de implementar el sellado criptográfico.',
      original: { sha256: originalHash },
      bitcopy: { sha256: bitcopiedHash },
      sealed: { sha256: sealedHash },
      eventlog: {
        hashSha256: eventLogHashSha256,
        eventCount: custodyEvents.length
      },
      lastEventSequence: custodyEvents.length > 0 ? custodyEvents[custodyEvents.length - 1].sequence : 0,
      lastEventHash: custodyEvents.length > 0 ? custodyEvents[custodyEvents.length - 1].eventHash : null
    };

    const manifestJson = JSON.stringify(manifestContent, null, 2);
    const manifestHashSha256 = hashService.calculateFromBuffer(manifestJson);

    // 5. Generar VERIFY.md simplificado
    const verifyMd = `# Guia de Verificacion - PRUEBA DIGITAL (Simplificado)

## ⚠️ ADVERTENCIA

Esta evidencia fue procesada **antes** de implementar el sellado criptográfico (CRYPTO_SEAL).
Por lo tanto, este kit de verificación **NO incluye firma digital Ed25519**.

La integridad se puede verificar mediante los hashes SHA-256 de los archivos.

---

## Evidencia
- **Titulo**: ${evidence.title || 'N/A'}
- **UUID**: ${evidence.uuid}
- **Case ID**: ${evidence.caseId || 'N/A'}

---

## 1. Verificar Hash del Archivo Original

### Hash SHA-256 esperado:
\`\`\`
${originalHash}
\`\`\`

### Comando (Linux/macOS):
\`\`\`bash
sha256sum evidence_*/01_original/*
\`\`\`

### Comando (Windows PowerShell):
\`\`\`powershell
Get-FileHash -Algorithm SHA256 evidence_*\\01_original\\*
\`\`\`

---

## 2. Verificar Hash de la Copia Bit-a-Bit

### Hash SHA-256 esperado:
\`\`\`
${bitcopiedHash}
\`\`\`

---

## 3. Verificar Hash del eventlog.txt

### Hash SHA-256 esperado:
\`\`\`
${eventLogHashSha256}
\`\`\`

---

## 4. Eventos de Custodia

Total de eventos registrados: **${custodyEvents.length}**

${custodyEvents.map(e => `- Seq ${e.sequence}: ${e.eventType} (${e.eventAt.toISOString()})`).join('\n')}

---

**Generado por PRUEBA DIGITAL - Sistema de Evidencia Digital Forense**
**Fecha**: ${new Date().toISOString()}
**Version**: Simplificado (sin firma criptográfica)
`;

    console.log(`[ExportService] Kit simplificado generado para evidencia #${evidenceId}`);

    return {
      eventlogTxt,
      manifestJson,
      signatureBase64: 'NO_SIGNATURE_AVAILABLE',
      publicKeyPem: 'NO_PUBLIC_KEY_AVAILABLE',
      verifyMd,
      eventLogHashSha256,
      manifestHashSha256
    };
  }

  // ==========================================================================
  // GENERAR README DE VERIFICACION
  // ==========================================================================

  _generateReadme(manifest) {
    return `
================================================================================
                    PRUEBA DIGITAL - ZIP FORENSE
                    INSTRUCCIONES DE VERIFICACION
================================================================================

FECHA DE EXPORTACION: ${manifest.createdAt}
ID DE EXPORTACION: ${manifest.exportId}
VERSION: ${manifest.version}
TOTAL DE EVIDENCIAS: ${manifest.totalEvidences}

================================================================================
                         CONTENIDO DEL ZIP
================================================================================

Este ZIP forense contiene la siguiente estructura por cada evidencia:

01_original/     -> Archivo original (NUNCA modificado)
02_bitcopy/      -> Copia bit-a-bit (clon 1:1 del original)
03_sealed/       -> Archivo sellado con QR y marca de agua
04_cert/         -> Certificados (PDF y TXT)
05_reports/      -> Reportes de metadata e indicios
07_verification/ -> Kit de verificacion forense (eventlog, manifest, firma)

================================================================================
                      VERIFICACION DE INTEGRIDAD
================================================================================

Para verificar la integridad de cualquier archivo:

1. Calcule el hash SHA-256 del archivo
   - En Windows (PowerShell):
     Get-FileHash -Algorithm SHA256 archivo.pdf

   - En Linux/Mac:
     sha256sum archivo.pdf

2. Compare el hash calculado con el hash registrado en manifest.txt

3. Si los hashes coinciden, el archivo no ha sido alterado.

================================================================================
                      VERIFICACION EN LINEA
================================================================================

Puede verificar cualquier hash en nuestro sistema:
${process.env.VERIFICATION_URL || 'https://pruebadigital.com/verify'}

Introduzca el hash SHA-256 del archivo original para confirmar
su registro en el sistema.

================================================================================
                           IMPORTANTE
================================================================================

- El archivo original NUNCA ha sido modificado por nuestro sistema.
- La cadena de custodia registra cronologicamente todas las acciones.
- Los indicios de manipulacion (risk_report) NO afirman manipulacion,
  solo senalan posibles indicios que requieren peritaje especializado.

================================================================================
                    GENERADO POR PRUEBA DIGITAL
================================================================================
`.trim();
  }

  // ==========================================================================
  // FORMATEAR METADATA COMO TXT
  // ==========================================================================

  /**
   * Convierte el reporte de metadata JSON a formato TXT legible
   * @param {Object} metadata - Objeto de metadata
   * @param {number} version - Version del reporte
   * @returns {string} Reporte en formato TXT
   */
  _formatMetadataAsTxt(metadata, version) {
    let txt = `================================================================================
                    REPORTE DE METADATA - VERSION ${version}
                    PRUEBA DIGITAL - Sistema de Evidencia Digital Forense
================================================================================

Fecha de generacion: ${new Date().toISOString()}

`;

    const formatValue = (value, indent = 0) => {
      const spaces = '  '.repeat(indent);
      if (value === null || value === undefined) {
        return `${spaces}(sin datos)`;
      }
      if (typeof value === 'object' && !Array.isArray(value)) {
        let result = '';
        for (const [key, val] of Object.entries(value)) {
          if (typeof val === 'object' && val !== null) {
            result += `${spaces}${key}:\n${formatValue(val, indent + 1)}\n`;
          } else {
            result += `${spaces}${key}: ${val}\n`;
          }
        }
        return result.trimEnd();
      }
      if (Array.isArray(value)) {
        return value.map((item, i) => `${spaces}  [${i + 1}] ${typeof item === 'object' ? JSON.stringify(item) : item}`).join('\n');
      }
      return `${spaces}${value}`;
    };

    // Aplanar propiedades de technical/device/fileInfo al nivel raiz
    const flat = { ...metadata };
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
        sampleRate: 'sampleRate', canales: 'canales'
      };
      for (const [techKey, flatKey] of Object.entries(techMappings)) {
        const val = metadata.technical[techKey];
        if (val !== undefined && val !== null && val !== 'N/A' && val !== 'No proporcionada') {
          if (flat[flatKey] === undefined) flat[flatKey] = val;
        }
      }
    }
    if (metadata.device) {
      for (const [key, val] of Object.entries(metadata.device)) {
        if (val && val !== 'No proporcionada') flat[`device_${key}`] = val;
      }
    }
    if (metadata.fileInfo) {
      if (metadata.fileInfo.mimeType && !flat.mimeType) flat.mimeType = metadata.fileInfo.mimeType;
      if (metadata.fileInfo.sizeBytes && !flat.fileSize) flat.fileSize = metadata.fileInfo.sizeBytes;
    }

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
      title: 'Titulo', author: 'Autor', creator: 'Creador', producer: 'Productor',
      subject: 'Asunto', keywords: 'Palabras clave', creationDate: 'Fecha de creacion',
      modificationDate: 'Fecha de modificacion', pageCount: 'Numero de paginas',
      format: 'Formato', width: 'Ancho (px)', height: 'Alto (px)', mimeType: 'Tipo MIME',
      fileSize: 'Tamano de archivo', software: 'Software', colorSpace: 'Espacio de color',
      timezone: 'Zona horaria', density: 'Densidad (DPI)', pdfVersion: 'Version PDF',
      duracion: 'Duracion', codec: 'Codec', sampleRate: 'Frecuencia de muestreo',
      canales: 'Canales', device_fabricante: 'Fabricante', device_modelo: 'Modelo',
      device_numeroSerie: 'Numero de serie', device_lente: 'Lente'
    };

    txt += `--------------------------------------------------------------------------------
                           PROPIEDADES PRINCIPALES
--------------------------------------------------------------------------------\n\n`;

    for (const prop of mainProps) {
      if (flat[prop] !== undefined && flat[prop] !== null) {
        const label = propLabels[prop] || prop.charAt(0).toUpperCase() + prop.slice(1).replace(/([A-Z])/g, ' $1');
        txt += `${label}: ${typeof flat[prop] === 'object' ? JSON.stringify(flat[prop]) : flat[prop]}\n`;
      }
    }

    // Otras propiedades
    const otherProps = Object.keys(flat).filter(k => !mainProps.includes(k));
    if (otherProps.length > 0) {
      txt += `\n--------------------------------------------------------------------------------
                           PROPIEDADES ADICIONALES
--------------------------------------------------------------------------------\n\n`;

      for (const prop of otherProps) {
        const value = flat[prop];
        if (typeof value === 'object' && value !== null) {
          txt += `${prop}:\n${formatValue(value, 1)}\n\n`;
        } else {
          txt += `${prop}: ${value}\n`;
        }
      }
    }

    txt += `\n================================================================================
                              FIN DEL REPORTE
================================================================================`;

    return txt;
  }

  // ==========================================================================
  // FORMATEAR RISK REPORT COMO TXT
  // ==========================================================================

  /**
   * Convierte el reporte de riesgo JSON a formato TXT legible
   * @param {Object} riskReport - Objeto del reporte de riesgo
   * @param {number} version - Version del reporte
   * @returns {string} Reporte en formato TXT
   */
  _formatRiskReportAsTxt(riskReport, version) {
    let txt = `================================================================================
                    REPORTE DE INDICIOS DE RIESGO - VERSION ${version}
                    PRUEBA DIGITAL - Sistema de Evidencia Digital Forense
================================================================================

Fecha de generacion: ${riskReport.createdAt || new Date().toISOString()}

--------------------------------------------------------------------------------
                              RESUMEN
--------------------------------------------------------------------------------

${riskReport.summary || 'No se encontraron indicios de riesgo.'}

--------------------------------------------------------------------------------
                         REGLAS ACTIVADAS
--------------------------------------------------------------------------------

`;

    if (riskReport.rulesTriggered && riskReport.rulesTriggered.length > 0) {
      riskReport.rulesTriggered.forEach((rule, index) => {
        if (typeof rule === 'string') {
          txt += `  [${index + 1}] ${rule}\n`;
        } else if (typeof rule === 'object') {
          txt += `  [${index + 1}] ${rule.name || rule.rule || JSON.stringify(rule)}\n`;
          if (rule.description) {
            txt += `      Descripcion: ${rule.description}\n`;
          }
          if (rule.severity) {
            txt += `      Severidad: ${rule.severity}\n`;
          }
        }
      });
    } else {
      txt += `  (Ninguna regla activada - documento sin indicios detectados)\n`;
    }

    txt += `
--------------------------------------------------------------------------------
                              NOTA IMPORTANTE
--------------------------------------------------------------------------------

Este reporte es un analisis automatizado y NO constituye una conclusion pericial.
Los indicios detectados deben ser evaluados por un perito calificado para
determinar si realmente representan manipulacion o alteracion del documento.

================================================================================
                              FIN DEL REPORTE
================================================================================`;

    return txt;
  }

  // ==========================================================================
  // OBTENER STREAM DE DESCARGA
  // ==========================================================================

  /**
   * Obtiene el stream de descarga de un ZIP exportado desde S3
   * @param {string} storageKey - Clave de almacenamiento
   * @returns {Promise<ReadableStream>}
   */
  async getDownloadStream(storageKey) {
    if (!(await storageService.exists(storageKey))) {
      throw new Error('Archivo de exportacion no encontrado');
    }
    return storageService.getS3Stream(storageKey);
  }
}

// ============================================================================
// INSTANCIA SINGLETON
// ============================================================================
const exportService = new ExportService();

module.exports = exportService;
