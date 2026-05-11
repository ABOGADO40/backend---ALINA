// ============================================================================
// STORAGE CONFIGURATION - Manejo de archivos hasta 2GB
// Sistema PRUEBA DIGITAL
// ============================================================================
// CONFIGURACION HIBRIDA: LOCAL / RAILWAY
//
// [LOCAL]   Los archivos se almacenan en ./uploads (carpeta del proyecto)
//           UPLOAD_DIR definido en .env -> ./uploads
//           Los archivos persisten entre reinicios del servidor
//
// [RAILWAY] Los archivos se almacenan en el filesystem efimero de Railway
//           UPLOAD_DIR definido en el dashboard de Railway
//           ADVERTENCIA: Los archivos se PIERDEN al redesplegar
//
// La clave de cifrado (STORAGE_ENCRYPTION_KEY) es diferente en cada entorno.
// ============================================================================

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ============================================================================
// CONSTANTES DE CONFIGURACION
// ============================================================================

// Tamano maximo de archivo: 2GB
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB en bytes

// Tamano del chunk para streaming: 64MB
const CHUNK_SIZE = 64 * 1024 * 1024; // 64MB

// Buffer para hash: 16MB
const HASH_BUFFER_SIZE = 16 * 1024 * 1024; // 16MB

// Directorio base de uploads
const UPLOAD_BASE_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');

// ============================================================================
// ESTRUCTURA DE CARPETAS DE ALMACENAMIENTO
// ============================================================================
const STORAGE_STRUCTURE = {
  // Archivos originales - NUNCA se modifican
  ORIGINAL: 'original',

  // Copias bit-a-bit (clon 1:1)
  BITCOPY: 'bitcopy',

  // Archivos sellados (derivados con QR + sello)
  SEALED: 'sealed',

  // Certificados (PDF y JSON)
  CERTIFICATES: 'certificates',

  // Reportes (metadata y riesgo)
  REPORTS: 'reports',

  // Payloads derivados inmutables (metadata.json, risk_report.json)
  DERIVED: 'derived',

  // Exportaciones ZIP
  EXPORTS: 'exports',

  // Temporales (para procesamiento)
  TEMP: 'temp'
};

// ============================================================================
// TIPOS MIME PERMITIDOS
// ============================================================================
const ALLOWED_MIME_TYPES = {
  // Documentos
  'application/pdf': { ext: ['.pdf'], category: 'PDF' },
  'application/msword': { ext: ['.doc'], category: 'OTHER' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { ext: ['.docx'], category: 'OTHER' },

  // Excel
  'application/vnd.ms-excel': { ext: ['.xls'], category: 'OTHER' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { ext: ['.xlsx'], category: 'OTHER' },

  // PowerPoint
  'application/vnd.ms-powerpoint': { ext: ['.ppt'], category: 'OTHER' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { ext: ['.pptx'], category: 'OTHER' },

  // Imagenes
  'image/jpeg': { ext: ['.jpg', '.jpeg'], category: 'IMAGE' },
  'image/png': { ext: ['.png'], category: 'IMAGE' },
  'image/gif': { ext: ['.gif'], category: 'IMAGE' },
  'image/webp': { ext: ['.webp'], category: 'IMAGE' },
  'image/tiff': { ext: ['.tiff', '.tif'], category: 'IMAGE' },
  'image/bmp': { ext: ['.bmp'], category: 'IMAGE' },

  // Videos
  'video/mp4': { ext: ['.mp4'], category: 'VIDEO' },
  'video/mpeg': { ext: ['.mpeg', '.mpg'], category: 'VIDEO' },
  'video/quicktime': { ext: ['.mov', '.qt'], category: 'VIDEO' },
  'video/x-msvideo': { ext: ['.avi'], category: 'VIDEO' },
  'video/webm': { ext: ['.webm'], category: 'VIDEO' },
  'video/x-matroska': { ext: ['.mkv'], category: 'VIDEO' },
  // 3GPP - comun en grabaciones moviles (videos cortos, mensajes de voz)
  'video/3gpp': { ext: ['.3gp', '.3gpp'], category: 'VIDEO' },
  'video/3gpp2': { ext: ['.3g2', '.3gpp2'], category: 'VIDEO' },
  'audio/3gpp': { ext: ['.3gp', '.3gpp'], category: 'AUDIO' },
  'audio/3gpp2': { ext: ['.3g2', '.3gpp2'], category: 'AUDIO' },
  // Otros formatos de video comunes
  'video/x-flv': { ext: ['.flv'], category: 'VIDEO' },
  'video/x-ms-wmv': { ext: ['.wmv'], category: 'VIDEO' },
  'video/ogg': { ext: ['.ogv'], category: 'VIDEO' },

  // Audio
  'audio/mpeg': { ext: ['.mp3'], category: 'AUDIO' },
  'audio/wav': { ext: ['.wav'], category: 'AUDIO' },
  'audio/wave': { ext: ['.wav'], category: 'AUDIO' },
  'audio/x-wav': { ext: ['.wav'], category: 'AUDIO' },
  'audio/ogg': { ext: ['.ogg', '.oga'], category: 'AUDIO' },
  'audio/aac': { ext: ['.aac', '.m4a'], category: 'AUDIO' },
  'audio/x-m4a': { ext: ['.m4a'], category: 'AUDIO' },
  // M4A es contenedor MP4 con solo audio; file-type lo detecta como audio/mp4
  'audio/mp4': { ext: ['.m4a', '.m4b', '.m4p', '.mp4'], category: 'AUDIO' },
  'audio/flac': { ext: ['.flac'], category: 'AUDIO' },
  'audio/x-flac': { ext: ['.flac'], category: 'AUDIO' },
  'audio/webm': { ext: ['.weba'], category: 'AUDIO' },
  'audio/opus': { ext: ['.opus'], category: 'AUDIO' },

  // Archivos comprimidos
  'application/zip': { ext: ['.zip'], category: 'ZIP' },
  'application/x-rar-compressed': { ext: ['.rar'], category: 'ZIP' },
  'application/x-7z-compressed': { ext: ['.7z'], category: 'ZIP' },

  // Texto
  'text/plain': { ext: ['.txt'], category: 'OTHER' },
  'text/csv': { ext: ['.csv'], category: 'OTHER' },
  'application/json': { ext: ['.json'], category: 'CHAT' }
};

// ============================================================================
// EXTENSIONES BLOQUEADAS (ejecutables)
// ============================================================================
const BLOCKED_EXTENSIONS = [
  '.exe', '.bat', '.cmd', '.com', '.msi', '.vbs', '.vbe',
  '.js', '.jse', '.ws', '.wsf', '.wsc', '.wsh',
  '.ps1', '.psm1', '.psd1',
  '.scr', '.pif', '.application', '.gadget',
  '.hta', '.cpl', '.msc', '.jar',
  '.sh', '.bash', '.zsh', '.ksh',
  '.dll', '.sys', '.drv'
];

// ============================================================================
// FUNCIONES DE UTILIDAD
// ============================================================================

/**
 * Inicializa la estructura de carpetas de almacenamiento
 */
function initializeStorageStructure() {
  // En produccion con Wasabi S3, solo crear directorio temp local (para uploads temporales de Multer)
  const tempDir = path.join(UPLOAD_BASE_DIR, 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
    console.log(`[Storage] Carpeta temp local creada: ${tempDir}`);
  }
  console.log('[Storage] Almacenamiento: Wasabi S3 (bucket: prueba-digital-alina)');
}

/**
 * Genera un storage key unico para un archivo
 * Formato: {folder}/{year}/{month}/{evidenceId}/{uuid}_{filename}
 */
function generateStorageKey(folder, evidenceId, originalFilename) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const uuid = crypto.randomUUID();
  const safeFilename = sanitizeFilename(originalFilename);

  return `${folder}/${year}/${month}/${evidenceId}/${uuid}_${safeFilename}`;
}

/**
 * Genera un storage key DETERMINISTICO basado en hash del contenido + ownerId.
 * Permite subir a S3 ANTES de crear el registro en BD (carga idempotente).
 * Formato: {folder}/by-hash/{year}/{month}/{ownerId}/{hashPrefix}/{filename}
 *
 * Si el mismo owner sube el mismo archivo dos veces en el mismo mes,
 * el storageKey sera identico y la idempotencia funciona naturalmente.
 */
function generateStorageKeyByHash(folder, hashHex, ownerId, originalFilename) {
  if (!hashHex || hashHex.length < 16) {
    throw new Error('hashHex invalido para generateStorageKeyByHash');
  }
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const hashPrefix = hashHex.substring(0, 16); // 16 chars = 64 bits, mas que suficiente
  const safeFilename = sanitizeFilename(originalFilename);
  return `${folder}/by-hash/${year}/${month}/${ownerId || 'anon'}/${hashPrefix}/${safeFilename}`;
}

/**
 * Sanitiza un nombre de archivo eliminando caracteres peligrosos
 */
function sanitizeFilename(filename) {
  // Eliminar caracteres especiales y rutas relativas
  return filename
    .replace(/\.\./g, '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .substring(0, 200); // Limitar longitud
}

/**
 * Obtiene la ruta completa en el sistema de archivos
 */
function getFullPath(storageKey) {
  return path.join(UPLOAD_BASE_DIR, storageKey);
}

/**
 * Verifica si un tipo MIME esta permitido
 */
function isAllowedMimeType(mimeType) {
  return mimeType in ALLOWED_MIME_TYPES;
}

/**
 * Verifica si una extension esta bloqueada
 */
function isBlockedExtension(filename) {
  const ext = path.extname(filename).toLowerCase();
  return BLOCKED_EXTENSIONS.includes(ext);
}

/**
 * Obtiene la categoria de un tipo MIME
 */
function getMimeCategory(mimeType) {
  const config = ALLOWED_MIME_TYPES[mimeType];
  return config ? config.category : 'OTHER';
}

/**
 * Valida que la extension coincida con el tipo MIME
 */
function validateMimeExtension(mimeType, filename) {
  const config = ALLOWED_MIME_TYPES[mimeType];
  if (!config) return false;

  const ext = path.extname(filename).toLowerCase();
  return config.ext.includes(ext);
}

// ============================================================================
// CONFIGURACION DE CIFRADO EN REPOSO
// ============================================================================
const ENCRYPTION_CONFIG = {
  // Algoritmo de cifrado
  algorithm: 'aes-256-gcm',

  // Longitud del IV
  ivLength: 16,

  // Longitud del auth tag
  authTagLength: 16,

  // La clave se obtiene de variables de entorno
  getKey: () => {
    const key = process.env.STORAGE_ENCRYPTION_KEY;
    if (!key || key.length !== 64) {
      throw new Error('STORAGE_ENCRYPTION_KEY debe ser una cadena hexadecimal de 64 caracteres (256 bits)');
    }
    return Buffer.from(key, 'hex');
  }
};

// ============================================================================
// EXPORTACIONES
// ============================================================================
module.exports = {
  // Constantes
  MAX_FILE_SIZE,
  CHUNK_SIZE,
  HASH_BUFFER_SIZE,
  UPLOAD_BASE_DIR,
  STORAGE_STRUCTURE,
  ALLOWED_MIME_TYPES,
  BLOCKED_EXTENSIONS,
  ENCRYPTION_CONFIG,

  // Funciones
  initializeStorageStructure,
  generateStorageKey,
  generateStorageKeyByHash,
  sanitizeFilename,
  getFullPath,
  isAllowedMimeType,
  isBlockedExtension,
  getMimeCategory,
  validateMimeExtension
};
