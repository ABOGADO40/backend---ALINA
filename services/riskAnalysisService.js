// ============================================================================
// RISK ANALYSIS SERVICE - Motor de indicios de manipulacion
// Sistema PRUEBA DIGITAL
// ============================================================================

const { prisma } = require('../config/db');

// ============================================================================
// REGLA JURIDICA BASE
// ============================================================================
const LEGAL_DISCLAIMER = 'Bajo las variables indicadas se observan indicios de posible manipulacion. Requiere peritaje especializado.';
const NO_INDICATORS_MESSAGE = 'No se detectaron indicios de posible manipulacion bajo las variables analizadas.';

// ============================================================================
// CLASE DE SERVICIO DE ANALISIS DE RIESGO
// ============================================================================

class RiskAnalysisService {
  // ==========================================================================
  // ANALIZAR SEGUN TIPO
  // ==========================================================================

  /**
   * Analiza una evidencia y genera reporte de indicios
   * @param {string} sourceType - Tipo de fuente
   * @param {Object} metadata - Metadata extraida
   * @returns {Object}
   */
  analyze(sourceType, metadata) {
    let rules = [];

    switch (sourceType) {
      case 'IMAGE':
        rules = this._analyzeImage(metadata);
        break;
      case 'VIDEO':
        rules = this._analyzeVideo(metadata);
        break;
      case 'AUDIO':
        rules = this._analyzeAudio(metadata);
        break;
      case 'PDF':
        rules = this._analyzePdf(metadata);
        break;
      case 'ZIP':
        rules = this._analyzeZip(metadata);
        break;
      default:
        rules = this._analyzeGeneric(metadata);
    }

    return {
      rulesTriggered: rules,
      summary: this._generateSummary(rules),
      analyzedAt: new Date().toISOString(),
      sourceType
    };
  }

  // ==========================================================================
  // ANALISIS DE IMAGENES
  // ==========================================================================

  _analyzeImage(metadata) {
    const rules = [];
    const tech = metadata.technical || {};

    // EXIF_MISSING - verificar si tiene datos EXIF (fecha de captura como proxy)
    if (!tech.fechaCaptura && !tech.software) {
      rules.push({
        code: 'EXIF_MISSING',
        severity: 'LOW',
        description: 'No se encontro informacion EXIF en la imagen (fecha de captura y software ausentes)',
        variables: ['fechaCaptura', 'software']
      });
    }

    // EDIT_SOFTWARE_DETECTED
    if (tech.icc && tech.icc.description) {
      const editSoftware = ['photoshop', 'gimp', 'lightroom', 'capture one', 'affinity'];
      const descLower = tech.icc.description.toLowerCase();
      for (const sw of editSoftware) {
        if (descLower.includes(sw)) {
          rules.push({
            code: 'EDIT_SOFTWARE_DETECTED',
            severity: 'MEDIUM',
            description: `Software de edicion detectado: ${tech.icc.description}`,
            variables: ['icc.description']
          });
          break;
        }
      }
    }

    // RECOMPRESS_INDICATORS
    if (tech.format === 'jpeg' && tech.density) {
      if (tech.density < 72 || tech.density > 300) {
        rules.push({
          code: 'UNUSUAL_DENSITY',
          severity: 'LOW',
          description: `Densidad inusual detectada: ${tech.density} DPI`,
          variables: ['density']
        });
      }
    }

    // EXTENSION_HEADER_MISMATCH
    if (metadata.fileInfo) {
      const mimeFormat = metadata.fileInfo.mimeType?.split('/')[1];
      if (mimeFormat && tech.format && mimeFormat.toLowerCase() !== tech.format.toLowerCase()) {
        rules.push({
          code: 'EXTENSION_HEADER_MISMATCH',
          severity: 'HIGH',
          description: `El tipo MIME (${mimeFormat}) no coincide con el formato detectado (${tech.format})`,
          variables: ['mimeType', 'format']
        });
      }
    }

    return rules;
  }

  // ==========================================================================
  // ANALISIS DE VIDEO
  // ==========================================================================

  _analyzeVideo(metadata) {
    const rules = [];
    const tech = metadata.technical || {};

    // ENCODER_ANOMALY
    if (tech.codec && tech.encoder) {
      const suspiciousEncoders = ['lavf', 'ffmpeg', 'handbrake'];
      for (const enc of suspiciousEncoders) {
        if (tech.encoder.toLowerCase().includes(enc)) {
          rules.push({
            code: 'REENCODING_DETECTED',
            severity: 'LOW',
            description: `Encoder de conversion detectado: ${tech.encoder}`,
            variables: ['encoder']
          });
          break;
        }
      }
    }

    // CREATION_TIME_ISSUE
    if (!tech.creationTime) {
      rules.push({
        code: 'CREATION_TIME_MISSING',
        severity: 'MEDIUM',
        description: 'Fecha de creacion ausente en metadata del video',
        variables: ['creationTime']
      });
    }

    // AUDIO_VIDEO_MISALIGN
    if (tech.hasAudio === false && tech.duration > 10) {
      rules.push({
        code: 'AUDIO_TRACK_MISSING',
        severity: 'LOW',
        description: 'Video sin pista de audio detectado',
        variables: ['hasAudio', 'duration']
      });
    }

    return rules;
  }

  // ==========================================================================
  // ANALISIS DE AUDIO
  // ==========================================================================

  _analyzeAudio(metadata) {
    const rules = [];
    const tech = metadata.technical || {};

    // SAMPLE_RATE_UNUSUAL
    if (tech.sampleRate) {
      const commonRates = [8000, 11025, 16000, 22050, 32000, 44100, 48000, 96000];
      if (!commonRates.includes(tech.sampleRate)) {
        rules.push({
          code: 'SAMPLE_RATE_UNUSUAL',
          severity: 'LOW',
          description: `Frecuencia de muestreo inusual: ${tech.sampleRate} Hz`,
          variables: ['sampleRate']
        });
      }
    }

    // EDITOR_METADATA
    if (tech.software) {
      const editSoftware = ['audacity', 'adobe audition', 'pro tools', 'logic'];
      const swLower = tech.software.toLowerCase();
      for (const sw of editSoftware) {
        if (swLower.includes(sw)) {
          rules.push({
            code: 'AUDIO_EDITOR_DETECTED',
            severity: 'MEDIUM',
            description: `Software de edicion de audio detectado: ${tech.software}`,
            variables: ['software']
          });
          break;
        }
      }
    }

    return rules;
  }

  // ==========================================================================
  // ANALISIS DE PDF
  // ==========================================================================

  _analyzePdf(metadata) {
    const rules = [];
    const tech = metadata.technical || {};

    // PRODUCER_CREATOR
    if (tech.producer) {
      const editTools = ['pdf editor', 'foxit', 'nitro', 'sejda', 'ilovepdf'];
      const prodLower = tech.producer.toLowerCase();
      for (const tool of editTools) {
        if (prodLower.includes(tool)) {
          rules.push({
            code: 'PDF_EDITOR_DETECTED',
            severity: 'MEDIUM',
            description: `Herramienta de edicion PDF detectada: ${tech.producer}`,
            variables: ['producer']
          });
          break;
        }
      }
    }

    // INCREMENTAL_UPDATES - detectado si modificationDate difiere de creationDate
    if (tech.creationDate && tech.modificationDate) {
      const created = new Date(tech.creationDate);
      const modified = new Date(tech.modificationDate);
      if (modified > created) {
        const diffHours = (modified - created) / (1000 * 60 * 60);
        if (diffHours > 1) {
          rules.push({
            code: 'PDF_MODIFIED_AFTER_CREATION',
            severity: 'MEDIUM',
            description: `PDF modificado ${diffHours.toFixed(1)} horas despues de su creacion`,
            variables: ['creationDate', 'modificationDate']
          });
        }
      }
    }

    // XMP_INCONSISTENT
    if (tech.author && tech.creator && tech.author !== tech.creator) {
      rules.push({
        code: 'METADATA_INCONSISTENCY',
        severity: 'LOW',
        description: `Autor (${tech.author}) difiere del creador (${tech.creator})`,
        variables: ['author', 'creator']
      });
    }

    return rules;
  }

  // ==========================================================================
  // ANALISIS DE ZIP
  // ==========================================================================

  _analyzeZip(metadata) {
    const rules = [];
    const tech = metadata.technical || {};

    // ZIP_BOMB_HEURISTICS
    if (tech.compressionRatio) {
      const ratio = parseFloat(tech.compressionRatio);
      if (ratio < 1) { // Compresion mayor a 100:1
        rules.push({
          code: 'ZIP_BOMB_HEURISTIC',
          severity: 'HIGH',
          description: `Ratio de compresion sospechoso: ${tech.compressionRatio}`,
          variables: ['compressionRatio']
        });
      }
    }

    // EXECUTABLES_INSIDE
    if (tech.files) {
      const execExtensions = ['.exe', '.bat', '.cmd', '.ps1', '.sh', '.vbs', '.js'];
      const execFiles = tech.files.filter(f =>
        execExtensions.some(ext => f.name.toLowerCase().endsWith(ext))
      );
      if (execFiles.length > 0) {
        rules.push({
          code: 'EXECUTABLES_INSIDE',
          severity: 'HIGH',
          description: `Archivos ejecutables detectados: ${execFiles.map(f => f.name).join(', ')}`,
          variables: ['files']
        });
      }
    }

    // DANGEROUS_PATHS
    if (tech.files) {
      const dangerousPaths = tech.files.filter(f =>
        f.name.includes('..') || f.name.startsWith('/')
      );
      if (dangerousPaths.length > 0) {
        rules.push({
          code: 'DANGEROUS_PATHS',
          severity: 'HIGH',
          description: 'Rutas relativas peligrosas detectadas (path traversal)',
          variables: ['files']
        });
      }
    }

    return rules;
  }

  // ==========================================================================
  // ANALISIS GENERICO
  // ==========================================================================

  _analyzeGeneric(metadata) {
    const rules = [];

    // Verificaciones basicas
    if (metadata.fileInfo && metadata.fileInfo.sizeBytes === 0) {
      rules.push({
        code: 'EMPTY_FILE',
        severity: 'HIGH',
        description: 'Archivo vacio detectado',
        variables: ['sizeBytes']
      });
    }

    return rules;
  }

  // ==========================================================================
  // GENERAR RESUMEN
  // ==========================================================================

  _generateSummary(rules) {
    if (rules.length === 0) {
      return NO_INDICATORS_MESSAGE;
    }

    const variables = [...new Set(rules.flatMap(r => r.variables || []))];
    const severityCounts = {
      HIGH: rules.filter(r => r.severity === 'HIGH').length,
      MEDIUM: rules.filter(r => r.severity === 'MEDIUM').length,
      LOW: rules.filter(r => r.severity === 'LOW').length
    };

    return `Bajo las variables ${variables.join(', ')} se observan indicios de posible manipulacion ` +
           `(${severityCounts.HIGH} alta, ${severityCounts.MEDIUM} media, ${severityCounts.LOW} baja severidad). ` +
           `Requiere peritaje especializado.`;
  }

  // ==========================================================================
  // GUARDAR REPORTE DE RIESGO
  // ==========================================================================

  /**
   * Guarda un reporte de riesgo en la base de datos
   * @param {number} evidenceId - ID de la evidencia
   * @param {Object} analysisResult - Resultado del analisis
   * @param {number} userId - ID del usuario
   * @returns {Promise<Object>}
   */
  async saveRiskReport(evidenceId, analysisResult, userId = null) {
    // Obtener version actual
    const lastReport = await prisma.riskReport.findFirst({
      where: { evidenceId },
      orderBy: { version: 'desc' }
    });

    const version = (lastReport?.version || 0) + 1;

    return prisma.riskReport.create({
      data: {
        evidenceId,
        version,
        rulesTriggered: analysisResult.rulesTriggered,
        summary: analysisResult.summary,
        userIdRegistration: userId
      }
    });
  }

  // ==========================================================================
  // OBTENER ULTIMO REPORTE
  // ==========================================================================

  /**
   * Obtiene el ultimo reporte de riesgo de una evidencia
   * @param {number} evidenceId - ID de la evidencia
   * @returns {Promise<Object|null>}
   */
  async getLatestReport(evidenceId) {
    return prisma.riskReport.findFirst({
      where: { evidenceId },
      orderBy: { version: 'desc' }
    });
  }
}

// ============================================================================
// INSTANCIA SINGLETON
// ============================================================================
const riskAnalysisService = new RiskAnalysisService();

module.exports = riskAnalysisService;
