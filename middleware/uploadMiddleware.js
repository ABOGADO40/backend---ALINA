// ============================================================================
// UPLOAD MIDDLEWARE - Manejo de archivos hasta 2GB
// Sistema PRUEBA DIGITAL
// ============================================================================

const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const {
  MAX_FILE_SIZE,
  UPLOAD_BASE_DIR,
  isBlockedExtension,
  isAllowedMimeType,
  validateMimeExtension,
  getMimeCategory
} = require('../config/storage');

// ============================================================================
// CONFIGURACION DE ALMACENAMIENTO TEMPORAL
// ============================================================================

const tempDir = path.join(UPLOAD_BASE_DIR, 'temp');

// Asegurar que el directorio temporal existe
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    // Generar nombre unico para evitar colisiones
    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(16).toString('hex')}`;
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `upload_${uniqueSuffix}${ext}`);
  }
});

// ============================================================================
// FILTRO DE ARCHIVOS
// ============================================================================

const fileFilter = (req, file, cb) => {
  // Verificar extension bloqueada
  if (isBlockedExtension(file.originalname)) {
    return cb(new Error('BLOCKED_EXTENSION'), false);
  }

  // Verificar tipo MIME permitido (verificacion preliminar)
  // La verificacion real de magic bytes se hace despues del upload
  const ext = path.extname(file.originalname).toLowerCase();
  const dangerousExtensions = ['.exe', '.bat', '.cmd', '.com', '.msi', '.vbs', '.ps1', '.sh'];

  if (dangerousExtensions.includes(ext)) {
    return cb(new Error('DANGEROUS_EXTENSION'), false);
  }

  cb(null, true);
};

// ============================================================================
// CONFIGURACION DE MULTER
// ============================================================================

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE, // 2GB
    files: 1 // Solo un archivo a la vez
  },
  fileFilter
});

// ============================================================================
// MIDDLEWARE DE UPLOAD SIMPLE
// ============================================================================

/**
 * Middleware para upload de un solo archivo
 */
const uploadSingle = upload.single('file');

// ============================================================================
// MIDDLEWARE DE VALIDACION POST-UPLOAD
// ============================================================================

/**
 * Valida el archivo despues del upload (magic bytes, etc.)
 */
const validateUploadedFile = async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'FILE_REQUIRED',
        message: 'Se requiere un archivo'
      }
    });
  }

  try {
    // Importar file-type dinamicamente (ES Module)
    const { fileTypeFromFile } = await import('file-type');

    // Detectar tipo real del archivo por magic bytes
    const detectedType = await fileTypeFromFile(req.file.path);

    if (detectedType) {
      // Verificar que el tipo MIME detectado esta permitido
      if (!isAllowedMimeType(detectedType.mime)) {
        // Eliminar archivo temporal
        await fs.promises.unlink(req.file.path);
        return res.status(400).json({
          success: false,
          error: {
            code: 'FILE_TYPE_INVALID',
            message: `Tipo de archivo no permitido: ${detectedType.mime}`
          }
        });
      }

      // Verificar que la extension coincide con el tipo MIME
      if (!validateMimeExtension(detectedType.mime, req.file.originalname)) {
        // Agregar advertencia pero permitir continuar
        req.fileWarning = {
          code: 'MIME_MISMATCH',
          message: `Extension no coincide con tipo real (${detectedType.mime})`
        };
      }

      // Agregar informacion del tipo detectado al request
      req.detectedMimeType = detectedType.mime;
      req.detectedExtension = detectedType.ext;
    } else {
      // No se pudo detectar el tipo - usar el declarado por el cliente
      req.detectedMimeType = req.file.mimetype;
    }

    // Determinar categoria del archivo
    req.sourceType = getMimeCategory(req.detectedMimeType) || 'OTHER';

    // Deteccion basica de zip bomb (ratio de compresion)
    if (req.sourceType === 'ZIP') {
      const isZipBomb = await checkZipBomb(req.file.path, req.file.size);
      if (isZipBomb) {
        await fs.promises.unlink(req.file.path);
        return res.status(400).json({
          success: false,
          error: {
            code: 'ZIPBOMB_DETECTED',
            message: 'Archivo comprimido sospechoso detectado'
          }
        });
      }
    }

    next();

  } catch (error) {
    console.error('[UploadMiddleware] Error validando archivo:', error);

    // Intentar eliminar archivo temporal en caso de error
    try {
      if (req.file && req.file.path) {
        await fs.promises.unlink(req.file.path);
      }
    } catch (e) {
      // Ignorar error de eliminacion
    }

    res.status(500).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Error al validar el archivo'
      }
    });
  }
};

// ============================================================================
// DETECCION DE ZIP BOMB
// ============================================================================

/**
 * Verifica si un archivo ZIP podria ser una "zip bomb"
 * @param {string} filePath - Ruta del archivo
 * @param {number} compressedSize - Tamano comprimido
 * @returns {Promise<boolean>}
 */
async function checkZipBomb(filePath, compressedSize) {
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();

    let totalUncompressedSize = 0;
    let suspiciousFileCount = 0;

    for (const entry of entries) {
      totalUncompressedSize += entry.header.size;

      // Verificar archivos con ratio de compresion extremo
      if (entry.header.compressedSize > 0) {
        const ratio = entry.header.size / entry.header.compressedSize;
        if (ratio > 100) { // Ratio mayor a 100:1 es sospechoso
          suspiciousFileCount++;
        }
      }

      // Verificar tamano descomprimido total
      if (totalUncompressedSize > 10 * 1024 * 1024 * 1024) { // > 10GB
        return true;
      }
    }

    // Ratio global de compresion
    if (compressedSize > 0) {
      const globalRatio = totalUncompressedSize / compressedSize;
      if (globalRatio > 1000) { // > 1000:1
        return true;
      }
    }

    // Muchos archivos con ratio sospechoso
    if (suspiciousFileCount > 10) {
      return true;
    }

    return false;

  } catch (error) {
    console.error('[ZipBomb] Error verificando:', error);
    // En caso de error, dejar pasar pero loggear
    return false;
  }
}

// ============================================================================
// MANEJO DE ERRORES DE MULTER
// ============================================================================

/**
 * Middleware para manejar errores de Multer
 */
const handleUploadError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    let message = 'Error al subir el archivo';
    let code = 'UPLOAD_ERROR';

    switch (err.code) {
      case 'LIMIT_FILE_SIZE':
        message = `El archivo excede el tamano maximo permitido (${MAX_FILE_SIZE / (1024 * 1024 * 1024)}GB)`;
        code = 'FILE_TOO_LARGE';
        break;
      case 'LIMIT_FILE_COUNT':
        message = 'Solo se permite un archivo a la vez';
        code = 'TOO_MANY_FILES';
        break;
      case 'LIMIT_UNEXPECTED_FILE':
        message = 'Campo de archivo inesperado';
        code = 'UNEXPECTED_FIELD';
        break;
    }

    return res.status(400).json({
      success: false,
      error: { code, message }
    });
  }

  if (err.message === 'BLOCKED_EXTENSION') {
    return res.status(400).json({
      success: false,
      error: {
        code: 'BLOCKED_EXTENSION',
        message: 'Tipo de archivo bloqueado por politica de seguridad'
      }
    });
  }

  if (err.message === 'DANGEROUS_EXTENSION') {
    return res.status(400).json({
      success: false,
      error: {
        code: 'DANGEROUS_EXTENSION',
        message: 'Archivos ejecutables no estan permitidos'
      }
    });
  }

  next(err);
};

// ============================================================================
// LIMPIEZA DE ARCHIVOS TEMPORALES
// ============================================================================

/**
 * Limpia archivos temporales viejos (mas de 1 hora)
 */
async function cleanupTempFiles() {
  try {
    const files = await fs.promises.readdir(tempDir);
    const oneHourAgo = Date.now() - (60 * 60 * 1000);

    for (const file of files) {
      if (file.startsWith('upload_')) {
        const filePath = path.join(tempDir, file);
        const stats = await fs.promises.stat(filePath);

        if (stats.mtimeMs < oneHourAgo) {
          await fs.promises.unlink(filePath);
          console.log(`[UploadMiddleware] Archivo temporal eliminado: ${file}`);
        }
      }
    }
  } catch (error) {
    console.error('[UploadMiddleware] Error limpiando temporales:', error);
  }
}

// Ejecutar limpieza cada hora
setInterval(cleanupTempFiles, 60 * 60 * 1000);

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  uploadSingle,
  validateUploadedFile,
  handleUploadError,
  cleanupTempFiles
};
