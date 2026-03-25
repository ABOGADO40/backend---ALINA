// ============================================================================
// METADATA SERVICE - Extraccion de metadata de archivos
// Sistema PRUEBA DIGITAL
// ============================================================================

const { prisma } = require('../config/db');
const storageService = require('./storageService');

// ============================================================================
// CLASE DE SERVICIO DE METADATA
// ============================================================================

class MetadataService {
  // ==========================================================================
  // EXTRAER METADATA SEGUN TIPO
  // ==========================================================================

  /**
   * Extrae metadata de un archivo segun su tipo
   * @param {string} storageKey - Clave de almacenamiento
   * @param {string} mimeType - Tipo MIME
   * @param {string} sourceType - Tipo de fuente (PDF, IMAGE, etc.)
   * @returns {Promise<Object>}
   */
  async extractMetadata(storageKey, mimeType, sourceType) {
    try {
      const basicInfo = await storageService.getFileInfo(storageKey);

      const metadata = {
        extractedAt: new Date().toISOString(),
        fileInfo: {
          storageKey,
          mimeType,
          sourceType,
          sizeBytes: basicInfo.sizeBytes,
          encrypted: basicInfo.encrypted
        },
        technical: {},
        device: {},
        warnings: []
      };

      // Extraer metadata segun tipo
      switch (sourceType) {
        case 'PDF':
          Object.assign(metadata.technical, await this._extractPdfMetadata(storageKey));
          break;
        case 'IMAGE':
          const imageData = await this._extractImageMetadata(storageKey, mimeType);
          Object.assign(metadata.technical, imageData.technical || {});
          Object.assign(metadata.device, imageData.device || {});
          break;
        case 'VIDEO':
          const videoData = await this._extractVideoMetadata(storageKey);
          Object.assign(metadata.technical, videoData.technical || {});
          Object.assign(metadata.device, videoData.device || {});
          break;
        case 'AUDIO':
          const audioData = await this._extractAudioMetadata(storageKey);
          Object.assign(metadata.technical, audioData.technical || {});
          break;
        case 'ZIP':
          Object.assign(metadata.technical, await this._extractZipMetadata(storageKey));
          break;
        default:
          metadata.technical.note = 'Tipo de archivo sin extraccion de metadata especializada';
      }

      return metadata;
    } catch (error) {
      console.error('[MetadataService] Error extrayendo metadata:', error);
      return {
        extractedAt: new Date().toISOString(),
        error: error.message,
        partial: true
      };
    }
  }

  // ==========================================================================
  // EXTRAER METADATA DE PDF
  // ==========================================================================

  async _extractPdfMetadata(storageKey) {
    try {
      const { PDFDocument } = require('pdf-lib');

      const stream = await storageService.getFileStream(storageKey, true);
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const pdfBytes = Buffer.concat(chunks);

      const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

      // Obtener version PDF del buffer
      let pdfVersion = 'N/A';
      try {
        const header = pdfBytes.slice(0, 20).toString('utf-8');
        const versionMatch = header.match(/PDF-(\d\.\d)/);
        if (versionMatch) {
          pdfVersion = versionMatch[1];
        }
      } catch (e) {
        // Ignorar error de version
      }

      return {
        pageCount: pdfDoc.getPageCount(),
        title: pdfDoc.getTitle() || null,
        author: pdfDoc.getAuthor() || null,
        subject: pdfDoc.getSubject() || null,
        keywords: pdfDoc.getKeywords() || null,
        creator: pdfDoc.getCreator() || null,
        producer: pdfDoc.getProducer() || null,
        creationDate: pdfDoc.getCreationDate()?.toISOString() || null,
        modificationDate: pdfDoc.getModificationDate()?.toISOString() || null,
        pdfVersion: pdfVersion
      };
    } catch (error) {
      return {
        extractionError: error.message,
        note: 'No se pudo extraer metadata completa del PDF'
      };
    }
  }

  // ==========================================================================
  // EXTRAER METADATA DE IMAGEN (CON EXIF AVANZADO)
  // ==========================================================================

  async _extractImageMetadata(storageKey, mimeType) {
    try {
      const sharp = require('sharp');

      const stream = await storageService.getFileStream(storageKey, true);
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const imageBuffer = Buffer.concat(chunks);

      const metadata = await sharp(imageBuffer).metadata();

      const result = {
        technical: {
          width: metadata.width,
          height: metadata.height,
          format: metadata.format?.toLowerCase() || 'N/A',
          space: metadata.space || 'N/A',
          channels: metadata.channels,
          depth: metadata.depth ? `${metadata.depth} bits` : 'N/A',
          density: metadata.density || null,
          hasAlpha: metadata.hasAlpha,
          orientation: metadata.orientation || 1
        },
        device: {}
      };

      // Extraer EXIF con exifr (soporta JPEG, TIFF, HEIC, etc.)
      try {
        const exifr = require('exifr');
        const exifData = await exifr.parse(imageBuffer, {
          tiff: true,
          ifd0: true,
          exif: true,
          gps: true,
          interop: true,
          translateValues: true,
          reviveValues: false
        });

        if (exifData) {
          if (exifData.DateTimeOriginal) {
            result.technical.fechaCaptura = String(exifData.DateTimeOriginal);
          }
          if (exifData.OffsetTimeOriginal || exifData.OffsetTime) {
            result.technical.zonaHoraria = exifData.OffsetTimeOriginal || exifData.OffsetTime;
          }
          if (exifData.Software) {
            result.technical.software = String(exifData.Software);
          }
          if (exifData.ColorSpace) {
            result.technical.espacioColor = exifData.ColorSpace === 1 ? 'sRGB' : String(exifData.ColorSpace);
          }
          if (exifData.Make) {
            result.device.fabricante = String(exifData.Make).trim();
          }
          if (exifData.Model) {
            result.device.modelo = String(exifData.Model).trim();
          }
          if (exifData.SerialNumber || exifData.BodySerialNumber) {
            result.device.numeroSerie = String(exifData.SerialNumber || exifData.BodySerialNumber);
          }
          if (exifData.LensModel) {
            result.device.lente = String(exifData.LensModel);
          }
          if (exifData.latitude !== undefined && exifData.longitude !== undefined) {
            result.technical.gps = {
              latitud: exifData.latitude,
              longitud: exifData.longitude,
              altitud: exifData.GPSAltitude || null
            };
          }
        }
      } catch (exifError) {
        console.warn('[MetadataService] Error extrayendo EXIF con exifr:', exifError.message);
      }

      // Si no hay datos de dispositivo, poner valores por defecto
      if (!result.device.fabricante) {
        result.device.fabricante = 'No proporcionada';
      }
      if (!result.device.modelo) {
        result.device.modelo = 'No proporcionada';
      }
      if (!result.device.numeroSerie) {
        result.device.numeroSerie = 'No proporcionada';
      }
      if (!result.device.redProveedor) {
        result.device.redProveedor = 'No proporcionada';
      }

      // Zona horaria por defecto
      if (!result.technical.zonaHoraria) {
        result.technical.zonaHoraria = 'No proporcionada';
      }

      return result;
    } catch (error) {
      return {
        technical: {
          extractionError: error.message,
          note: 'No se pudo extraer metadata completa de la imagen'
        },
        device: {
          fabricante: 'No proporcionada',
          modelo: 'No proporcionada',
          numeroSerie: 'No proporcionada',
          redProveedor: 'No proporcionada'
        }
      };
    }
  }

  // ==========================================================================
  // EXTRAER METADATA DE VIDEO
  // ==========================================================================

  async _extractVideoMetadata(storageKey) {
    try {
      const stream = await storageService.getFileStream(storageKey, true);
      const chunks = [];
      let totalBytes = 0;
      const maxBytes = 10 * 1024 * 1024; // Solo leer primeros 10MB para metadata

      for await (const chunk of stream) {
        chunks.push(chunk);
        totalBytes += chunk.length;
        if (totalBytes >= maxBytes) break;
      }

      const videoBuffer = Buffer.concat(chunks);

      const result = {
        technical: {
          duracion: 'No proporcionada',
          codec: 'No proporcionada',
          velocidadBits: 'No proporcionada',
          resolucion: 'No proporcionada',
          frameRate: 'No proporcionada'
        },
        device: {
          fabricante: 'No proporcionada',
          modelo: 'No proporcionada',
          numeroSerie: 'No proporcionada',
          redProveedor: 'No proporcionada'
        }
      };

      // Intentar detectar formato y extraer metadata basica
      const header = videoBuffer.slice(0, 12);

      // Detectar MP4/MOV (ftyp box)
      if (header.slice(4, 8).toString('ascii') === 'ftyp') {
        const mp4Info = this._parseMp4Metadata(videoBuffer);
        if (mp4Info) {
          Object.assign(result.technical, mp4Info.technical);
          Object.assign(result.device, mp4Info.device);
        }
      }
      // Detectar WebM/MKV (EBML)
      else if (header[0] === 0x1A && header[1] === 0x45 && header[2] === 0xDF && header[3] === 0xA3) {
        result.technical.codec = 'VP8/VP9/AV1 (WebM/MKV)';
        result.technical.note = 'Extraccion detallada requiere ffprobe';
      }
      // Detectar AVI (RIFF)
      else if (header.slice(0, 4).toString('ascii') === 'RIFF') {
        result.technical.codec = 'AVI Container';
        result.technical.note = 'Extraccion detallada requiere ffprobe';
      }
      else {
        result.technical.note = 'Formato de video no reconocido. Extraccion detallada requiere ffprobe';
      }

      return result;
    } catch (error) {
      return {
        technical: {
          extractionError: error.message,
          duracion: 'No proporcionada',
          codec: 'No proporcionada',
          velocidadBits: 'No proporcionada'
        },
        device: {
          fabricante: 'No proporcionada',
          modelo: 'No proporcionada',
          numeroSerie: 'No proporcionada',
          redProveedor: 'No proporcionada'
        }
      };
    }
  }

  _parseMp4Metadata(buffer) {
    try {
      const result = {
        technical: {},
        device: {}
      };

      let offset = 0;
      while (offset < buffer.length - 8) {
        const boxSize = buffer.readUInt32BE(offset);
        const boxType = buffer.slice(offset + 4, offset + 8).toString('ascii');

        if (boxSize < 8) break;

        // Buscar moov box para metadata
        if (boxType === 'moov') {
          this._parseMoovBox(buffer.slice(offset + 8, offset + boxSize), result);
          break;
        }

        offset += boxSize;
      }

      // Detectar codec basico
      result.technical.codec = 'H.264/HEVC (MP4)';

      return result;
    } catch (error) {
      return null;
    }
  }

  _parseMoovBox(buffer, result) {
    try {
      let offset = 0;
      while (offset < buffer.length - 8) {
        const boxSize = buffer.readUInt32BE(offset);
        const boxType = buffer.slice(offset + 4, offset + 8).toString('ascii');

        if (boxSize < 8) break;

        if (boxType === 'mvhd') {
          // Movie header - contiene duracion
          const mvhdBuffer = buffer.slice(offset + 8, offset + boxSize);
          const version = mvhdBuffer[0];

          if (version === 0) {
            const timescale = mvhdBuffer.readUInt32BE(12);
            const duration = mvhdBuffer.readUInt32BE(16);
            if (timescale > 0) {
              const seconds = Math.floor(duration / timescale);
              const hours = Math.floor(seconds / 3600);
              const minutes = Math.floor((seconds % 3600) / 60);
              const secs = seconds % 60;
              result.technical.duracion = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
            }
          }
        }

        offset += boxSize;
      }
    } catch (error) {
      // Silenciar errores
    }
  }

  // ==========================================================================
  // EXTRAER METADATA DE AUDIO
  // ==========================================================================

  async _extractAudioMetadata(storageKey) {
    try {
      const stream = await storageService.getFileStream(storageKey, true);
      const chunks = [];
      let totalBytes = 0;
      const maxBytes = 5 * 1024 * 1024; // Solo leer primeros 5MB para metadata

      for await (const chunk of stream) {
        chunks.push(chunk);
        totalBytes += chunk.length;
        if (totalBytes >= maxBytes) break;
      }

      const audioBuffer = Buffer.concat(chunks);

      const result = {
        technical: {
          duracion: 'No proporcionada',
          codec: 'No proporcionada',
          velocidadBits: 'No proporcionada',
          sampleRate: 'No proporcionada',
          canales: 'No proporcionada'
        }
      };

      // Detectar formato
      const header = audioBuffer.slice(0, 12);

      // MP3 (ID3 o sync word)
      if (header.slice(0, 3).toString('ascii') === 'ID3' ||
          (header[0] === 0xFF && (header[1] & 0xE0) === 0xE0)) {
        result.technical.codec = 'MP3';
        const mp3Info = this._parseMp3Metadata(audioBuffer);
        if (mp3Info) {
          Object.assign(result.technical, mp3Info);
        }
      }
      // WAV (RIFF WAVE)
      else if (header.slice(0, 4).toString('ascii') === 'RIFF' &&
               header.slice(8, 12).toString('ascii') === 'WAVE') {
        result.technical.codec = 'WAV';
        const wavInfo = this._parseWavMetadata(audioBuffer);
        if (wavInfo) {
          Object.assign(result.technical, wavInfo);
        }
      }
      // FLAC
      else if (header.slice(0, 4).toString('ascii') === 'fLaC') {
        result.technical.codec = 'FLAC';
      }
      // OGG
      else if (header.slice(0, 4).toString('ascii') === 'OggS') {
        result.technical.codec = 'OGG Vorbis';
      }
      // M4A/AAC (MP4 container)
      else if (header.slice(4, 8).toString('ascii') === 'ftyp') {
        result.technical.codec = 'AAC (M4A)';
      }
      else {
        result.technical.note = 'Formato de audio no reconocido. Extraccion detallada requiere ffprobe';
      }

      return result;
    } catch (error) {
      return {
        technical: {
          extractionError: error.message,
          duracion: 'No proporcionada',
          codec: 'No proporcionada',
          velocidadBits: 'No proporcionada',
          sampleRate: 'No proporcionada'
        }
      };
    }
  }

  _parseMp3Metadata(buffer) {
    try {
      const result = {};
      let offset = 0;

      // Skip ID3 tag if present
      if (buffer.slice(0, 3).toString('ascii') === 'ID3') {
        const id3Size = ((buffer[6] & 0x7F) << 21) |
                        ((buffer[7] & 0x7F) << 14) |
                        ((buffer[8] & 0x7F) << 7) |
                        (buffer[9] & 0x7F);
        offset = 10 + id3Size;
      }

      // Find first sync word
      while (offset < buffer.length - 4) {
        if (buffer[offset] === 0xFF && (buffer[offset + 1] & 0xE0) === 0xE0) {
          // Parse frame header
          const header = buffer.readUInt32BE(offset);
          const version = (header >> 19) & 3;
          const layer = (header >> 17) & 3;
          const bitrateIndex = (header >> 12) & 15;
          const sampleRateIndex = (header >> 10) & 3;
          const channelMode = (header >> 6) & 3;

          // Bitrate table for MPEG1 Layer 3
          const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
          const sampleRates = [44100, 48000, 32000, 0];

          if (bitrateIndex > 0 && bitrateIndex < 15 && sampleRateIndex < 3) {
            result.velocidadBits = `${bitrates[bitrateIndex]} kbps`;
            result.sampleRate = `${sampleRates[sampleRateIndex]} Hz`;
            result.canales = channelMode === 3 ? 'Mono' : 'Estereo';
          }
          break;
        }
        offset++;
      }

      return result;
    } catch (error) {
      return null;
    }
  }

  _parseWavMetadata(buffer) {
    try {
      const result = {};
      let offset = 12; // Skip RIFF header

      while (offset < buffer.length - 8) {
        const chunkId = buffer.slice(offset, offset + 4).toString('ascii');
        const chunkSize = buffer.readUInt32LE(offset + 4);

        if (chunkId === 'fmt ') {
          const audioFormat = buffer.readUInt16LE(offset + 8);
          const numChannels = buffer.readUInt16LE(offset + 10);
          const sampleRate = buffer.readUInt32LE(offset + 12);
          const byteRate = buffer.readUInt32LE(offset + 16);
          const bitsPerSample = buffer.readUInt16LE(offset + 22);

          result.sampleRate = `${sampleRate} Hz`;
          result.canales = numChannels === 1 ? 'Mono' : `${numChannels} canales`;
          result.velocidadBits = `${Math.round(byteRate * 8 / 1000)} kbps`;
          result.profundidadBits = `${bitsPerSample} bits`;
        }

        if (chunkId === 'data') {
          // Calculate duration
          const dataSize = chunkSize;
          const byteRate = buffer.readUInt32LE(24); // From fmt chunk
          if (byteRate > 0) {
            const seconds = Math.floor(dataSize / byteRate);
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = seconds % 60;
            result.duracion = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
          }
        }

        offset += 8 + chunkSize;
        if (chunkSize % 2 === 1) offset++; // Word alignment
      }

      return result;
    } catch (error) {
      return null;
    }
  }

  // ==========================================================================
  // EXTRAER METADATA DE ZIP
  // ==========================================================================

  async _extractZipMetadata(storageKey) {
    try {
      const AdmZip = require('adm-zip');

      const stream = await storageService.getFileStream(storageKey, true);
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const zipBuffer = Buffer.concat(chunks);

      const zip = new AdmZip(zipBuffer);
      const entries = zip.getEntries();

      const files = entries.map(entry => ({
        name: entry.entryName,
        size: entry.header.size,
        compressedSize: entry.header.compressedSize,
        isDirectory: entry.isDirectory,
        comment: entry.comment || null
      }));

      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      const compressedSize = files.reduce((sum, f) => sum + f.compressedSize, 0);

      return {
        fileCount: files.filter(f => !f.isDirectory).length,
        directoryCount: files.filter(f => f.isDirectory).length,
        totalUncompressedSize: totalSize,
        totalCompressedSize: compressedSize,
        compressionRatio: totalSize > 0 ? (compressedSize / totalSize * 100).toFixed(2) + '%' : 'N/A',
        files: files.slice(0, 50), // Limitar a 50 archivos
        truncated: files.length > 50
      };
    } catch (error) {
      return {
        extractionError: error.message,
        note: 'No se pudo extraer metadata del archivo comprimido'
      };
    }
  }

  // ==========================================================================
  // GUARDAR REPORTE DE METADATA
  // ==========================================================================

  /**
   * Guarda un reporte de metadata en la base de datos
   * @param {number} evidenceId - ID de la evidencia
   * @param {Object} metadata - Metadata extraida
   * @param {number} userId - ID del usuario
   * @returns {Promise<Object>}
   */
  async saveMetadataReport(evidenceId, metadata, userId = null) {
    // Obtener version actual
    const lastReport = await prisma.metadataReport.findFirst({
      where: { evidenceId },
      orderBy: { version: 'desc' }
    });

    const version = (lastReport?.version || 0) + 1;

    return prisma.metadataReport.create({
      data: {
        evidenceId,
        version,
        reportJson: metadata,
        userIdRegistration: userId
      }
    });
  }

  // ==========================================================================
  // OBTENER ULTIMO REPORTE
  // ==========================================================================

  /**
   * Obtiene el ultimo reporte de metadata de una evidencia
   * @param {number} evidenceId - ID de la evidencia
   * @returns {Promise<Object|null>}
   */
  async getLatestReport(evidenceId) {
    return prisma.metadataReport.findFirst({
      where: { evidenceId },
      orderBy: { version: 'desc' }
    });
  }

}

// ============================================================================
// INSTANCIA SINGLETON
// ============================================================================
const metadataService = new MetadataService();

module.exports = metadataService;
