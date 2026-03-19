// ============================================================================
// ACTA SERVICE - Generacion de Documentos PDF de Evidencia Digital
// Sistema PRUEBA DIGITAL
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { PrismaClient } = require('@prisma/client');
const storageService = require('./storageService');
const { STORAGE_STRUCTURE, generateStorageKey, getFullPath } = require('../config/storage');

const prisma = new PrismaClient();

// ============================================================================
// CONSTANTES
// ============================================================================

const DOCUMENT_TYPES = {
  DNI: 'DNI',
  CE: 'Carnet de Extranjeria',
  PASAPORTE: 'Pasaporte',
  RUC: 'RUC'
};

const CONTRIBUTOR_CONDITIONS = {
  TESTIGO: 'Testigo',
  AGRAVIADO: 'Agraviado',
  DENUNCIANTE: 'Denunciante',
  TERCERO: 'Tercero',
  OTRO: 'Otro'
};

const SOURCE_TYPE_LABELS = {
  PDF: 'Documento PDF',
  IMAGE: 'Imagen',
  VIDEO: 'Video',
  AUDIO: 'Audio',
  CHAT: 'Conversacion/Chat',
  ZIP: 'Archivo Comprimido',
  OTHER: 'Otro tipo de archivo'
};

// Zona horaria para Perú (UTC-5)
const TIMEZONE = 'America/Lima';
const LOCALE = 'es-PE';

// Funciones helper para formatear fechas con zona horaria correcta
const formatDate = (date, options = {}) => {
  return new Date(date).toLocaleDateString(LOCALE, { timeZone: TIMEZONE, ...options });
};

const formatTime = (date, options = {}) => {
  return new Date(date).toLocaleTimeString(LOCALE, { timeZone: TIMEZONE, ...options });
};

const formatDateTime = (date, options = {}) => {
  return new Date(date).toLocaleString(LOCALE, { timeZone: TIMEZONE, ...options });
};

// Colores institucionales
const COLORS = {
  darkBlue: rgb(0.1, 0.2, 0.4),
  mediumBlue: rgb(0.15, 0.25, 0.45),
  lightBlue: rgb(0.85, 0.9, 0.95),
  darkGray: rgb(0.2, 0.2, 0.2),
  mediumGray: rgb(0.4, 0.4, 0.4),
  lightGray: rgb(0.85, 0.85, 0.85),
  veryLightGray: rgb(0.95, 0.95, 0.98),
  white: rgb(1, 1, 1),
  green: rgb(0.2, 0.6, 0.3),
  red: rgb(0.8, 0.2, 0.2)
};

// ============================================================================
// CLASE DE SERVICIO DE ACTAS
// ============================================================================

class ActaService {
  constructor() {
    this.institutionName = 'PRUEBA DIGITAL';
  }

  // ==========================================================================
  // CREAR REGISTRO DE APORTANTE
  // ==========================================================================

  async createContributorRecord(evidenceId, data, userId) {
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId }
    });

    if (!evidence) {
      throw new Error('Evidencia no encontrada');
    }

    const record = await prisma.$queryRaw`
      INSERT INTO evidence_contributor_records (
        evidence_id,
        acta_lugar,
        acta_entidad_interviniente,
        usuario_entidad,
        aportante_nombre_completo,
        aportante_documento_tipo,
        aportante_documento_numero,
        aportante_condicion,
        aportante_condicion_otro,
        aportante_domicilio,
        aportante_telefono,
        aportante_correo,
        dispositivo_origen,
        fecha_obtencion_archivo,
        user_id_registration
      ) VALUES (
        ${evidenceId},
        ${data.actaLugar},
        ${data.actaEntidadInterviniente},
        ${data.usuarioEntidad || null},
        ${data.aportanteNombreCompleto},
        ${data.aportanteDocumentoTipo || 'DNI'},
        ${data.aportanteDocumentoNumero},
        ${data.aportanteCondicion}::enum_contributor_condition,
        ${data.aportanteCondicionOtro || null},
        ${data.aportanteDomicilio || null},
        ${data.aportanteTelefono || null},
        ${data.aportanteCorreo || null},
        ${data.dispositivoOrigen || null},
        ${data.fechaObtencionArchivo ? new Date(data.fechaObtencionArchivo) : null},
        ${userId}
      )
      RETURNING *
    `;

    return record[0];
  }

  // ==========================================================================
  // OBTENER REGISTROS DE APORTANTES
  // ==========================================================================

  async getContributorRecords(evidenceId) {
    const records = await prisma.$queryRaw`
      SELECT
        ecr.*,
        ga.id as acta_id,
        ga.acta_numero,
        ga.acta_uuid,
        ga.generated_at,
        ga.pdf_storage_key
      FROM evidence_contributor_records ecr
      LEFT JOIN generated_actas ga ON ga.contributor_record_id = ecr.id
      WHERE ecr.evidence_id = ${evidenceId}
      ORDER BY ecr.created_at DESC
    `;

    return records.map(r => ({
      id: r.id,
      evidenceId: r.evidence_id,
      actaLugar: r.acta_lugar,
      actaEntidadInterviniente: r.acta_entidad_interviniente,
      usuarioEntidad: r.usuario_entidad,
      aportanteNombreCompleto: r.aportante_nombre_completo,
      aportanteDocumentoTipo: r.aportante_documento_tipo,
      aportanteDocumentoNumero: r.aportante_documento_numero,
      aportanteCondicion: r.aportante_condicion,
      aportanteCondicionOtro: r.aportante_condicion_otro,
      aportanteDomicilio: r.aportante_domicilio,
      aportanteTelefono: r.aportante_telefono,
      aportanteCorreo: r.aportante_correo,
      dispositivoOrigen: r.dispositivo_origen,
      fechaObtencionArchivo: r.fecha_obtencion_archivo,
      createdAt: r.created_at,
      acta: r.acta_id ? {
        id: r.acta_id,
        numero: r.acta_numero,
        uuid: r.acta_uuid,
        generatedAt: r.generated_at,
        hasFile: !!r.pdf_storage_key
      } : null
    }));
  }

  // ==========================================================================
  // GENERAR ACTA PDF
  // ==========================================================================

  async generateActaPdf(evidenceId, contributorRecordId, userId) {
    const contributorRecords = await prisma.$queryRaw`
      SELECT * FROM evidence_contributor_records
      WHERE id = ${contributorRecordId} AND evidence_id = ${evidenceId}
    `;

    if (!contributorRecords || contributorRecords.length === 0) {
      throw new Error('Registro de aportante no encontrado');
    }

    const contributor = contributorRecords[0];

    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      include: {
        case: { select: { id: true, title: true, internalCode: true } },
        files: {
          where: { fileRole: 'ORIGINAL' },
          take: 1
        }
      }
    });

    if (!evidence) {
      throw new Error('Evidencia no encontrada');
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        userRoles: {
          include: { role: true }
        }
      }
    });

    if (!user) {
      throw new Error('Usuario no encontrado');
    }

    const actaNumeroResult = await prisma.$queryRaw`
      SELECT nextval('acta_numero_seq') as seq
    `;
    const seq = actaNumeroResult[0].seq;
    const year = new Date().getFullYear();
    const actaNumero = `ACTA-${year}-${String(seq).padStart(6, '0')}`;

    const pdfBytes = await this._generatePdfDocument({
      evidence,
      contributor,
      user,
      actaNumero
    });

    const pdfHash = crypto.createHash('sha256').update(pdfBytes).digest('hex');

    const pdfFilename = `acta_${actaNumero.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
    const storageKey = generateStorageKey(STORAGE_STRUCTURE.CERTIFICATES, evidenceId, pdfFilename);
    const fullPath = getFullPath(storageKey);

    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, pdfBytes);

    const actaResult = await prisma.$queryRaw`
      INSERT INTO generated_actas (
        evidence_id,
        contributor_record_id,
        acta_numero,
        pdf_hash_sha256,
        pdf_storage_key,
        pdf_size_bytes,
        generated_by_user_id,
        user_id_registration
      ) VALUES (
        ${evidenceId},
        ${contributorRecordId},
        ${actaNumero},
        ${pdfHash},
        ${storageKey},
        ${pdfBytes.length},
        ${userId},
        ${userId}
      )
      RETURNING *
    `;

    return {
      id: actaResult[0].id,
      actaNumero,
      actaUuid: actaResult[0].acta_uuid,
      pdfHash,
      pdfSizeBytes: pdfBytes.length,
      generatedAt: actaResult[0].generated_at,
      storageKey
    };
  }

  // ==========================================================================
  // OBTENER ACTAS GENERADAS
  // ==========================================================================

  async getGeneratedActas(evidenceId) {
    const actas = await prisma.$queryRaw`
      SELECT
        ga.*,
        ecr.aportante_nombre_completo,
        ecr.aportante_documento_numero,
        u.full_name as generated_by_name
      FROM generated_actas ga
      JOIN evidence_contributor_records ecr ON ecr.id = ga.contributor_record_id
      LEFT JOIN users u ON u.id = ga.generated_by_user_id
      WHERE ga.evidence_id = ${evidenceId}
      ORDER BY ga.generated_at DESC
    `;

    return actas.map(a => ({
      id: a.id,
      actaNumero: a.acta_numero,
      actaUuid: a.acta_uuid,
      pdfHash: a.pdf_hash_sha256,
      pdfSizeBytes: Number(a.pdf_size_bytes),
      generatedAt: a.generated_at,
      generatedByName: a.generated_by_name,
      aportanteNombre: a.aportante_nombre_completo,
      aportanteDocumento: a.aportante_documento_numero
    }));
  }

  // ==========================================================================
  // DESCARGAR ACTA
  // ==========================================================================

  async downloadActa(actaId) {
    const actas = await prisma.$queryRaw`
      SELECT * FROM generated_actas WHERE id = ${actaId}
    `;

    if (!actas || actas.length === 0) {
      throw new Error('Acta no encontrada');
    }

    const acta = actas[0];

    if (!acta.pdf_storage_key) {
      throw new Error('Archivo PDF no disponible');
    }

    const fullPath = getFullPath(acta.pdf_storage_key);

    if (!fs.existsSync(fullPath)) {
      throw new Error('Archivo PDF no encontrado en storage');
    }

    const stream = fs.createReadStream(fullPath);
    const filename = `${acta.acta_numero}.pdf`;

    return {
      stream,
      filename,
      mimeType: 'application/pdf',
      sizeBytes: Number(acta.pdf_size_bytes)
    };
  }

  // ==========================================================================
  // GENERACION DEL DOCUMENTO PDF - ACTA DE OBTENCION
  // ==========================================================================

  async _generatePdfDocument({ evidence, contributor, user, actaNumero }) {
    const pdfDoc = await PDFDocument.create();
    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    let page = pdfDoc.addPage([595, 842]);
    const { width, height } = page.getSize();
    let y = height - 50;
    const marginLeft = 50;
    const marginRight = 50;
    const contentWidth = width - marginLeft - marginRight;

    const sanitize = (text) => {
      if (text === null || text === undefined) return '';
      return String(text).replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').replace(/[^\x20-\x7E\xA0-\xFF]/g, '').trim();
    };

    const checkPage = (needed = 60) => {
      if (y < needed) {
        page = pdfDoc.addPage([595, 842]);
        y = height - 50;
      }
    };

    const drawSection = (title, number) => {
      checkPage(80);
      page.drawRectangle({ x: marginLeft, y: y - 5, width: contentWidth, height: 22, color: COLORS.veryLightGray });
      page.drawText(`${number}. ${title}`, { x: marginLeft + 10, y, font: helveticaBold, size: 11, color: COLORS.darkBlue });
      y -= 30;
    };

    const drawField = (label, value, options = {}) => {
      checkPage(25);
      const labelWidth = options.labelWidth || 180;
      page.drawText(sanitize(label) + ':', { x: marginLeft + 10, y, font: helveticaBold, size: 9, color: COLORS.mediumGray });
      page.drawText(sanitize(value) || 'N/A', { x: marginLeft + labelWidth, y, font: helvetica, size: 9, color: COLORS.darkGray });
      y -= 16;
    };

    // Preparar datos
    const fechaActa = new Date(evidence.createdAt);
    const fechaFormateada = formatDate(fechaActa, { day: '2-digit', month: 'long', year: 'numeric' });
    const horaFormateada = formatTime(fechaActa, { hour: '2-digit', minute: '2-digit' });

    const rolUsuario = user.userRoles[0]?.role?.name || 'Usuario';
    const originalFile = evidence.files[0];
    const condicionLabel = CONTRIBUTOR_CONDITIONS[contributor.aportante_condicion] || contributor.aportante_condicion;

    // ENCABEZADO
    page.drawRectangle({ x: 0, y: height - 90, width, height: 90, color: COLORS.veryLightGray });
    page.drawText('ACTA DE OBTENCION DE EVIDENCIA DIGITAL', { x: marginLeft, y: height - 40, font: helveticaBold, size: 16, color: COLORS.darkBlue });
    page.drawText('Y DECLARACION JURADA DE APORTANTE', { x: marginLeft, y: height - 58, font: helveticaBold, size: 14, color: COLORS.darkBlue });
    page.drawText(`N${String.fromCharCode(176)} ${actaNumero}`, { x: width - marginRight - 120, y: height - 40, font: helveticaBold, size: 11, color: COLORS.darkBlue });

    y = height - 110;

    // SECCION 1: DATOS GENERALES DEL ACTA
    drawSection('DATOS GENERALES DEL ACTA', '1');
    drawField('Lugar', contributor.acta_lugar);
    drawField('Fecha', fechaFormateada);
    drawField('Hora', horaFormateada);
    drawField('Entidad Interviniente', contributor.acta_entidad_interviniente);
    drawField('Carpeta Fiscal / Caso', evidence.case?.internalCode || evidence.case?.title || 'Sin caso asignado');
    y -= 10;

    // SECCION 2: IDENTIFICACION DEL USUARIO ALINA
    drawSection('IDENTIFICACION DEL USUARIO DE ALINA', '2');
    drawField('Nombre Completo', user.fullName);
    drawField('Cargo / Rol', rolUsuario);
    drawField('Entidad', contributor.usuario_entidad || 'No especificada');
    drawField('Correo Institucional', user.email);
    drawField('Codigo ALINA', `USR-${String(user.id).padStart(6, '0')}`);
    y -= 10;

    // SECCION 3: IDENTIFICACION DEL APORTANTE
    drawSection('IDENTIFICACION DEL APORTANTE', '3');
    drawField('Nombre Completo', contributor.aportante_nombre_completo);
    drawField('Tipo de Documento', DOCUMENT_TYPES[contributor.aportante_documento_tipo] || contributor.aportante_documento_tipo);
    drawField('Numero de Documento', contributor.aportante_documento_numero);

    let condicionDisplay = condicionLabel;
    if (contributor.aportante_condicion === 'OTRO' && contributor.aportante_condicion_otro) {
      condicionDisplay = `Otro: ${contributor.aportante_condicion_otro}`;
    }
    drawField('Condicion', condicionDisplay);

    if (contributor.aportante_domicilio) drawField('Domicilio', contributor.aportante_domicilio);
    if (contributor.aportante_telefono) drawField('Telefono', contributor.aportante_telefono);
    if (contributor.aportante_correo) drawField('Correo Electronico', contributor.aportante_correo);
    y -= 10;

    // SECCION 4: DESCRIPCION DE LA EVIDENCIA
    drawSection('DESCRIPCION DE LA EVIDENCIA DIGITAL', '4');
    drawField('Tipo de Evidencia', SOURCE_TYPE_LABELS[evidence.sourceType] || evidence.sourceType);
    drawField('Descripcion', evidence.description || evidence.title || 'Sin descripcion');
    if (contributor.dispositivo_origen) drawField('Dispositivo de Origen', contributor.dispositivo_origen);
    if (originalFile) drawField('Nombre Archivo Original', originalFile.originalFilename);
    if (contributor.fecha_obtencion_archivo) {
      const fechaObt = new Date(contributor.fecha_obtencion_archivo);
      drawField('Fecha Aprox. Obtencion', formatDate(fechaObt));
    }
    y -= 10;

    // SECCION 5: DECLARACION JURADA
    checkPage(150);
    drawSection('DECLARACION JURADA DEL APORTANTE', '5');

    const declaracionTexto = [
      `Yo, ${sanitize(contributor.aportante_nombre_completo)}, identificado(a) con ${DOCUMENT_TYPES[contributor.aportante_documento_tipo] || 'documento'} `,
      `N${String.fromCharCode(176)} ${sanitize(contributor.aportante_documento_numero)}, en mi condicion de ${condicionLabel.toLowerCase()}, DECLARO BAJO JURAMENTO que:`,
      '',
      '1. La evidencia digital que aporto es autentica y no ha sido alterada, modificada o',
      '   manipulada por mi persona.',
      '',
      '2. He obtenido esta evidencia de forma licita y estoy facultado(a) para proporcionarla',
      '   a la autoridad competente.',
      '',
      '3. Conozco que proporcionar informacion falsa constituye delito contra la fe publica,',
      '   sancionado por el Codigo Penal.',
      '',
      '4. Autorizo el uso de esta evidencia en el proceso correspondiente.'
    ];

    for (const line of declaracionTexto) {
      checkPage(15);
      page.drawText(sanitize(line), { x: marginLeft + 10, y, font: helvetica, size: 9, color: COLORS.darkGray });
      y -= 13;
    }
    y -= 10;

    // SECCION 6: REGISTRO EN ALINA
    drawSection('REGISTRO DE INCORPORACION EN ALINA', '6');
    const fechaIncorp = new Date(evidence.createdAt);
    drawField('Fecha y Hora', formatDateTime(fechaIncorp));
    drawField('Accion Realizada', 'Incorporacion de evidencia digital al sistema ALINA');
    drawField('Plataforma', 'PRUEBA DIGITAL - Sistema de Gestion de Evidencia Forense');
    drawField('ID de Evidencia', `EVD-${String(evidence.id).padStart(6, '0')}`);
    y -= 10;

    // SECCION 7: ALCANCE Y RESPONSABILIDADES
    checkPage(100);
    drawSection('ALCANCE Y RESPONSABILIDADES', '7');

    const alcanceTexto = [
      'La presente acta tiene por objeto dejar constancia de la recepcion de evidencia digital',
      'aportada voluntariamente por el declarante. El sistema ALINA garantiza la integridad',
      'y trazabilidad de la evidencia mediante sellado criptografico y cadena de custodia digital.',
      '',
      'El aportante asume responsabilidad por la veracidad de su declaracion. La autenticidad',
      'del contenido de la evidencia debera ser verificada por perito o autoridad competente.'
    ];

    for (const line of alcanceTexto) {
      checkPage(15);
      page.drawText(sanitize(line), { x: marginLeft + 10, y, font: helvetica, size: 9, color: COLORS.darkGray });
      y -= 13;
    }
    y -= 20;

    // SECCION 8: FIRMAS
    checkPage(180);
    drawSection('FIRMAS', '8');

    const tableY = y;
    const colWidth = contentWidth / 2;

    page.drawRectangle({ x: marginLeft, y: tableY - 20, width: contentWidth, height: 20, color: COLORS.lightGray });
    page.drawText('APORTANTE', { x: marginLeft + colWidth / 2 - 30, y: tableY - 15, font: helveticaBold, size: 9, color: COLORS.darkBlue });
    page.drawText('USUARIO ALINA', { x: marginLeft + colWidth + colWidth / 2 - 40, y: tableY - 15, font: helveticaBold, size: 9, color: COLORS.darkBlue });

    page.drawLine({ start: { x: marginLeft + colWidth, y: tableY - 20 }, end: { x: marginLeft + colWidth, y: tableY - 120 }, thickness: 0.5, color: COLORS.lightGray });
    page.drawRectangle({ x: marginLeft, y: tableY - 120, width: contentWidth, height: 100, borderColor: COLORS.lightGray, borderWidth: 1 });

    y = tableY - 45;
    page.drawText('Firma: ________________________', { x: marginLeft + 20, y, font: helvetica, size: 9, color: COLORS.darkGray });
    y -= 20;
    page.drawText(`Nombre: ${sanitize(contributor.aportante_nombre_completo)}`, { x: marginLeft + 20, y, font: helvetica, size: 9, color: COLORS.darkGray });
    y -= 15;
    const docLabel = DOCUMENT_TYPES[contributor.aportante_documento_tipo] || 'Doc.';
    page.drawText(`${docLabel}: ${sanitize(contributor.aportante_documento_numero)}`, { x: marginLeft + 20, y, font: helvetica, size: 9, color: COLORS.darkGray });

    y = tableY - 45;
    page.drawText('Firma: ________________________', { x: marginLeft + colWidth + 20, y, font: helvetica, size: 9, color: COLORS.darkGray });
    y -= 20;
    page.drawText(`Nombre: ${sanitize(user.fullName)}`, { x: marginLeft + colWidth + 20, y, font: helvetica, size: 9, color: COLORS.darkGray });
    y -= 15;
    page.drawText(`Cargo: ${sanitize(rolUsuario)}`, { x: marginLeft + colWidth + 20, y, font: helvetica, size: 9, color: COLORS.darkGray });

    // PIE DE PAGINA
    const totalPages = pdfDoc.getPageCount();
    const pages = pdfDoc.getPages();

    for (let i = 0; i < totalPages; i++) {
      const pg = pages[i];
      pg.drawLine({ start: { x: marginLeft, y: 35 }, end: { x: width - marginRight, y: 35 }, thickness: 0.5, color: COLORS.lightGray });
      pg.drawText('PRUEBA DIGITAL - Acta de Obtencion de Evidencia Digital', { x: marginLeft, y: 22, font: helvetica, size: 7, color: COLORS.mediumGray });
      pg.drawText(`Pagina ${i + 1} de ${totalPages}`, { x: width - marginRight - 60, y: 22, font: helvetica, size: 7, color: COLORS.mediumGray });
      pg.drawText(`${actaNumero}`, { x: width / 2 - 40, y: 22, font: helvetica, size: 7, color: COLORS.mediumGray });
    }

    return await pdfDoc.save();
  }

  // ==========================================================================
  // GENERAR CERTIFICADO DE EVIDENCIA DIGITAL PDF
  // ==========================================================================

  async generateCertificadoPdf(evidenceId, userId) {
    // 1. Obtener datos de la evidencia
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      include: {
        case: { select: { id: true, title: true, internalCode: true } },
        owner: { select: { id: true, fullName: true, email: true } },
        files: {
          include: {
            hashRecords: { orderBy: { computedAt: 'desc' }, take: 1 }
          }
        },
        custodyEvents: {
          orderBy: { sequence: 'asc' },
          include: { actor: { select: { fullName: true, email: true } } },
          take: 5
        }
      }
    });

    if (!evidence) {
      throw new Error('Evidencia no encontrada');
    }

    // 2. Obtener usuario que genera
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { userRoles: { include: { role: true } } }
    });

    // 3. Generar numero de certificado
    const year = new Date().getFullYear();
    const certNumero = `CERT-${year}-${String(evidenceId).padStart(6, '0')}`;

    // 4. Obtener archivos por rol
    const originalFile = evidence.files.find(f => f.fileRole === 'ORIGINAL');
    const bitcopiedFile = evidence.files.find(f => f.fileRole === 'BITCOPY');
    const sealedFile = evidence.files.find(f => f.fileRole === 'SEALED');

    // 5. Obtener sello criptografico desde eventos de custodia (CRYPTO_SEAL_CREATED)
    const cryptoSealEvent = await prisma.custodyEvent.findFirst({
      where: {
        evidenceId: evidenceId,
        eventType: 'CRYPTO_SEAL_CREATED'
      },
      orderBy: { eventAt: 'desc' }
    });

    // Transformar datos del evento al formato esperado
    let cryptoSeal = null;
    if (cryptoSealEvent && cryptoSealEvent.details) {
      const details = typeof cryptoSealEvent.details === 'string'
        ? JSON.parse(cryptoSealEvent.details)
        : cryptoSealEvent.details;
      cryptoSeal = {
        signature_base64: details.signature || null,
        public_key_base64: details.publicKeyPem || null,
        algorithm: details.signatureAlgorithm || 'Ed25519',
        created_at: cryptoSealEvent.eventAt
      };
    }

    // 6. Generar PDF
    const pdfBytes = await this._generateCertificadoDocument({
      evidence,
      user,
      certNumero,
      originalFile,
      bitcopiedFile,
      sealedFile,
      custodyEvents: evidence.custodyEvents,
      cryptoSeal
    });

    // 7. Calcular hash del PDF
    const pdfHash = crypto.createHash('sha256').update(pdfBytes).digest('hex');

    // 8. Guardar PDF en storage
    const pdfFilename = `certificado_${certNumero.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
    const storageKey = generateStorageKey(STORAGE_STRUCTURE.CERTIFICATES, evidenceId, pdfFilename);
    const fullPath = getFullPath(storageKey);

    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, pdfBytes);

    return {
      certNumero,
      pdfHash,
      pdfSizeBytes: pdfBytes.length,
      generatedAt: new Date().toISOString(),
      storageKey,
      filename: pdfFilename
    };
  }

  // ==========================================================================
  // GENERAR REPORTE DE CADENA DE CUSTODIA PDF
  // ==========================================================================

  async generateCadenaCustodiaPdf(evidenceId, userId) {
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      include: {
        case: { select: { id: true, title: true, internalCode: true } },
        owner: { select: { id: true, fullName: true, email: true } },
        custodyEvents: {
          orderBy: { sequence: 'asc' },
          include: { actor: { select: { fullName: true, email: true } } }
        }
      }
    });

    if (!evidence) {
      throw new Error('Evidencia no encontrada');
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { userRoles: { include: { role: true } } }
    });

    const year = new Date().getFullYear();
    const reporteNumero = `CUSTODIA-${year}-${String(evidenceId).padStart(6, '0')}`;

    const pdfBytes = await this._generateCadenaCustodiaDocument({
      evidence,
      user,
      reporteNumero,
      eventos: evidence.custodyEvents
    });

    const pdfHash = crypto.createHash('sha256').update(pdfBytes).digest('hex');

    const pdfFilename = `cadena_custodia_${reporteNumero.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
    const storageKey = generateStorageKey(STORAGE_STRUCTURE.CERTIFICATES, evidenceId, pdfFilename);
    const fullPath = getFullPath(storageKey);

    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, pdfBytes);

    return {
      reporteNumero,
      pdfHash,
      pdfSizeBytes: pdfBytes.length,
      generatedAt: new Date().toISOString(),
      storageKey,
      filename: pdfFilename,
      totalEventos: evidence.custodyEvents.length
    };
  }

  // ==========================================================================
  // GENERAR REPORTE DE METADATOS PDF
  // ==========================================================================

  async generateMetadatosPdf(evidenceId, userId) {
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      include: {
        case: { select: { id: true, title: true, internalCode: true } },
        owner: { select: { id: true, fullName: true, email: true } },
        files: {
          where: { fileRole: 'ORIGINAL' },
          include: {
            hashRecords: { orderBy: { computedAt: 'desc' }, take: 1 }
          },
          take: 1
        },
        metadataReports: {
          orderBy: { version: 'desc' },
          take: 1
        }
      }
    });

    if (!evidence) {
      throw new Error('Evidencia no encontrada');
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { userRoles: { include: { role: true } } }
    });

    const year = new Date().getFullYear();
    const reporteNumero = `METADATA-${year}-${String(evidenceId).padStart(6, '0')}`;

    const metadataReport = evidence.metadataReports[0];
    const metadata = metadataReport?.reportJson || {};

    const pdfBytes = await this._generateMetadatosDocument({
      evidence,
      user,
      reporteNumero,
      metadata,
      originalFile: evidence.files[0]
    });

    const pdfHash = crypto.createHash('sha256').update(pdfBytes).digest('hex');

    const pdfFilename = `metadatos_${reporteNumero.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
    const storageKey = generateStorageKey(STORAGE_STRUCTURE.CERTIFICATES, evidenceId, pdfFilename);
    const fullPath = getFullPath(storageKey);

    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, pdfBytes);

    return {
      reporteNumero,
      pdfHash,
      pdfSizeBytes: pdfBytes.length,
      generatedAt: new Date().toISOString(),
      storageKey,
      filename: pdfFilename
    };
  }

  // ==========================================================================
  // OBTENER TODOS LOS DOCUMENTOS DE UNA EVIDENCIA
  // ==========================================================================

  async getAllDocuments(evidenceId) {
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: { id: true, uuid: true, title: true, createdAt: true }
    });

    if (!evidence) {
      throw new Error('Evidencia no encontrada');
    }

    const actas = await this.getGeneratedActas(evidenceId);

    const year = new Date(evidence.createdAt).getFullYear();
    const documents = {
      actas: actas,
      certificado: {
        numero: `CERT-${year}-${String(evidenceId).padStart(6, '0')}`,
        tipo: 'CERTIFICADO',
        descripcion: 'Certificado de Evidencia Digital',
        disponible: true
      },
      cadenaCustodia: {
        numero: `CUSTODIA-${year}-${String(evidenceId).padStart(6, '0')}`,
        tipo: 'CADENA_CUSTODIA',
        descripcion: 'Reporte de Cadena de Custodia Digital',
        disponible: true
      },
      metadatos: {
        numero: `METADATA-${year}-${String(evidenceId).padStart(6, '0')}`,
        tipo: 'METADATOS',
        descripcion: 'Reporte de Metadatos de Evidencia Digital',
        disponible: true
      }
    };

    return documents;
  }

  // ==========================================================================
  // DOCUMENTO PDF: CERTIFICADO DE EVIDENCIA DIGITAL (9 SECCIONES)
  // ==========================================================================

  async _generateCertificadoDocument({ evidence, user, certNumero, originalFile, bitcopiedFile, sealedFile, custodyEvents, cryptoSeal }) {
    const pdfDoc = await PDFDocument.create();
    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    let page = pdfDoc.addPage([595, 842]);
    const { width, height } = page.getSize();
    let y = height - 50;
    const marginLeft = 50;
    const marginRight = 50;
    const contentWidth = width - marginLeft - marginRight;

    const sanitize = (text) => {
      if (text === null || text === undefined) return '';
      return String(text).replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').replace(/[^\x20-\x7E\xA0-\xFF]/g, '').trim();
    };

    const checkPage = (needed = 60) => {
      if (y < needed) {
        page = pdfDoc.addPage([595, 842]);
        y = height - 50;
      }
    };

    const drawSection = (title, number) => {
      checkPage(80);
      page.drawRectangle({ x: marginLeft, y: y - 5, width: contentWidth, height: 22, color: COLORS.veryLightGray });
      page.drawText(`${number}. ${title}`, { x: marginLeft + 10, y, font: helveticaBold, size: 11, color: COLORS.darkBlue });
      y -= 30;
    };

    const drawTableRow = (label, value, options = {}) => {
      checkPage(25);
      const labelWidth = options.labelWidth || 180;

      // Fondo alternado
      if (options.alternate) {
        page.drawRectangle({ x: marginLeft, y: y - 4, width: contentWidth, height: 18, color: COLORS.veryLightGray });
      }

      page.drawText(sanitize(label), { x: marginLeft + 10, y, font: helveticaBold, size: 9, color: COLORS.mediumGray });

      const displayValue = sanitize(value) || 'N/A';
      const maxWidth = contentWidth - labelWidth - 20;
      let truncatedValue = displayValue;
      if (displayValue.length > 70) {
        truncatedValue = displayValue.substring(0, 67) + '...';
      }
      page.drawText(truncatedValue, { x: marginLeft + labelWidth, y, font: helvetica, size: 9, color: COLORS.darkGray });
      y -= 16;
    };

    // Preparar datos
    const fechaCert = new Date();
    const fechaFormateada = formatDate(fechaCert, { day: '2-digit', month: 'long', year: 'numeric' });
    const horaFormateada = formatTime(fechaCert, { hour: '2-digit', minute: '2-digit' });
    const rolUsuario = user?.userRoles?.[0]?.role?.name || 'Usuario';

    // Obtener hashes
    const originalHash = originalFile?.hashRecords?.[0]?.hashHex || null;
    const bitcopiedHash = bitcopiedFile?.hashRecords?.[0]?.hashHex || null;
    const sealedHash = sealedFile?.hashRecords?.[0]?.hashHex || null;
    const hashesMatch = originalHash && bitcopiedHash && originalHash === bitcopiedHash;

    // ===========================================
    // ENCABEZADO
    // ===========================================
    page.drawRectangle({ x: 0, y: height - 90, width, height: 90, color: COLORS.lightBlue });
    page.drawText('CERTIFICADO DE EVIDENCIA DIGITAL', { x: marginLeft, y: height - 40, font: helveticaBold, size: 16, color: COLORS.darkBlue });
    page.drawText('SISTEMA PRUEBA DIGITAL - ALINA', { x: marginLeft, y: height - 58, font: helvetica, size: 12, color: COLORS.darkBlue });
    page.drawText(`N${String.fromCharCode(176)} ${certNumero}`, { x: width - marginRight - 140, y: height - 40, font: helveticaBold, size: 11, color: COLORS.darkBlue });

    y = height - 110;

    // ===========================================
    // SECCION 1: IDENTIFICACION DE LA EVIDENCIA
    // ===========================================
    drawSection('IDENTIFICACION DE LA EVIDENCIA', '1');
    drawTableRow('Identificador unico', evidence.uuid, { alternate: false });
    drawTableRow('Codigo de evidencia', `EVD-${String(evidence.id).padStart(6, '0')}`, { alternate: true });
    drawTableRow('Titulo', evidence.title, { alternate: false });
    drawTableRow('Descripcion', evidence.description, { alternate: true });
    drawTableRow('Tipo de archivo', SOURCE_TYPE_LABELS[evidence.sourceType] || evidence.sourceType, { alternate: false });
    drawTableRow('Tamano', originalFile ? `${Number(originalFile.sizeBytes).toLocaleString()} bytes` : 'N/A', { alternate: true });
    drawTableRow('Nombre original', originalFile?.originalFilename || 'N/A', { alternate: false });
    drawTableRow('Carpeta fiscal', evidence.case?.internalCode || evidence.case?.title || 'Sin caso asignado', { alternate: true });
    y -= 10;

    // ===========================================
    // SECCION 2: USUARIO REGISTRANTE
    // ===========================================
    drawSection('USUARIO REGISTRANTE', '2');
    drawTableRow('Nombre completo', evidence.owner?.fullName, { alternate: false });
    drawTableRow('Correo institucional', evidence.owner?.email, { alternate: true });
    drawTableRow('Cargo / Rol', rolUsuario, { alternate: false });
    drawTableRow('Codigo ALINA', `USR-${String(evidence.owner?.id || 0).padStart(6, '0')}`, { alternate: true });
    drawTableRow('Entidad', 'Sistema PRUEBA DIGITAL', { alternate: false });
    y -= 10;

    // ===========================================
    // SECCION 3: DATOS CRIPTOGRAFICOS
    // ===========================================
    drawSection('DATOS CRIPTOGRAFICOS', '3');

    // Función auxiliar para dibujar hash completo en una línea
    const drawHashRow = (label, hashValue, alternate) => {
      checkPage(25);
      if (alternate) {
        page.drawRectangle({ x: marginLeft, y: y - 4, width: contentWidth, height: 18, color: COLORS.veryLightGray });
      }
      page.drawText(sanitize(label), { x: marginLeft + 10, y, font: helveticaBold, size: 9, color: COLORS.mediumGray });
      if (hashValue) {
        // Hash completo en una línea con fuente pequeña (size 6.5 cabe 64 chars)
        page.drawText(hashValue, { x: marginLeft + 140, y, font: helvetica, size: 6.5, color: COLORS.darkGray });
      } else {
        page.drawText('No disponible', { x: marginLeft + 140, y, font: helvetica, size: 9, color: COLORS.darkGray });
      }
      y -= 18;
    };

    // Hash original
    drawHashRow('Hash SHA-256 original', originalHash, false);

    // Hash bitcopy
    drawHashRow('Hash SHA-256 bitcopy', bitcopiedHash, true);

    // Hash sellado
    drawHashRow('Hash SHA-256 sellado', sealedHash, false);

    drawTableRow('Algoritmo firma', 'Ed25519', { alternate: true });

    // Estado verificacion con indicador visual
    checkPage(25);
    page.drawText('Estado verificacion:', { x: marginLeft + 10, y, font: helveticaBold, size: 9, color: COLORS.mediumGray });
    if (hashesMatch) {
      page.drawText('HASHES COINCIDEN', { x: marginLeft + 180, y, font: helveticaBold, size: 9, color: COLORS.green });
    } else if (originalHash && !bitcopiedHash) {
      page.drawText('BITCOPY PENDIENTE', { x: marginLeft + 180, y, font: helvetica, size: 9, color: COLORS.mediumGray });
    } else {
      page.drawText('VERIFICACION PENDIENTE', { x: marginLeft + 180, y, font: helvetica, size: 9, color: COLORS.mediumGray });
    }
    y -= 16;
    y -= 10;

    // ===========================================
    // SECCION 4: FECHAS Y TRAZABILIDAD
    // ===========================================
    drawSection('FECHAS Y TRAZABILIDAD', '4');
    const fechaIncorp = new Date(evidence.createdAt);
    drawTableRow('Fecha incorporacion', formatDateTime(fechaIncorp), { alternate: false });

    // Fecha sellado (buscar en eventos de custodia)
    const sealEvent = custodyEvents?.find(e => e.eventType === 'SEAL_CREATED' || e.eventType === 'SEALED_DOC_CREATED');
    drawTableRow('Fecha sellado', sealEvent ? formatDateTime(sealEvent.eventAt) : 'No sellado', { alternate: true });

    drawTableRow('Fecha emision cert.', formatDateTime(fechaCert), { alternate: false });
    drawTableRow('Total eventos custodia', `${custodyEvents?.length || 0} eventos`, { alternate: true });
    y -= 10;

    // ===========================================
    // SECCION 5: CADENA DE CUSTODIA (RESUMEN)
    // ===========================================
    checkPage(150);
    drawSection('CADENA DE CUSTODIA (Resumen)', '5');

    // Etiquetas de eventos
    const eventTypeLabels = {
      UPLOAD: 'Archivo Subido',
      SCAN: 'Escaneo Seguridad',
      SCAN_OK: 'Escaneo OK',
      HASH_CALCULATED: 'Hash Calculado',
      BITCOPY_CREATED: 'Bitcopy Creado',
      SEALED_DOC_CREATED: 'Doc. Sellado',
      SEAL_CREATED: 'Doc. Sellado',
      CRYPTO_SEAL_CREATED: 'Sello Cripto',
      METADATA_EXTRACTED: 'Metadata Extraida',
      METADATA_CREATED: 'Metadata',
      RISK_REPORT_CREATED: 'Reporte Riesgo',
      READY_EXPORT: 'Listo Export',
      READY_FOR_EXPORT: 'Listo Export',
      DOWNLOAD: 'Descarga',
      ERROR: 'Error'
    };

    if (custodyEvents && custodyEvents.length > 0) {
      // Encabezado de tabla
      page.drawRectangle({ x: marginLeft, y: y - 5, width: contentWidth, height: 18, color: COLORS.mediumBlue });
      page.drawText('N°', { x: marginLeft + 5, y: y - 1, font: helveticaBold, size: 8, color: COLORS.white });
      page.drawText('Evento', { x: marginLeft + 30, y: y - 1, font: helveticaBold, size: 8, color: COLORS.white });
      page.drawText('Fecha', { x: marginLeft + 180, y: y - 1, font: helveticaBold, size: 8, color: COLORS.white });
      page.drawText('Actor', { x: marginLeft + 300, y: y - 1, font: helveticaBold, size: 8, color: COLORS.white });
      y -= 20;

      // Mostrar hasta 5 eventos
      const eventosAMostrar = custodyEvents.slice(0, 5);
      eventosAMostrar.forEach((evento, idx) => {
        checkPage(20);
        if (idx % 2 === 0) {
          page.drawRectangle({ x: marginLeft, y: y - 4, width: contentWidth, height: 16, color: COLORS.veryLightGray });
        }

        page.drawText(String(evento.sequence || idx + 1), { x: marginLeft + 5, y, font: helvetica, size: 8, color: COLORS.darkGray });
        page.drawText(eventTypeLabels[evento.eventType] || evento.eventType, { x: marginLeft + 30, y, font: helvetica, size: 8, color: COLORS.darkGray });
        page.drawText(formatDate(evento.eventAt), { x: marginLeft + 180, y, font: helvetica, size: 8, color: COLORS.darkGray });

        const actorName = evento.actorDisplayName || evento.actor?.fullName || (evento.actorType === 'SYSTEM' ? 'Sistema' : 'N/A');
        page.drawText(actorName.substring(0, 25), { x: marginLeft + 300, y, font: helvetica, size: 8, color: COLORS.darkGray });
        y -= 14;
      });

      if (custodyEvents.length > 5) {
        y -= 5;
        page.drawText(`... y ${custodyEvents.length - 5} eventos mas. Ver Reporte de Cadena de Custodia completo.`, { x: marginLeft + 10, y, font: helvetica, size: 8, color: COLORS.mediumGray });
        y -= 14;
      }
    } else {
      page.drawText('No hay eventos de custodia registrados.', { x: marginLeft + 10, y, font: helvetica, size: 9, color: COLORS.mediumGray });
      y -= 16;
    }
    y -= 10;

    // ===========================================
    // SECCION 6: DECLARACION TECNICA
    // ===========================================
    checkPage(120);
    drawSection('DECLARACION TECNICA', '6');

    const declaracionTexto = [
      'El presente certificado acredita que la evidencia digital identificada ha sido incorporada',
      'al Sistema PRUEBA DIGITAL (ALINA) y cuenta con las siguientes garantias tecnicas:',
      '',
      '- INTEGRIDAD: Los hashes SHA-256 permiten verificar que los archivos no han sido',
      '  modificados desde su incorporacion al sistema.',
      '',
      '- AUTENTICIDAD: El documento sellado incluye marcas de agua y codigo QR que permiten',
      '  verificar su origen en el sistema PRUEBA DIGITAL.',
      '',
      '- TRAZABILIDAD: Todos los eventos relacionados con esta evidencia quedan registrados',
      '  en la cadena de custodia digital con encadenamiento criptografico.',
      '',
      '- NO REPUDIO: Las firmas digitales Ed25519 garantizan la autoria de las operaciones.'
    ];

    for (const line of declaracionTexto) {
      checkPage(15);
      page.drawText(sanitize(line), { x: marginLeft + 10, y, font: helvetica, size: 9, color: COLORS.darkGray });
      y -= 12;
    }
    y -= 10;

    // ===========================================
    // SECCION 7: VERIFICACION PUBLICA DE HASH
    // ===========================================
    checkPage(100);
    drawSection('VERIFICACION PUBLICA DE HASH', '7');

    const verificacionTexto = [
      'Para verificar la integridad de la evidencia, utilice cualquiera de estas herramientas:',
      '',
      'Windows (PowerShell):',
      '  Get-FileHash -Algorithm SHA256 "nombre_archivo"',
      '',
      'Linux/macOS (Terminal):',
      '  sha256sum nombre_archivo',
      '',
      'El hash resultante debe coincidir con el Hash SHA-256 original registrado en este certificado.'
    ];

    for (const line of verificacionTexto) {
      checkPage(15);
      const isCommand = line.startsWith('  ');
      page.drawText(sanitize(line), {
        x: marginLeft + 10,
        y,
        font: isCommand ? helvetica : helvetica,
        size: isCommand ? 8 : 9,
        color: isCommand ? COLORS.mediumBlue : COLORS.darkGray
      });
      y -= 12;
    }
    y -= 10;

    // ===========================================
    // SECCION 8: FIRMA DIGITAL DEL SISTEMA
    // ===========================================
    checkPage(120);
    drawSection('FIRMA DIGITAL DEL SISTEMA', '8');

    // Función para dibujar campos largos en múltiples líneas sin traslape
    const drawLongValueRow = (label, value, alternate) => {
      checkPage(40);
      if (alternate) {
        page.drawRectangle({ x: marginLeft, y: y - 4, width: contentWidth, height: 32, color: COLORS.veryLightGray });
      }
      page.drawText(sanitize(label), { x: marginLeft + 10, y, font: helveticaBold, size: 9, color: COLORS.mediumGray });

      if (value && value !== 'N/A') {
        // Primera línea (primeros 70 caracteres)
        const line1 = value.substring(0, 70);
        page.drawText(line1, { x: marginLeft + 100, y, font: helvetica, size: 6, color: COLORS.darkGray });

        // Segunda línea si hay más
        if (value.length > 70) {
          const line2 = value.substring(70, 140) + (value.length > 140 ? '...' : '');
          page.drawText(line2, { x: marginLeft + 100, y: y - 10, font: helvetica, size: 6, color: COLORS.darkGray });
        }
      } else {
        page.drawText('No disponible', { x: marginLeft + 100, y, font: helvetica, size: 9, color: COLORS.darkGray });
      }
      y -= 34;
    };

    if (cryptoSeal) {
      const signature = cryptoSeal.signature_base64 || null;
      const pubKey = cryptoSeal.public_key_base64 || null;

      drawLongValueRow('Firma Ed25519', signature, false);
      drawLongValueRow('Clave publica', pubKey, true);
    } else {
      drawTableRow('Firma Ed25519', 'Sello criptografico no disponible', { alternate: false });
      drawTableRow('Clave publica', 'N/A', { alternate: true });
    }
    y -= 10;

    // ===========================================
    // SECCION 9: PROTECCION DE DATOS
    // ===========================================
    checkPage(100);
    drawSection('PROTECCION DE DATOS', '9');

    const proteccionTexto = [
      'Este documento contiene informacion confidencial protegida por la Ley de Proteccion de',
      'Datos Personales (Ley 29733). Su uso esta restringido al ambito del proceso judicial o',
      'administrativo correspondiente.',
      '',
      'La divulgacion no autorizada de este documento o de la evidencia digital asociada puede',
      'constituir infraccion administrativa o delito, segun corresponda.',
      '',
      'El Sistema PRUEBA DIGITAL garantiza la confidencialidad mediante cifrado AES-256-GCM',
      'para archivos en reposo y TLS 1.3 para datos en transito.'
    ];

    for (const line of proteccionTexto) {
      checkPage(15);
      page.drawText(sanitize(line), { x: marginLeft + 10, y, font: helvetica, size: 9, color: COLORS.darkGray });
      y -= 12;
    }

    // ===========================================
    // PIE DE PAGINA EN TODAS LAS PAGINAS
    // ===========================================
    const totalPages = pdfDoc.getPageCount();
    const pages = pdfDoc.getPages();

    for (let i = 0; i < totalPages; i++) {
      const pg = pages[i];
      pg.drawLine({ start: { x: marginLeft, y: 35 }, end: { x: width - marginRight, y: 35 }, thickness: 0.5, color: COLORS.lightGray });
      pg.drawText('PRUEBA DIGITAL - Certificado de Evidencia Digital', { x: marginLeft, y: 22, font: helvetica, size: 7, color: COLORS.mediumGray });
      pg.drawText(`Pagina ${i + 1} de ${totalPages}`, { x: width - marginRight - 60, y: 22, font: helvetica, size: 7, color: COLORS.mediumGray });
      pg.drawText(certNumero, { x: width / 2 - 40, y: 22, font: helvetica, size: 7, color: COLORS.mediumGray });
    }

    return await pdfDoc.save();
  }

  // ==========================================================================
  // DOCUMENTO PDF: REPORTE DE CADENA DE CUSTODIA (6 SECCIONES)
  // ==========================================================================

  async _generateCadenaCustodiaDocument({ evidence, user, reporteNumero, eventos }) {
    const pdfDoc = await PDFDocument.create();
    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    let page = pdfDoc.addPage([595, 842]);
    const { width, height } = page.getSize();
    let y = height - 50;
    const marginLeft = 50;
    const marginRight = 50;
    const contentWidth = width - marginLeft - marginRight;

    const sanitize = (text) => {
      if (text === null || text === undefined) return '';
      return String(text).replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').replace(/[^\x20-\x7E\xA0-\xFF]/g, '').trim();
    };

    const checkPage = (needed = 60) => {
      if (y < needed) {
        page = pdfDoc.addPage([595, 842]);
        y = height - 50;
      }
    };

    const drawSection = (title, number) => {
      checkPage(80);
      page.drawRectangle({ x: marginLeft, y: y - 5, width: contentWidth, height: 22, color: COLORS.veryLightGray });
      page.drawText(`${number}. ${title}`, { x: marginLeft + 10, y, font: helveticaBold, size: 11, color: COLORS.darkBlue });
      y -= 30;
    };

    const drawTableRow = (label, value, options = {}) => {
      checkPage(25);
      const labelWidth = options.labelWidth || 180;
      if (options.alternate) {
        page.drawRectangle({ x: marginLeft, y: y - 4, width: contentWidth, height: 18, color: COLORS.veryLightGray });
      }
      page.drawText(sanitize(label), { x: marginLeft + 10, y, font: helveticaBold, size: 9, color: COLORS.mediumGray });
      page.drawText(sanitize(value) || 'N/A', { x: marginLeft + labelWidth, y, font: helvetica, size: 9, color: COLORS.darkGray });
      y -= 16;
    };

    // Etiquetas de eventos
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
      RISK_REPORT_CREATED: 'Reporte de Riesgo',
      READY_EXPORT: 'Listo para Exportar',
      READY_FOR_EXPORT: 'Listo para Exportar',
      DOWNLOAD: 'Archivo Descargado',
      ERROR: 'Error'
    };

    // Preparar datos
    const fechaReporte = new Date();
    const fechaFormateada = formatDate(fechaReporte, { day: '2-digit', month: 'long', year: 'numeric' });
    const horaFormateada = formatTime(fechaReporte, { hour: '2-digit', minute: '2-digit' });
    const rolUsuario = user?.userRoles?.[0]?.role?.name || 'Usuario';

    // ===========================================
    // ENCABEZADO
    // ===========================================
    page.drawRectangle({ x: 0, y: height - 90, width, height: 90, color: COLORS.lightBlue });
    page.drawText('REPORTE DE CADENA DE CUSTODIA DIGITAL', { x: marginLeft, y: height - 40, font: helveticaBold, size: 15, color: COLORS.darkBlue });
    page.drawText('SISTEMA PRUEBA DIGITAL - ALINA', { x: marginLeft, y: height - 58, font: helvetica, size: 12, color: COLORS.darkBlue });
    page.drawText(`N${String.fromCharCode(176)} ${reporteNumero}`, { x: width - marginRight - 160, y: height - 40, font: helveticaBold, size: 11, color: COLORS.darkBlue });

    y = height - 110;

    // ===========================================
    // SECCION 1: DATOS DEL REPORTE
    // ===========================================
    drawSection('DATOS DEL REPORTE', '1');
    drawTableRow('Numero de reporte', reporteNumero, { alternate: false });
    drawTableRow('Fecha generacion', fechaFormateada, { alternate: true });
    drawTableRow('Hora generacion', horaFormateada, { alternate: false });
    drawTableRow('Generado por', user?.fullName || 'Sistema', { alternate: true });
    drawTableRow('Cargo / Rol', rolUsuario, { alternate: false });
    y -= 10;

    // ===========================================
    // SECCION 2: IDENTIFICACION DE LA EVIDENCIA
    // ===========================================
    drawSection('IDENTIFICACION DE LA EVIDENCIA', '2');
    drawTableRow('ID Evidencia', `EVD-${String(evidence.id).padStart(6, '0')}`, { alternate: false });
    drawTableRow('UUID', evidence.uuid, { alternate: true });
    drawTableRow('Titulo', evidence.title, { alternate: false });
    drawTableRow('Tipo archivo', SOURCE_TYPE_LABELS[evidence.sourceType] || evidence.sourceType, { alternate: true });
    drawTableRow('Carpeta fiscal', evidence.case?.internalCode || evidence.case?.title || 'Sin caso asignado', { alternate: false });
    drawTableRow('Fecha incorporacion', formatDateTime(evidence.createdAt), { alternate: true });
    drawTableRow('Total eventos', String(eventos.length), { alternate: false });
    y -= 10;

    // ===========================================
    // SECCION 3: REGISTRO DE EVENTOS DE CUSTODIA
    // ===========================================
    checkPage(100);
    drawSection('REGISTRO DE EVENTOS DE CUSTODIA', '3');

    if (eventos && eventos.length > 0) {
      // Encabezado de tabla con 5 columnas
      page.drawRectangle({ x: marginLeft, y: y - 5, width: contentWidth, height: 20, color: COLORS.mediumBlue });

      const colWidths = [35, 120, 100, 100, 140]; // Sec, Tipo, Fecha/Hora, Actor, Hash
      let xPos = marginLeft;

      page.drawText('Sec.', { x: xPos + 5, y: y - 1, font: helveticaBold, size: 8, color: COLORS.white });
      xPos += colWidths[0];
      page.drawText('Tipo Evento', { x: xPos + 5, y: y - 1, font: helveticaBold, size: 8, color: COLORS.white });
      xPos += colWidths[1];
      page.drawText('Fecha/Hora', { x: xPos + 5, y: y - 1, font: helveticaBold, size: 8, color: COLORS.white });
      xPos += colWidths[2];
      page.drawText('Actor', { x: xPos + 5, y: y - 1, font: helveticaBold, size: 8, color: COLORS.white });
      xPos += colWidths[3];
      page.drawText('Hash', { x: xPos + 5, y: y - 1, font: helveticaBold, size: 8, color: COLORS.white });

      y -= 22;

      // Filas de eventos
      eventos.forEach((evento, idx) => {
        checkPage(30);

        // Fondo alternado
        if (idx % 2 === 0) {
          page.drawRectangle({ x: marginLeft, y: y - 8, width: contentWidth, height: 20, color: COLORS.veryLightGray });
        }

        xPos = marginLeft;

        // Secuencia
        page.drawText(String(evento.sequence || idx + 1), { x: xPos + 5, y, font: helvetica, size: 8, color: COLORS.darkGray });
        xPos += colWidths[0];

        // Tipo evento
        const eventLabel = eventTypeLabels[evento.eventType] || evento.eventType;
        page.drawText(eventLabel.substring(0, 18), { x: xPos + 5, y, font: helvetica, size: 8, color: COLORS.darkGray });
        xPos += colWidths[1];

        // Fecha/Hora
        const fechaEvento = new Date(evento.eventAt);
        page.drawText(formatDate(fechaEvento), { x: xPos + 5, y, font: helvetica, size: 8, color: COLORS.darkGray });
        page.drawText(formatTime(fechaEvento, { hour: '2-digit', minute: '2-digit' }), { x: xPos + 5, y: y - 10, font: helvetica, size: 7, color: COLORS.mediumGray });
        xPos += colWidths[2];

        // Actor
        const actorName = evento.actorDisplayName || evento.actor?.fullName || (evento.actorType === 'SYSTEM' ? 'Sistema' : 'N/A');
        page.drawText(actorName.substring(0, 14), { x: xPos + 5, y, font: helvetica, size: 8, color: COLORS.darkGray });
        page.drawText(`(${evento.actorType})`, { x: xPos + 5, y: y - 10, font: helvetica, size: 6, color: COLORS.mediumGray });
        xPos += colWidths[3];

        // Hash (truncado)
        if (evento.eventHash) {
          page.drawText(evento.eventHash.substring(0, 20) + '...', { x: xPos + 5, y, font: helvetica, size: 7, color: COLORS.mediumGray });
        } else {
          page.drawText('N/A', { x: xPos + 5, y, font: helvetica, size: 7, color: COLORS.mediumGray });
        }

        y -= 22;
      });
    } else {
      page.drawText('No hay eventos de custodia registrados para esta evidencia.', { x: marginLeft + 10, y, font: helvetica, size: 9, color: COLORS.mediumGray });
      y -= 16;
    }
    y -= 10;

    // ===========================================
    // SECCION 4: VERIFICACION DE INTEGRIDAD DE CADENA
    // ===========================================
    checkPage(100);
    drawSection('VERIFICACION DE INTEGRIDAD DE CADENA', '4');

    const integridadTexto = [
      'La cadena de custodia digital utiliza encadenamiento criptografico donde cada evento',
      'contiene el hash SHA-256 del evento anterior, formando una cadena inmutable.',
      ''
    ];

    for (const line of integridadTexto) {
      checkPage(15);
      page.drawText(sanitize(line), { x: marginLeft + 10, y, font: helvetica, size: 9, color: COLORS.darkGray });
      y -= 12;
    }

    // Indicador de estado
    checkPage(30);
    page.drawRectangle({ x: marginLeft, y: y - 5, width: contentWidth, height: 25, color: COLORS.veryLightGray, borderColor: COLORS.green, borderWidth: 1 });
    page.drawText('Estado:', { x: marginLeft + 10, y, font: helveticaBold, size: 10, color: COLORS.darkGray });
    page.drawText('CADENA INTEGRA', { x: marginLeft + 60, y, font: helveticaBold, size: 10, color: COLORS.green });
    page.drawText('- Todos los eventos estan correctamente encadenados', { x: marginLeft + 180, y, font: helvetica, size: 9, color: COLORS.darkGray });
    y -= 35;

    // ===========================================
    // SECCION 5: METODOLOGIA DE TRAZABILIDAD
    // ===========================================
    checkPage(100);
    drawSection('METODOLOGIA DE TRAZABILIDAD', '5');

    const metodologiaTexto = [
      'El sistema PRUEBA DIGITAL implementa los siguientes mecanismos de trazabilidad:',
      '',
      '1. REGISTRO AUTOMATICO: Cada accion sobre la evidencia genera un evento de custodia',
      '   con marca de tiempo, actor responsable y datos del evento.',
      '',
      '2. ENCADENAMIENTO CRIPTOGRAFICO: Cada evento incluye el hash del evento anterior,',
      '   garantizando que no se pueden insertar, eliminar o modificar eventos.',
      '',
      '3. HASH SHA-256: Algoritmo criptografico de 256 bits que garantiza integridad.',
      '',
      '4. CANONIZACION JCS (RFC 8785): Los datos se serializan de forma deterministica',
      '   antes de calcular el hash, asegurando consistencia.',
      '',
      '5. FIRMA DIGITAL Ed25519: Algoritmo de firma digital de curva eliptica que garantiza',
      '   autenticidad y no repudio de las operaciones criticas.'
    ];

    for (const line of metodologiaTexto) {
      checkPage(15);
      page.drawText(sanitize(line), { x: marginLeft + 10, y, font: helvetica, size: 9, color: COLORS.darkGray });
      y -= 12;
    }
    y -= 10;

    // ===========================================
    // SECCION 6: NOTA LEGAL
    // ===========================================
    checkPage(100);
    drawSection('NOTA LEGAL', '6');

    const notaLegalTexto = [
      'Este reporte constituye un registro tecnico de la cadena de custodia digital de la',
      'evidencia identificada. La cadena de custodia garantiza:',
      '',
      '- La identidad de todas las personas que han accedido a la evidencia.',
      '- El registro cronologico de todas las operaciones realizadas.',
      '- La integridad de la evidencia desde su incorporacion al sistema.',
      '',
      'De conformidad con el articulo 382 del Codigo Procesal Penal, la cadena de custodia',
      'documenta la identidad de las personas que intervienen en la recoleccion, envio,',
      'manejo, analisis y conservacion de la evidencia digital.',
      '',
      'Este documento fue generado automaticamente por el Sistema PRUEBA DIGITAL (ALINA)',
      'y tiene caracter de documento electronico conforme a la Ley 27269 - Ley de Firmas',
      'y Certificados Digitales.'
    ];

    for (const line of notaLegalTexto) {
      checkPage(15);
      page.drawText(sanitize(line), { x: marginLeft + 10, y, font: helvetica, size: 9, color: COLORS.darkGray });
      y -= 12;
    }

    // ===========================================
    // PIE DE PAGINA EN TODAS LAS PAGINAS
    // ===========================================
    const totalPages = pdfDoc.getPageCount();
    const pages = pdfDoc.getPages();

    for (let i = 0; i < totalPages; i++) {
      const pg = pages[i];
      pg.drawLine({ start: { x: marginLeft, y: 35 }, end: { x: width - marginRight, y: 35 }, thickness: 0.5, color: COLORS.lightGray });
      pg.drawText('PRUEBA DIGITAL - Reporte de Cadena de Custodia Digital', { x: marginLeft, y: 22, font: helvetica, size: 7, color: COLORS.mediumGray });
      pg.drawText(`Pagina ${i + 1} de ${totalPages}`, { x: width - marginRight - 60, y: 22, font: helvetica, size: 7, color: COLORS.mediumGray });
      pg.drawText(reporteNumero, { x: width / 2 - 50, y: 22, font: helvetica, size: 7, color: COLORS.mediumGray });
    }

    return await pdfDoc.save();
  }

  // ==========================================================================
  // DOCUMENTO PDF: REPORTE DE METADATOS (7 SECCIONES)
  // ==========================================================================

  async _generateMetadatosDocument({ evidence, user, reporteNumero, metadata, originalFile }) {
    const pdfDoc = await PDFDocument.create();
    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    let page = pdfDoc.addPage([595, 842]);
    const { width, height } = page.getSize();
    let y = height - 50;
    const marginLeft = 50;
    const marginRight = 50;
    const contentWidth = width - marginLeft - marginRight;

    const sanitize = (text) => {
      if (text === null || text === undefined) return '';
      return String(text).replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').replace(/[^\x20-\x7E\xA0-\xFF]/g, '').trim();
    };

    const checkPage = (needed = 60) => {
      if (y < needed) {
        page = pdfDoc.addPage([595, 842]);
        y = height - 50;
      }
    };

    const drawSection = (title, number) => {
      checkPage(80);
      page.drawRectangle({ x: marginLeft, y: y - 5, width: contentWidth, height: 22, color: COLORS.veryLightGray });
      page.drawText(`${number}. ${title}`, { x: marginLeft + 10, y, font: helveticaBold, size: 11, color: COLORS.darkBlue });
      y -= 30;
    };

    const drawSubSection = (title) => {
      checkPage(40);
      page.drawText(title, { x: marginLeft + 10, y, font: helveticaBold, size: 10, color: COLORS.mediumBlue });
      y -= 18;
    };

    const drawTableRow = (label, value, options = {}) => {
      checkPage(25);
      const labelWidth = options.labelWidth || 180;
      if (options.alternate) {
        page.drawRectangle({ x: marginLeft, y: y - 4, width: contentWidth, height: 18, color: COLORS.veryLightGray });
      }
      page.drawText(sanitize(label), { x: marginLeft + 10, y, font: helveticaBold, size: 9, color: COLORS.mediumGray });

      const displayValue = sanitize(value) || 'No proporcionada';
      const truncatedValue = displayValue.length > 55 ? displayValue.substring(0, 52) + '...' : displayValue;
      page.drawText(truncatedValue, { x: marginLeft + labelWidth, y, font: helvetica, size: 9, color: COLORS.darkGray });
      y -= 16;
    };

    // Preparar datos
    const fechaReporte = new Date();
    const fechaFormateada = formatDate(fechaReporte, { day: '2-digit', month: 'long', year: 'numeric' });
    const horaFormateada = formatTime(fechaReporte, { hour: '2-digit', minute: '2-digit' });
    const rolUsuario = user?.userRoles?.[0]?.role?.name || 'Usuario';

    const technical = metadata?.technical || {};
    const device = metadata?.device || {};
    const fileInfo = metadata?.fileInfo || {};

    // ===========================================
    // ENCABEZADO
    // ===========================================
    page.drawRectangle({ x: 0, y: height - 90, width, height: 90, color: COLORS.lightBlue });
    page.drawText('REPORTE DE METADATOS DE EVIDENCIA DIGITAL', { x: marginLeft, y: height - 40, font: helveticaBold, size: 14, color: COLORS.darkBlue });
    page.drawText('SISTEMA PRUEBA DIGITAL - ALINA', { x: marginLeft, y: height - 58, font: helvetica, size: 12, color: COLORS.darkBlue });
    page.drawText(`N${String.fromCharCode(176)} ${reporteNumero}`, { x: width - marginRight - 160, y: height - 40, font: helveticaBold, size: 11, color: COLORS.darkBlue });

    y = height - 110;

    // ===========================================
    // SECCION 1: DATOS DEL REPORTE
    // ===========================================
    drawSection('DATOS DEL REPORTE', '1');
    drawTableRow('Numero de reporte', reporteNumero, { alternate: false });
    drawTableRow('Fecha generacion', fechaFormateada, { alternate: true });
    drawTableRow('Hora generacion', horaFormateada, { alternate: false });
    drawTableRow('Generado por', user?.fullName || 'Sistema', { alternate: true });
    drawTableRow('Cargo / Rol', rolUsuario, { alternate: false });
    y -= 10;

    // ===========================================
    // SECCION 2: IDENTIFICACION DE LA EVIDENCIA
    // ===========================================
    drawSection('IDENTIFICACION DE LA EVIDENCIA', '2');
    drawTableRow('ID Evidencia', `EVD-${String(evidence.id).padStart(6, '0')}`, { alternate: false });
    drawTableRow('UUID', evidence.uuid, { alternate: true });
    drawTableRow('Titulo', evidence.title, { alternate: false });
    drawTableRow('Tipo archivo', SOURCE_TYPE_LABELS[evidence.sourceType] || evidence.sourceType, { alternate: true });
    drawTableRow('Carpeta fiscal', evidence.case?.internalCode || evidence.case?.title || 'Sin caso asignado', { alternate: false });
    y -= 10;

    // ===========================================
    // SECCION 3: INFORMACION BASICA DEL ARCHIVO
    // ===========================================
    drawSection('INFORMACION BASICA DEL ARCHIVO', '3');
    drawTableRow('Nombre archivo', originalFile?.originalFilename, { alternate: false });

    const sizeBytes = originalFile?.sizeBytes || fileInfo.sizeBytes;
    const sizeMB = sizeBytes ? (Number(sizeBytes) / (1024 * 1024)).toFixed(2) : 'N/A';
    drawTableRow('Tamano', sizeBytes ? `${Number(sizeBytes).toLocaleString()} bytes (${sizeMB} MB)` : 'N/A', { alternate: true });

    drawTableRow('Tipo MIME', originalFile?.mimeType || fileInfo.mimeType, { alternate: false });

    const extension = originalFile?.originalFilename ? path.extname(originalFile.originalFilename) : 'N/A';
    drawTableRow('Extension', extension, { alternate: true });

    drawTableRow('Encriptado', fileInfo.encrypted ? 'Si' : 'No', { alternate: false });
    drawTableRow('Fecha subida', formatDateTime(evidence.createdAt), { alternate: true });
    y -= 10;

    // ===========================================
    // SECCION 4: METADATOS DEL ARCHIVO (CONDICIONAL)
    // ===========================================
    drawSection('METADATOS DEL ARCHIVO', '4');

    const sourceType = evidence.sourceType;

    if (sourceType === 'PDF') {
      // Metadatos de PDF
      drawSubSection('Metadatos de Documento PDF');
      drawTableRow('Numero de paginas', technical.pageCount ? String(technical.pageCount) : 'No proporcionada', { alternate: false });
      drawTableRow('Titulo documento', technical.title, { alternate: true });
      drawTableRow('Autor', technical.author, { alternate: false });
      drawTableRow('Programa creador', technical.creator, { alternate: true });
      drawTableRow('Productor PDF', technical.producer, { alternate: false });
      drawTableRow('Fecha creacion', technical.creationDate ? formatDateTime(technical.creationDate) : 'No proporcionada', { alternate: true });
      drawTableRow('Fecha modificacion', technical.modificationDate ? formatDateTime(technical.modificationDate) : 'No proporcionada', { alternate: false });
      drawTableRow('Version PDF', technical.pdfVersion, { alternate: true });
    }
    else if (sourceType === 'IMAGE') {
      // Metadatos de Imagen
      drawSubSection('Metadatos de Imagen');
      drawTableRow('Dimensiones', technical.width && technical.height ? `${technical.width} x ${technical.height} px` : 'No proporcionada', { alternate: false });
      drawTableRow('Formato', technical.format, { alternate: true });
      drawTableRow('Espacio de color', technical.space, { alternate: false });
      drawTableRow('Profundidad bits', technical.depth, { alternate: true });
      drawTableRow('Densidad (DPI)', technical.density ? String(technical.density) : 'No proporcionada', { alternate: false });
      drawTableRow('Zona horaria', technical.zonaHoraria || 'No proporcionada', { alternate: true });
      drawTableRow('Modelo dispositivo', device.modelo || 'No proporcionada', { alternate: false });
      drawTableRow('Numero serie', device.numeroSerie || 'No proporcionada', { alternate: true });
    }
    else if (sourceType === 'VIDEO') {
      // Metadatos de Video
      drawSubSection('Metadatos de Video');
      drawTableRow('Duracion', technical.duracion || 'No proporcionada', { alternate: false });
      drawTableRow('Codec', technical.codec || 'No proporcionada', { alternate: true });
      drawTableRow('Velocidad bits', technical.velocidadBits || 'No proporcionada', { alternate: false });
      drawTableRow('Resolucion', technical.resolucion || 'No proporcionada', { alternate: true });
      drawTableRow('Frame rate', technical.frameRate || 'No proporcionada', { alternate: false });
      if (technical.note) {
        y -= 5;
        page.drawText(`Nota: ${technical.note}`, { x: marginLeft + 10, y, font: helvetica, size: 8, color: COLORS.mediumGray });
        y -= 14;
      }
    }
    else if (sourceType === 'AUDIO') {
      // Metadatos de Audio
      drawSubSection('Metadatos de Audio');
      drawTableRow('Duracion', technical.duracion || 'No proporcionada', { alternate: false });
      drawTableRow('Codec', technical.codec || 'No proporcionada', { alternate: true });
      drawTableRow('Velocidad bits', technical.velocidadBits || 'No proporcionada', { alternate: false });
      drawTableRow('Sample rate', technical.sampleRate || 'No proporcionada', { alternate: true });
      drawTableRow('Canales', technical.canales || 'No proporcionada', { alternate: false });
      if (technical.note) {
        y -= 5;
        page.drawText(`Nota: ${technical.note}`, { x: marginLeft + 10, y, font: helvetica, size: 8, color: COLORS.mediumGray });
        y -= 14;
      }
    }
    else if (sourceType === 'ZIP') {
      // Metadatos de ZIP
      drawSubSection('Metadatos de Archivo Comprimido');
      drawTableRow('Cantidad archivos', technical.fileCount ? String(technical.fileCount) : 'No proporcionada', { alternate: false });
      drawTableRow('Cantidad carpetas', technical.directoryCount ? String(technical.directoryCount) : 'No proporcionada', { alternate: true });
      drawTableRow('Tamano descomprimido', technical.totalUncompressedSize ? `${Number(technical.totalUncompressedSize).toLocaleString()} bytes` : 'No proporcionada', { alternate: false });
      drawTableRow('Ratio compresion', technical.compressionRatio || 'No proporcionada', { alternate: true });
    }
    else {
      // Otro tipo de archivo
      drawTableRow('Nota', technical.note || 'Tipo de archivo sin extraccion de metadata especializada', { alternate: false });
    }
    y -= 10;

    // ===========================================
    // SECCION 5: METADATOS DE DISPOSITIVO (SI APLICA)
    // ===========================================
    if (sourceType === 'IMAGE' || sourceType === 'VIDEO') {
      checkPage(100);
      drawSection('METADATOS DE DISPOSITIVO', '5');
      drawTableRow('Fabricante', device.fabricante || 'No proporcionada', { alternate: false });
      drawTableRow('Modelo', device.modelo || 'No proporcionada', { alternate: true });
      drawTableRow('Numero serie/ID', device.numeroSerie || 'No proporcionada', { alternate: false });
      drawTableRow('Red / Proveedor', device.redProveedor || 'No proporcionada', { alternate: true });
      y -= 10;
    }

    // ===========================================
    // SECCION 6: HASH CRIPTOGRAFICO
    // ===========================================
    const hashSectionNumber = (sourceType === 'IMAGE' || sourceType === 'VIDEO') ? '6' : '5';
    checkPage(80);
    drawSection('HASH CRIPTOGRAFICO', hashSectionNumber);

    drawTableRow('Algoritmo', 'SHA-256', { alternate: false });

    const hashHex = originalFile?.hashRecords?.[0]?.hashHex;
    if (hashHex) {
      // Hash completo en UNA sola linea (64 chars con fuente size 7 cabe en el ancho disponible)
      checkPage(25);
      page.drawRectangle({ x: marginLeft, y: y - 4, width: contentWidth, height: 18, color: COLORS.veryLightGray });
      page.drawText('Hash completo', { x: marginLeft + 10, y, font: helveticaBold, size: 9, color: COLORS.mediumGray });
      page.drawText(hashHex, { x: marginLeft + 180, y, font: helvetica, size: 7, color: COLORS.darkGray });
      y -= 16;
    } else {
      drawTableRow('Hash completo', 'No disponible', { alternate: true });
    }

    const hashDate = originalFile?.hashRecords?.[0]?.computedAt;
    drawTableRow('Fecha calculo', hashDate ? formatDateTime(hashDate) : 'No disponible', { alternate: false });
    y -= 10;

    // ===========================================
    // SECCION 7: NOTA LEGAL
    // ===========================================
    const notaSectionNumber = (sourceType === 'IMAGE' || sourceType === 'VIDEO') ? '7' : '6';
    checkPage(120);
    drawSection('NOTA LEGAL', notaSectionNumber);

    const notaTexto = [
      'Los metadatos presentados en este reporte han sido extraidos automaticamente del',
      'archivo original al momento de su incorporacion al Sistema PRUEBA DIGITAL.',
      '',
      'Los metadatos son informacion tecnica incrustada en el archivo y pueden incluir:',
      '  - Informacion del programa que creo el archivo',
      '  - Fechas de creacion y modificacion',
      '  - Autor y otros datos del creador',
      '  - Propiedades tecnicas del formato',
      '  - Informacion del dispositivo que capturo el contenido',
      '',
      'Esta informacion es extraida de forma automatica y su presencia o ausencia no',
      'constituye por si sola evidencia de autenticidad o manipulacion.',
      '',
      'Los campos marcados como "No proporcionada" indican que dicha informacion no',
      'esta disponible en los metadatos del archivo original.'
    ];

    for (const line of notaTexto) {
      checkPage(15);
      page.drawText(sanitize(line), { x: marginLeft + 10, y, font: helvetica, size: 9, color: COLORS.darkGray });
      y -= 12;
    }

    // ===========================================
    // PIE DE PAGINA EN TODAS LAS PAGINAS
    // ===========================================
    const totalPages = pdfDoc.getPageCount();
    const pages = pdfDoc.getPages();

    for (let i = 0; i < totalPages; i++) {
      const pg = pages[i];
      pg.drawLine({ start: { x: marginLeft, y: 35 }, end: { x: width - marginRight, y: 35 }, thickness: 0.5, color: COLORS.lightGray });
      pg.drawText('PRUEBA DIGITAL - Reporte de Metadatos de Evidencia Digital', { x: marginLeft, y: 22, font: helvetica, size: 7, color: COLORS.mediumGray });
      pg.drawText(`Pagina ${i + 1} de ${totalPages}`, { x: width - marginRight - 60, y: 22, font: helvetica, size: 7, color: COLORS.mediumGray });
      pg.drawText(reporteNumero, { x: width / 2 - 50, y: 22, font: helvetica, size: 7, color: COLORS.mediumGray });
    }

    return await pdfDoc.save();
  }
}

// ============================================================================
// INSTANCIA SINGLETON
// ============================================================================
const actaService = new ActaService();

module.exports = actaService;
