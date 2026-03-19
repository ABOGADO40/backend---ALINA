// ============================================================================
// STORAGE SERVICE - Manejo de archivos hasta 2GB con cifrado
// Sistema PRUEBA DIGITAL
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

const {
  MAX_FILE_SIZE,
  CHUNK_SIZE,
  HASH_BUFFER_SIZE,
  UPLOAD_BASE_DIR,
  STORAGE_STRUCTURE,
  ENCRYPTION_CONFIG,
  generateStorageKey,
  getFullPath,
  isBlockedExtension
} = require('../config/storage');

// ============================================================================
// CLASE PRINCIPAL DE ALMACENAMIENTO
// ============================================================================

class StorageService {
  constructor() {
    this.uploadBaseDir = UPLOAD_BASE_DIR;
  }

  // ==========================================================================
  // GUARDAR ARCHIVO CON STREAMING (para archivos grandes hasta 2GB)
  // ==========================================================================

  /**
   * Guarda un archivo usando streaming para manejar archivos grandes
   * @param {ReadableStream} readStream - Stream de lectura del archivo
   * @param {string} folder - Carpeta de destino (ORIGINAL, BITCOPY, etc.)
   * @param {number} evidenceId - ID de la evidencia
   * @param {string} originalFilename - Nombre original del archivo
   * @param {boolean} encrypt - Si se debe cifrar el archivo
   * @returns {Promise<{storageKey: string, sizeBytes: number, hash: string}>}
   */
  async saveFileStream(readStream, folder, evidenceId, originalFilename, encrypt = true) {
    // Validar extension bloqueada
    if (isBlockedExtension(originalFilename)) {
      throw new Error(`Extension de archivo bloqueada: ${path.extname(originalFilename)}`);
    }

    // Generar storage key
    const storageKey = generateStorageKey(folder, evidenceId, originalFilename);
    const fullPath = getFullPath(storageKey);

    // Crear directorio si no existe
    const dirPath = path.dirname(fullPath);
    await fs.promises.mkdir(dirPath, { recursive: true });

    // Calcular hash SHA-256 mientras se guarda
    const hashCalculator = crypto.createHash('sha256');
    let sizeBytes = 0;

    // Transform stream para calcular hash y tamano
    const hashTransform = new Transform({
      transform(chunk, encoding, callback) {
        hashCalculator.update(chunk);
        sizeBytes += chunk.length;

        // Verificar tamano maximo
        if (sizeBytes > MAX_FILE_SIZE) {
          callback(new Error(`Archivo excede el tamano maximo de ${MAX_FILE_SIZE / (1024 * 1024 * 1024)}GB`));
          return;
        }

        callback(null, chunk);
      }
    });

    let writeStream;
    let finalPath = fullPath;

    if (encrypt) {
      // Guardar con cifrado
      const { encryptedPath, iv, authTag } = await this._saveEncrypted(
        readStream,
        hashTransform,
        fullPath
      );
      finalPath = encryptedPath;

      // Guardar metadata de cifrado
      await this._saveEncryptionMetadata(fullPath, iv, authTag);
    } else {
      // Guardar sin cifrar
      writeStream = fs.createWriteStream(fullPath);
      await pipeline(readStream, hashTransform, writeStream);
    }

    const hashHex = hashCalculator.digest('hex');

    return {
      storageKey,
      sizeBytes,
      hash: hashHex,
      isEncrypted: encrypt
    };
  }

  // ==========================================================================
  // CIFRADO DE ARCHIVOS EN REPOSO
  // ==========================================================================

  /**
   * Guarda un archivo con cifrado AES-256-GCM
   */
  async _saveEncrypted(readStream, hashTransform, basePath) {
    const key = ENCRYPTION_CONFIG.getKey();
    const iv = crypto.randomBytes(ENCRYPTION_CONFIG.ivLength);

    const cipher = crypto.createCipheriv(
      ENCRYPTION_CONFIG.algorithm,
      key,
      iv,
      { authTagLength: ENCRYPTION_CONFIG.authTagLength }
    );

    const encryptedPath = `${basePath}.enc`;
    const writeStream = fs.createWriteStream(encryptedPath);

    await pipeline(readStream, hashTransform, cipher, writeStream);

    const authTag = cipher.getAuthTag();

    return {
      encryptedPath,
      iv,
      authTag
    };
  }

  /**
   * Guarda metadata de cifrado (IV y AuthTag) en archivo separado
   */
  async _saveEncryptionMetadata(basePath, iv, authTag) {
    const metadataPath = `${basePath}.meta`;
    const metadata = {
      algorithm: ENCRYPTION_CONFIG.algorithm,
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      createdAt: new Date().toISOString()
    };

    await fs.promises.writeFile(metadataPath, JSON.stringify(metadata), 'utf8');
  }

  // ==========================================================================
  // LEER ARCHIVO CON STREAMING
  // ==========================================================================

  /**
   * Lee un archivo usando streaming para manejar archivos grandes
   * @param {string} storageKey - Clave de almacenamiento
   * @param {boolean} encrypted - Si el archivo esta cifrado
   * @returns {ReadableStream}
   */
  async getFileStream(storageKey, encrypted = true) {
    const basePath = getFullPath(storageKey);

    if (encrypted) {
      return this._readEncrypted(basePath);
    }

    const fullPath = basePath;
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Archivo no encontrado: ${storageKey}`);
    }

    return fs.createReadStream(fullPath, { highWaterMark: CHUNK_SIZE });
  }

  /**
   * Lee un archivo cifrado y devuelve stream descifrado
   */
  async _readEncrypted(basePath) {
    const encryptedPath = `${basePath}.enc`;
    const metadataPath = `${basePath}.meta`;

    if (!fs.existsSync(encryptedPath)) {
      throw new Error(`Archivo cifrado no encontrado: ${basePath}`);
    }

    if (!fs.existsSync(metadataPath)) {
      throw new Error(`Metadata de cifrado no encontrada: ${basePath}`);
    }

    // Leer metadata
    const metadataContent = await fs.promises.readFile(metadataPath, 'utf8');
    const metadata = JSON.parse(metadataContent);

    const key = ENCRYPTION_CONFIG.getKey();
    const iv = Buffer.from(metadata.iv, 'base64');
    const authTag = Buffer.from(metadata.authTag, 'base64');

    const decipher = crypto.createDecipheriv(
      ENCRYPTION_CONFIG.algorithm,
      key,
      iv,
      { authTagLength: ENCRYPTION_CONFIG.authTagLength }
    );
    decipher.setAuthTag(authTag);

    const readStream = fs.createReadStream(encryptedPath, { highWaterMark: CHUNK_SIZE });

    // Retornar pipeline de descifrado
    const { PassThrough } = require('stream');
    const outputStream = new PassThrough();

    pipeline(readStream, decipher, outputStream).catch(err => {
      outputStream.destroy(err);
    });

    return outputStream;
  }

  // ==========================================================================
  // GUARDAR ARCHIVO ORIGINAL DESDE PATH (para uploads de Multer)
  // ==========================================================================

  /**
   * Guarda un archivo original desde un path temporal (usado por Multer)
   * @param {string} tempFilePath - Ruta del archivo temporal
   * @param {number} evidenceId - ID de la evidencia
   * @param {string} originalFilename - Nombre original del archivo
   * @param {string} mimeType - Tipo MIME del archivo
   * @returns {Promise<{storageKey: string, sizeBytes: number, hash: string, isEncrypted: boolean}>}
   */
  async storeOriginal(tempFilePath, evidenceId, originalFilename, mimeType) {
    // Verificar que el archivo temporal existe
    if (!fs.existsSync(tempFilePath)) {
      throw new Error(`Archivo temporal no encontrado: ${tempFilePath}`);
    }

    // Crear stream de lectura del archivo temporal
    const readStream = fs.createReadStream(tempFilePath, { highWaterMark: CHUNK_SIZE });

    try {
      // Guardar usando el metodo de streaming
      const result = await this.saveFileStream(
        readStream,
        STORAGE_STRUCTURE.ORIGINAL,
        evidenceId,
        originalFilename,
        true // Cifrar por defecto
      );

      // Eliminar archivo temporal despues de guardarlo
      await fs.promises.unlink(tempFilePath);

      return {
        storageKey: result.storageKey,
        sizeBytes: result.sizeBytes,
        hash: result.hash,
        isEncrypted: result.isEncrypted
      };
    } catch (error) {
      // En caso de error, intentar limpiar archivo temporal
      try {
        if (fs.existsSync(tempFilePath)) {
          await fs.promises.unlink(tempFilePath);
        }
      } catch (cleanupError) {
        console.error('Error limpiando archivo temporal:', cleanupError);
      }
      throw error;
    }
  }

  // ==========================================================================
  // CREAR COPIA BIT-A-BIT
  // ==========================================================================

  /**
   * Crea una copia bit-a-bit (byte-for-byte) de un archivo
   * @param {string} sourceStorageKey - Clave del archivo fuente
   * @param {number} evidenceId - ID de la evidencia
   * @param {string} originalFilename - Nombre original
   * @param {boolean} sourceEncrypted - Si el fuente esta cifrado
   * @returns {Promise<{storageKey: string, hash: string}>}
   */
  async createBitcopy(sourceStorageKey, evidenceId, originalFilename, sourceEncrypted = true) {
    // Obtener stream del archivo fuente (descifrado si es necesario)
    const sourceStream = await this.getFileStream(sourceStorageKey, sourceEncrypted);

    // Guardar como bitcopy (cifrado)
    const result = await this.saveFileStream(
      sourceStream,
      STORAGE_STRUCTURE.BITCOPY,
      evidenceId,
      originalFilename,
      true // Siempre cifrar bitcopy
    );

    return {
      storageKey: result.storageKey,
      sizeBytes: result.sizeBytes,
      hash: result.hash
    };
  }

  // ==========================================================================
  // CALCULAR HASH SHA-256
  // ==========================================================================

  /**
   * Calcula hash SHA-256 de un archivo usando streaming
   * @param {string} storageKey - Clave de almacenamiento
   * @param {boolean} encrypted - Si el archivo esta cifrado
   * @returns {Promise<string>} Hash hexadecimal
   */
  async calculateHash(storageKey, encrypted = true) {
    const stream = await this.getFileStream(storageKey, encrypted);
    const hash = crypto.createHash('sha256');

    return new Promise((resolve, reject) => {
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  // ==========================================================================
  // VERIFICAR INTEGRIDAD
  // ==========================================================================

  /**
   * Verifica la integridad de un archivo comparando su hash
   * @param {string} storageKey - Clave de almacenamiento
   * @param {string} expectedHash - Hash esperado
   * @param {boolean} encrypted - Si el archivo esta cifrado
   * @returns {Promise<boolean>}
   */
  async verifyIntegrity(storageKey, expectedHash, encrypted = true) {
    try {
      const currentHash = await this.calculateHash(storageKey, encrypted);
      return currentHash === expectedHash;
    } catch (error) {
      console.error(`Error verificando integridad de ${storageKey}:`, error);
      return false;
    }
  }

  // ==========================================================================
  // ELIMINAR ARCHIVO
  // ==========================================================================

  /**
   * Elimina un archivo y su metadata de cifrado si existe
   * @param {string} storageKey - Clave de almacenamiento
   */
  async deleteFile(storageKey) {
    const basePath = getFullPath(storageKey);
    const encryptedPath = `${basePath}.enc`;
    const metadataPath = `${basePath}.meta`;

    // Intentar eliminar todos los archivos relacionados
    const filesToDelete = [basePath, encryptedPath, metadataPath];

    for (const filePath of filesToDelete) {
      try {
        if (fs.existsSync(filePath)) {
          await fs.promises.unlink(filePath);
        }
      } catch (error) {
        console.error(`Error eliminando ${filePath}:`, error);
      }
    }
  }

  // ==========================================================================
  // OBTENER INFORMACION DE ARCHIVO
  // ==========================================================================

  /**
   * Obtiene informacion de un archivo almacenado
   * @param {string} storageKey - Clave de almacenamiento
   * @returns {Promise<{exists: boolean, sizeBytes?: number, encrypted?: boolean}>}
   */
  async getFileInfo(storageKey) {
    const basePath = getFullPath(storageKey);
    const encryptedPath = `${basePath}.enc`;

    // Verificar si existe cifrado
    if (fs.existsSync(encryptedPath)) {
      const stats = await fs.promises.stat(encryptedPath);
      return {
        exists: true,
        sizeBytes: stats.size,
        encrypted: true
      };
    }

    // Verificar si existe sin cifrar
    if (fs.existsSync(basePath)) {
      const stats = await fs.promises.stat(basePath);
      return {
        exists: true,
        sizeBytes: stats.size,
        encrypted: false
      };
    }

    return { exists: false };
  }
}

// ============================================================================
// INSTANCIA SINGLETON
// ============================================================================
const storageService = new StorageService();

module.exports = storageService;
