// ============================================================================
// SEALING SERVICE - Sellado de documentos con QR y marca de agua
// Sistema PRUEBA DIGITAL
// ============================================================================

const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const QRCode = require('qrcode');
const sharp = require('sharp');
const storageService = require('./storageService');
const hashService = require('./hashService');
const signingService = require('./signingService');
const custodyService = require('./custodyService');
const { STORAGE_STRUCTURE, generateStorageKey, getFullPath } = require('../config/storage');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ============================================================================
// CLASE DE SERVICIO DE SELLADO
// ============================================================================

class SealingService {
  constructor() {
    this.sealText = 'PRUEBA DIGITAL - DOCUMENTO SELLADO';
    this.verificationUrl = process.env.VERIFICATION_URL || 'https://pruebadigital.com/verify';
  }

  /**
   * Sanitiza texto para WinAnsi encoding (usado por fuentes estandar de PDF)
   * Remueve o reemplaza caracteres que no pueden ser codificados
   * @param {string} text - Texto a sanitizar
   * @returns {string} Texto sanitizado
   */
  _sanitizeForPdf(text) {
    if (text === null || text === undefined) return 'N/A';
    const str = String(text);
    // Reemplazar caracteres problemáticos con equivalentes o removerlos
    return str
      .replace(/[\x00-\x1F]/g, '') // Caracteres de control 0x00-0x1F
      .replace(/[\x7F-\x9F]/g, '') // Caracteres de control 0x7F-0x9F (incluye 0x81)
      .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?'); // Reemplazar otros no-WinAnsi con ?
  }

  // ==========================================================================
  // SELLAR DOCUMENTO SEGUN TIPO
  // ==========================================================================

  /**
   * Sella un documento segun su tipo
   * @param {string} sourceStorageKey - Clave del archivo original
   * @param {number} evidenceId - ID de la evidencia
   * @param {string} mimeType - Tipo MIME del archivo
   * @param {string} originalFilename - Nombre original del archivo
   * @param {string} hashOriginal - Hash del archivo original
   * @param {number} version - Version del sellado
   * @returns {Promise<Object>}
   */
  async sealDocument(sourceStorageKey, evidenceId, mimeType, originalFilename, hashOriginal, version = 1) {
    const timestamp = new Date().toISOString();
    const qrData = this._generateQRData(evidenceId, hashOriginal, timestamp);

    // Determinar tipo de sellado
    if (mimeType === 'application/pdf') {
      return this._sealPdf(sourceStorageKey, evidenceId, originalFilename, qrData, hashOriginal, timestamp, version);
    } else if (mimeType.startsWith('image/')) {
      return this._sealImage(sourceStorageKey, evidenceId, originalFilename, mimeType, qrData, hashOriginal, timestamp, version);
    } else {
      // Para otros tipos, crear un certificado PDF adjunto
      return this._createCertificateOnly(evidenceId, originalFilename, mimeType, qrData, hashOriginal, timestamp, version);
    }
  }

  // ==========================================================================
  // SELLAR PDF
  // ==========================================================================

  async _sealPdf(sourceStorageKey, evidenceId, originalFilename, qrData, hashOriginal, timestamp, version) {
    // Leer archivo PDF original
    const sourceStream = await storageService.getFileStream(sourceStorageKey, true);
    const chunks = [];
    for await (const chunk of sourceStream) {
      chunks.push(chunk);
    }
    const pdfBytes = Buffer.concat(chunks);

    // Cargar PDF con pdf-lib
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPages();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // Generar QR code como imagen
    const qrImageBuffer = await QRCode.toBuffer(qrData, {
      width: 80,
      margin: 1
    });
    const qrImage = await pdfDoc.embedPng(qrImageBuffer);

    // Aplicar sello a TODAS las paginas
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const { width, height } = page.getSize();

      // Marca de agua diagonal transparente
      const watermarkText = 'DOCUMENTO SELLADO';
      page.drawText(watermarkText, {
        x: width / 4,
        y: height / 2,
        size: 50,
        font: fontBold,
        color: rgb(0.9, 0.9, 0.9),
        rotate: { angle: 45, type: 'degrees' },
        opacity: 0.3
      });

      // Footer con informacion de sello
      const footerY = 30;
      const footerHeight = 60;

      // Fondo del footer
      page.drawRectangle({
        x: 0,
        y: 0,
        width: width,
        height: footerHeight,
        color: rgb(0.95, 0.95, 0.95),
        opacity: 0.9
      });

      // Linea separadora
      page.drawLine({
        start: { x: 0, y: footerHeight },
        end: { x: width, y: footerHeight },
        thickness: 1,
        color: rgb(0.2, 0.4, 0.6)
      });

      // QR code en el footer
      page.drawImage(qrImage, {
        x: 10,
        y: 5,
        width: 50,
        height: 50
      });

      // Texto del sello
      page.drawText(this.sealText, {
        x: 70,
        y: 40,
        size: 8,
        font: fontBold,
        color: rgb(0.2, 0.4, 0.6)
      });

      page.drawText(`Hash SHA-256: ${hashOriginal.substring(0, 32)}...`, {
        x: 70,
        y: 28,
        size: 6,
        font: font,
        color: rgb(0.3, 0.3, 0.3)
      });

      page.drawText(`Sellado: ${timestamp} | Pag. ${i + 1}/${pages.length}`, {
        x: 70,
        y: 16,
        size: 6,
        font: font,
        color: rgb(0.3, 0.3, 0.3)
      });

      page.drawText(`Verificar en: ${this.verificationUrl}`, {
        x: 70,
        y: 4,
        size: 6,
        font: font,
        color: rgb(0.2, 0.4, 0.6)
      });
    }

    // Guardar PDF sellado
    const sealedPdfBytes = await pdfDoc.save();

    // Generar nombre de archivo sellado
    const ext = path.extname(originalFilename);
    const baseName = path.basename(originalFilename, ext);
    const sealedFilename = `${baseName}_sealed_v${version}${ext}`;

    // Guardar archivo sellado
    const storageKey = generateStorageKey(STORAGE_STRUCTURE.SEALED, evidenceId, sealedFilename);
    const fullPath = getFullPath(storageKey);

    // Crear directorio
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });

    // Escribir archivo temporal
    const tempPath = `${fullPath}.tmp`;
    await fs.promises.writeFile(tempPath, sealedPdfBytes);

    // Calcular hash del archivo sellado
    const sealedHash = hashService.calculateFromBuffer(sealedPdfBytes);

    // Mover a ubicacion final (sin cifrar para permitir visualizacion)
    await fs.promises.rename(tempPath, fullPath);

    return {
      storageKey,
      sizeBytes: sealedPdfBytes.length,
      hash: sealedHash,
      mimeType: 'application/pdf',
      filename: sealedFilename,
      isEncrypted: false
    };
  }

  // ==========================================================================
  // SELLAR IMAGEN
  // ==========================================================================

  async _sealImage(sourceStorageKey, evidenceId, originalFilename, mimeType, qrData, hashOriginal, timestamp, version) {
    // Leer imagen original
    const sourceStream = await storageService.getFileStream(sourceStorageKey, true);
    const chunks = [];
    for await (const chunk of sourceStream) {
      chunks.push(chunk);
    }
    const imageBuffer = Buffer.concat(chunks);

    // Generar QR code
    const qrImageBuffer = await QRCode.toBuffer(qrData, {
      width: 100,
      margin: 1
    });

    // Obtener metadatos de la imagen
    const metadata = await sharp(imageBuffer).metadata();
    const { width, height } = metadata;

    // Calcular dimensiones del banner
    const bannerHeight = 80;
    const newHeight = height + bannerHeight;

    // Crear imagen con banner usando sharp
    const sealedImage = await sharp({
      create: {
        width: width,
        height: newHeight,
        channels: 4,
        background: { r: 245, g: 245, b: 245, alpha: 1 }
      }
    })
      .composite([
        // Imagen original arriba
        {
          input: imageBuffer,
          top: 0,
          left: 0
        },
        // QR code en el banner
        {
          input: qrImageBuffer,
          top: height + 5,
          left: 10
        },
        // Texto del sello como SVG
        {
          input: Buffer.from(this._createSealSvg(hashOriginal, timestamp, width)),
          top: height + 5,
          left: 120
        }
      ])
      .png()
      .toBuffer();

    // Generar nombre de archivo sellado
    const ext = path.extname(originalFilename);
    const baseName = path.basename(originalFilename, ext);
    const sealedFilename = `${baseName}_sealed_v${version}.png`;

    // Guardar archivo sellado
    const storageKey = generateStorageKey(STORAGE_STRUCTURE.SEALED, evidenceId, sealedFilename);
    const fullPath = getFullPath(storageKey);

    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, sealedImage);

    const sealedHash = hashService.calculateFromBuffer(sealedImage);

    return {
      storageKey,
      sizeBytes: sealedImage.length,
      hash: sealedHash,
      mimeType: 'image/png',
      filename: sealedFilename,
      isEncrypted: false
    };
  }

  // ==========================================================================
  // CREAR SOLO CERTIFICADO (para archivos no sellables)
  // ==========================================================================

  async _createCertificateOnly(evidenceId, originalFilename, mimeType, qrData, hashOriginal, timestamp, version) {
    // Crear PDF certificado
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595, 842]); // A4
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // QR code
    const qrImageBuffer = await QRCode.toBuffer(qrData, { width: 150, margin: 1 });
    const qrImage = await pdfDoc.embedPng(qrImageBuffer);

    // Encabezado
    page.drawText('CERTIFICADO DE EVIDENCIA DIGITAL', {
      x: 120,
      y: 780,
      size: 20,
      font: fontBold,
      color: rgb(0.2, 0.4, 0.6)
    });

    page.drawLine({
      start: { x: 50, y: 770 },
      end: { x: 545, y: 770 },
      thickness: 2,
      color: rgb(0.2, 0.4, 0.6)
    });

    // Informacion
    const info = [
      { label: 'Archivo:', value: this._sanitizeForPdf(originalFilename) },
      { label: 'Tipo MIME:', value: this._sanitizeForPdf(mimeType) },
      { label: 'Hash SHA-256:', value: this._sanitizeForPdf(hashOriginal) },
      { label: 'Fecha de Sellado:', value: this._sanitizeForPdf(timestamp) },
      { label: 'ID Evidencia:', value: this._sanitizeForPdf(String(evidenceId)) },
      { label: 'Version:', value: this._sanitizeForPdf(String(version)) }
    ];

    let y = 720;
    for (const item of info) {
      page.drawText(item.label, { x: 50, y, size: 10, font: fontBold, color: rgb(0.3, 0.3, 0.3) });
      page.drawText(item.value, { x: 150, y, size: 10, font, color: rgb(0, 0, 0) });
      y -= 25;
    }

    // QR
    page.drawImage(qrImage, { x: 220, y: 400, width: 150, height: 150 });
    page.drawText('Escanee para verificar', {
      x: 230,
      y: 380,
      size: 10,
      font,
      color: rgb(0.5, 0.5, 0.5)
    });

    // Nota legal
    page.drawText('Este certificado acredita la integridad del archivo original.', {
      x: 50,
      y: 300,
      size: 9,
      font,
      color: rgb(0.3, 0.3, 0.3)
    });

    page.drawText('El hash SHA-256 permite verificar que el archivo no ha sido alterado.', {
      x: 50,
      y: 285,
      size: 9,
      font,
      color: rgb(0.3, 0.3, 0.3)
    });

    // Footer
    page.drawText(`Generado por PRUEBA DIGITAL - ${timestamp}`, {
      x: 180,
      y: 30,
      size: 8,
      font,
      color: rgb(0.5, 0.5, 0.5)
    });

    const pdfBytes = await pdfDoc.save();

    const certFilename = `cert_${evidenceId}_v${version}.pdf`;
    const storageKey = generateStorageKey(STORAGE_STRUCTURE.SEALED, evidenceId, certFilename);
    const fullPath = getFullPath(storageKey);

    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, pdfBytes);

    return {
      storageKey,
      sizeBytes: pdfBytes.length,
      hash: hashService.calculateFromBuffer(pdfBytes),
      mimeType: 'application/pdf',
      filename: certFilename,
      isEncrypted: false,
      isCertificateOnly: true
    };
  }

  // ==========================================================================
  // GENERAR CERTIFICADOS PDF Y JSON
  // ==========================================================================

  async generateCertificates(evidenceId, evidenceData, version = 1) {
    const timestamp = new Date().toISOString();
    const results = [];

    // Certificado TXT (formato legible en lugar de JSON)
    const txtContent = this._generateCertificateTxt(evidenceId, evidenceData, timestamp, version);
    const txtFilename = `cert_${evidenceId}_v${version}.txt`;
    const txtStorageKey = generateStorageKey(STORAGE_STRUCTURE.CERTIFICATES, evidenceId, txtFilename);
    const txtFullPath = getFullPath(txtStorageKey);

    await fs.promises.mkdir(path.dirname(txtFullPath), { recursive: true });
    await fs.promises.writeFile(txtFullPath, txtContent);

    results.push({
      fileRole: 'CERT_TXT',
      storageKey: txtStorageKey,
      sizeBytes: Buffer.byteLength(txtContent),
      hash: hashService.calculateFromBuffer(txtContent),
      mimeType: 'text/plain',
      filename: txtFilename
    });

    // Certificado PDF
    const certData = {
      type: 'DIGITAL_EVIDENCE_CERTIFICATE',
      version: '1.0',
      evidenceId,
      title: evidenceData.title,
      sourceType: evidenceData.sourceType,
      originalFilename: evidenceData.originalFilename,
      hashes: evidenceData.hashes,
      custodyChainHash: evidenceData.custodyChainHash,
      createdAt: evidenceData.createdAt,
      certifiedAt: timestamp,
      certVersion: version,
      verificationUrl: `${this.verificationUrl}?hash=${evidenceData.hashes.original}`
    };

    const pdfResult = await this._generateCertificatePdf(evidenceId, evidenceData, certData, version);
    results.push({
      fileRole: 'CERT_PDF',
      ...pdfResult
    });

    return results;
  }

  /**
   * Genera el certificado en formato TXT legible
   */
  _generateCertificateTxt(evidenceId, evidenceData, timestamp, version) {
    return `================================================================================
                    CERTIFICADO DE EVIDENCIA DIGITAL
                    PRUEBA DIGITAL - Sistema Forense
================================================================================

Tipo de Documento: CERTIFICADO DE EVIDENCIA DIGITAL
Version del Formato: 1.0

--------------------------------------------------------------------------------
                           DATOS DE LA EVIDENCIA
--------------------------------------------------------------------------------

ID de Evidencia:        ${evidenceId}
Titulo:                 ${evidenceData.title || 'Sin titulo'}
Tipo de Archivo:        ${evidenceData.sourceType || 'N/A'}
Nombre Original:        ${evidenceData.originalFilename || 'N/A'}
Fecha de Creacion:      ${evidenceData.createdAt || 'N/A'}
Fecha de Certificacion: ${timestamp}
Version del Certificado: ${version}

--------------------------------------------------------------------------------
                           HASHES DE INTEGRIDAD
--------------------------------------------------------------------------------

Hash del Archivo Original (SHA-256):
${evidenceData.hashes?.original || 'No disponible'}

Hash de la Copia Bit-a-Bit (SHA-256):
${evidenceData.hashes?.bitcopy || 'Pendiente de generacion'}

Hash del Documento Sellado (SHA-256):
${evidenceData.hashes?.sealed || 'Pendiente de generacion'}

Hash de la Cadena de Custodia:
${evidenceData.custodyChainHash || 'N/A'}

--------------------------------------------------------------------------------
                           VERIFICACION
--------------------------------------------------------------------------------

URL de Verificacion:
${this.verificationUrl}?hash=${evidenceData.hashes?.original || ''}

Para verificar la autenticidad de este documento:
1. Visite la URL de verificacion indicada arriba
2. Ingrese el hash SHA-256 del archivo original
3. El sistema confirmara si el documento esta registrado

--------------------------------------------------------------------------------
                           NOTA LEGAL
--------------------------------------------------------------------------------

Este certificado acredita que el archivo digital fue registrado en el sistema
PRUEBA DIGITAL en la fecha indicada. El hash SHA-256 es una huella digital
unica que permite verificar que el archivo no ha sido alterado desde su
registro.

La integridad de este certificado puede ser verificada comparando el hash
SHA-256 del archivo original con el registrado en el sistema.

================================================================================
                    GENERADO POR PRUEBA DIGITAL
                    ${timestamp}
================================================================================`.trim();
  }

  async _generateCertificatePdf(evidenceId, evidenceData, jsonCert, version) {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595, 842]);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // Generar QR
    const qrData = `${this.verificationUrl}?hash=${evidenceData.hashes.original}`;
    const qrImageBuffer = await QRCode.toBuffer(qrData, { width: 120, margin: 1 });
    const qrImage = await pdfDoc.embedPng(qrImageBuffer);

    // Titulo
    page.drawText('CERTIFICADO DE EVIDENCIA DIGITAL', {
      x: 130, y: 780, size: 18, font: fontBold, color: rgb(0.2, 0.4, 0.6)
    });

    // Contenido
    let y = 720;
    const addField = (label, value) => {
      page.drawText(this._sanitizeForPdf(label), { x: 50, y, size: 10, font: fontBold });
      page.drawText(this._sanitizeForPdf(value), { x: 180, y, size: 10, font });
      y -= 20;
    };

    addField('ID Evidencia:', evidenceId);
    addField('Titulo:', evidenceData.title);
    addField('Tipo:', evidenceData.sourceType);
    addField('Archivo Original:', evidenceData.originalFilename);
    addField('Hash Original:', evidenceData.hashes.original);
    addField('Hash Bitcopy:', evidenceData.hashes.bitcopy || 'Pendiente');
    addField('Hash Sellado:', evidenceData.hashes.sealed || 'Pendiente');
    addField('Fecha Creacion:', evidenceData.createdAt);
    addField('Fecha Certificado:', jsonCert.certifiedAt);
    addField('Version:', version);

    // QR
    page.drawImage(qrImage, { x: 240, y: y - 150, width: 120, height: 120 });

    const pdfBytes = await pdfDoc.save();
    const pdfFilename = `cert_${evidenceId}_v${version}.pdf`;
    const storageKey = generateStorageKey(STORAGE_STRUCTURE.CERTIFICATES, evidenceId, pdfFilename);
    const fullPath = getFullPath(storageKey);

    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, pdfBytes);

    return {
      storageKey,
      sizeBytes: pdfBytes.length,
      hash: hashService.calculateFromBuffer(pdfBytes),
      mimeType: 'application/pdf',
      filename: pdfFilename
    };
  }

  // ==========================================================================
  // SELLO CRIPTOGRAFICO (Cambio 6 - Firma Ed25519 sobre manifest)
  // ==========================================================================

  /**
   * Crea un sello criptografico real (firma Ed25519 sobre un manifest completo)
   * El manifest resume todos los hashes y artefactos de la evidencia
   * @param {number} evidenceId - ID de la evidencia
   * @returns {Promise<Object>} { manifest, manifestHashSha256, signature, signatureAlgorithm, signingKeyFingerprint, publicKeyPem }
   */
  async createCryptographicSeal(evidenceId) {
    // Obtener evidencia con UUID y caseId
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: { uuid: true, caseId: true }
    });

    // Obtener archivo original con hash y mimeType
    const originalFile = await prisma.evidenceFile.findFirst({
      where: { evidenceId, fileRole: 'ORIGINAL' },
      include: { hashRecords: { orderBy: { computedAt: 'desc' }, take: 1 } }
    });

    // Obtener bitcopy con hash
    const bitcopyFile = await prisma.evidenceFile.findFirst({
      where: { evidenceId, fileRole: 'BITCOPY' },
      include: { hashRecords: { orderBy: { computedAt: 'desc' }, take: 1 } }
    });

    // Obtener sealed document con hash
    const sealedFile = await prisma.evidenceFile.findFirst({
      where: { evidenceId, fileRole: 'SEALED' },
      include: { hashRecords: { orderBy: { computedAt: 'desc' }, take: 1 } }
    });

    // Obtener hashes de metadata y risk report desde eventos de custodia
    // IMPORTANTE: Incluir explícitamente details para asegurar que Prisma lo retorne
    const metadataEvent = await prisma.custodyEvent.findFirst({
      where: {
        evidenceId,
        eventType: { in: ['METADATA_EXTRACTED', 'METADATA_CREATED'] }
      },
      orderBy: { eventAt: 'desc' },
      select: {
        id: true,
        eventType: true,
        details: true
      }
    });

    const riskEvent = await prisma.custodyEvent.findFirst({
      where: { evidenceId, eventType: 'RISK_REPORT_CREATED' },
      orderBy: { eventAt: 'desc' },
      select: {
        id: true,
        eventType: true,
        details: true
      }
    });

    // Obtener ultimo evento de custodia (para lastEventHash)
    const lastEvent = await prisma.custodyEvent.findFirst({
      where: { evidenceId },
      orderBy: { sequence: 'desc' },
      select: {
        sequence: true,
        eventHash: true,
        eventType: true
      }
    });

    // Verificar que el último evento sea READY_EXPORT
    if (lastEvent && lastEvent.eventType !== 'READY_EXPORT') {
      console.warn(`[SealingService] ADVERTENCIA: Último evento no es READY_EXPORT, es ${lastEvent.eventType}. El manifest debería certificar READY_EXPORT como evento final.`);
    }
    if (lastEvent) {
      console.log(`[SealingService] Último evento: seq=${lastEvent.sequence}, type=${lastEvent.eventType}, hash=${lastEvent.eventHash.substring(0, 16)}...`);
    }

    // Función helper para parsear details (defensivo: maneja string JSON o objeto)
    const parseDetails = (details) => {
      if (!details) return null;
      if (typeof details === 'string') {
        try {
          return JSON.parse(details);
        } catch (e) {
          console.error(`[SealingService] Error parseando details como JSON:`, e.message);
          return null;
        }
      }
      return details;
    };

    // Parsear details de forma defensiva
    const metadataDetails = parseDetails(metadataEvent?.details);
    const riskDetails = parseDetails(riskEvent?.details);

    // DEBUG: Log de diagnóstico para verificar datos extraídos
    console.log(`[SealingService] metadataEvent encontrado: ${metadataEvent ? 'SI' : 'NO'}`);
    if (metadataEvent) {
      console.log(`[SealingService] metadataEvent.details (raw type):`, typeof metadataEvent.details);
      console.log(`[SealingService] metadataDetails (parsed):`, JSON.stringify(metadataDetails, null, 2));
    }
    console.log(`[SealingService] riskEvent encontrado: ${riskEvent ? 'SI' : 'NO'}`);
    if (riskEvent) {
      console.log(`[SealingService] riskEvent.details (raw type):`, typeof riskEvent.details);
      console.log(`[SealingService] riskDetails (parsed):`, JSON.stringify(riskDetails, null, 2));
    }

    // Extraer hashes y storageObjectIds de los eventos parseados
    const metadataPayloadHashSha256 = metadataDetails?.metadataPayloadHashSha256 || null;
    const metadataPayloadStorageObjectId = metadataDetails?.metadataPayloadStorageObjectId || null;
    const riskReportPayloadHashSha256 = riskDetails?.riskReportPayloadHashSha256 || null;
    const riskReportPayloadStorageObjectId = riskDetails?.riskReportPayloadStorageObjectId || null;

    console.log(`[SealingService] metadataPayloadHashSha256 extraído: ${metadataPayloadHashSha256 || 'NULL'}`);
    console.log(`[SealingService] metadataPayloadStorageObjectId extraído: ${metadataPayloadStorageObjectId || 'NULL'}`);
    console.log(`[SealingService] riskReportPayloadHashSha256 extraído: ${riskReportPayloadHashSha256 || 'NULL'}`);
    console.log(`[SealingService] riskReportPayloadStorageObjectId extraído: ${riskReportPayloadStorageObjectId || 'NULL'}`);

    // VALIDACIÓN OBLIGATORIA: Abortar si hay eventos pero faltan hashes
    if (metadataEvent && !metadataPayloadHashSha256) {
      const errorMsg = `[SealingService] ERROR CRÍTICO: Evento METADATA_EXTRACTED existe (id=${metadataEvent.id}) pero metadataPayloadHashSha256 es null. Raw details type: ${typeof metadataEvent.details}, Parsed details: ${JSON.stringify(metadataDetails)}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }
    if (riskEvent && !riskReportPayloadHashSha256) {
      const errorMsg = `[SealingService] ERROR CRÍTICO: Evento RISK_REPORT_CREATED existe (id=${riskEvent.id}) pero riskReportPayloadHashSha256 es null. Raw details type: ${typeof riskEvent.details}, Parsed details: ${JSON.stringify(riskDetails)}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    const sealedAtUtc = new Date().toISOString();

    // Generar storageObjectId del eventlog con formato TXT: eventlog/YYYY/MM/DD/uuid.txt
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const eventlogStorageObjectId = `eventlog/${year}/${month}/${day}/${evidence.uuid}.txt`;

    // CRÍTICO: Generar el eventlog AHORA y calcular su hash
    // Este eventlog incluye todos los eventos hasta READY_EXPORT (que es el último evento actual)
    // CRYPTO_SEAL_CREATED aún no existe, así que no se incluye
    console.log(`[SealingService] Generando eventlog en formato TXT para calcular hash...`);
    const { content: eventlogContent, eventLogHashSha256 } =
      await custodyService.exportCustodyAsTxt(evidenceId);

    console.log(`[SealingService] Eventlog generado, hash: ${eventLogHashSha256.substring(0, 16)}...`);

    // PERSISTIR eventlog en storage (Regla E: eventlog verificable)
    // El archivo DEBE existir en el storageObjectId declarado en el manifest
    const eventlogFullPath = getFullPath(eventlogStorageObjectId);
    await fs.promises.mkdir(path.dirname(eventlogFullPath), { recursive: true });
    await fs.promises.writeFile(eventlogFullPath, eventlogContent, 'utf8');
    console.log(`[SealingService] Eventlog persistido en storage: ${eventlogStorageObjectId}`);

    // Crear registro EvidenceFile para el eventlog (trazabilidad)
    // Verificar si ya existe para evitar duplicados
    const existingEventlogFile = await prisma.evidenceFile.findFirst({
      where: { evidenceId, fileRole: 'EVENTLOG' }
    });

    if (!existingEventlogFile) {
      const eventlogSizeBytes = Buffer.byteLength(eventlogContent, 'utf8');
      const eventlogFile = await prisma.evidenceFile.create({
        data: {
          evidenceId,
          fileRole: 'EVENTLOG',
          version: 1,
          storageKey: eventlogStorageObjectId,
          originalFilename: `eventlog_${evidence.uuid}.txt`,
          mimeType: 'text/plain',
          sizeBytes: BigInt(eventlogSizeBytes),
          isEncrypted: false, // Eventlog no se cifra para permitir verificación externa
          userIdRegistration: null // Generado por SYSTEM
        }
      });

      // Crear HashRecord para el eventlog
      await prisma.hashRecord.create({
        data: {
          evidenceFileId: eventlogFile.id,
          algorithm: 'SHA256',
          hashHex: eventLogHashSha256,
          userIdRegistration: null
        }
      });
      console.log(`[SealingService] EvidenceFile creado para eventlog: #${eventlogFile.id}`);
    } else {
      console.log(`[SealingService] EvidenceFile para eventlog ya existe: #${existingEventlogFile.id}`);
    }

    // Construir manifestContent con estructura EXACTA del requerimiento
    // IMPORTANTE: Solo incluir los campos que están en el requerimiento líneas 266-294
    const manifestContent = {
      version: '1.0',
      caseId: evidence.caseId || null,
      evidenceId: evidence.uuid,
      sealedAtUtc,
      // Objeto original con estructura anidada (líneas 271-276)
      original: originalFile ? {
        storageObjectId: originalFile.storageKey,
        sha256: originalFile.hashRecords[0]?.hashHex || null,
        sizeBytes: Number(originalFile.sizeBytes),
        mimeDetected: originalFile.mimeType
      } : null,
      // Objeto bitcopy con estructura anidada (líneas 277-281)
      bitcopy: bitcopyFile ? {
        storageObjectId: bitcopyFile.storageKey,
        sha256: bitcopyFile.hashRecords[0]?.hashHex || null,
        sizeBytes: Number(bitcopyFile.sizeBytes)
      } : null,
      // Objeto sealedDocument con estructura anidada (líneas 282-285)
      sealedDocument: sealedFile ? {
        storageObjectId: sealedFile.storageKey,
        sha256: sealedFile.hashRecords[0]?.hashHex || null
      } : null,
      // Payloads derivados con hash y storageObjectId
      metadataPayloadHashSha256,
      metadataPayloadStorageObjectId,
      riskReportPayloadHashSha256,
      riskReportPayloadStorageObjectId,
      // Eventlog con hash REAL calculado (líneas 288-291)
      eventlog: {
        storageObjectId: eventlogStorageObjectId,
        hashSha256: eventLogHashSha256 // Hash REAL del eventlog
      },
      lastEventHash: lastEvent?.eventHash || null,
      lastEventSequence: lastEvent?.sequence || null
    };

    // Firmar manifest con Ed25519
    const signatureResult = await signingService.signManifest(manifestContent);

    // Retornar estructura EXACTA del requerimiento
    return {
      signatureAlgorithm: 'Ed25519',
      signedContent: 'manifestHashSha256',
      signatureEncoding: 'base64',
      signature: signatureResult.signature,
      publicKeyPem: signatureResult.publicKeyPem,
      signingKeyFingerprint: signatureResult.signingKeyFingerprint,
      manifestHashSha256: signatureResult.manifestHashSha256,
      manifestContent
    };
  }

  // ==========================================================================
  // UTILIDADES PRIVADAS
  // ==========================================================================

  _generateQRData(evidenceId, hash, timestamp) {
    return JSON.stringify({
      url: `${this.verificationUrl}?hash=${hash}`,
      id: evidenceId,
      hash: hash.substring(0, 16),
      ts: timestamp
    });
  }

  _createSealSvg(hash, timestamp, maxWidth) {
    const text1 = this.sealText;
    const text2 = `Hash: ${hash.substring(0, 32)}...`;
    const text3 = `Sellado: ${timestamp}`;

    return `
      <svg width="${maxWidth - 130}" height="70">
        <text x="0" y="15" font-family="Arial" font-size="10" font-weight="bold" fill="#336699">${text1}</text>
        <text x="0" y="35" font-family="Arial" font-size="8" fill="#333">${text2}</text>
        <text x="0" y="50" font-family="Arial" font-size="8" fill="#666">${text3}</text>
        <text x="0" y="65" font-family="Arial" font-size="8" fill="#336699">Verificar en: ${this.verificationUrl}</text>
      </svg>
    `;
  }
}

// ============================================================================
// INSTANCIA SINGLETON
// ============================================================================
const sealingService = new SealingService();

module.exports = sealingService;
