// ============================================================================
// STORAGE SERVICE - Almacenamiento en Wasabi S3 con cifrado
// Sistema PRUEBA DIGITAL
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PassThrough, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

const { s3, WASABI_BUCKET } = require('../config/wasabi');
const {
  MAX_FILE_SIZE,
  UPLOAD_BASE_DIR,
  STORAGE_STRUCTURE,
  ENCRYPTION_CONFIG,
  generateStorageKey,
  isBlockedExtension
} = require('../config/storage');

// ============================================================================
// CLASE PRINCIPAL DE ALMACENAMIENTO (S3)
// ============================================================================

class StorageService {
  constructor() {
    this.bucket = WASABI_BUCKET;
  }

  // ==========================================================================
  // METODOS HELPER DE ALTO NIVEL (usados por otros servicios)
  // ==========================================================================

  /**
   * Sube un Buffer a S3
   */
  async putBuffer(storageKey, buffer, contentType = 'application/octet-stream') {
    await s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: storageKey,
      Body: buffer,
      ContentType: contentType
    }));
  }

  /**
   * Sube un string a S3
   */
  async putString(storageKey, content, contentType = 'text/plain') {
    await s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: storageKey,
      Body: content,
      ContentType: contentType
    }));
  }

  /**
   * Descarga un objeto de S3 como Buffer
   */
  async getBuffer(storageKey) {
    const { Body } = await s3.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: storageKey
    }));
    return Buffer.from(await Body.transformToByteArray());
  }

  /**
   * Descarga un objeto de S3 como string
   */
  async getString(storageKey) {
    const { Body } = await s3.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: storageKey
    }));
    return Body.transformToString();
  }

  /**
   * Verifica si un objeto existe en S3
   */
  async exists(storageKey) {
    try {
      await s3.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: storageKey
      }));
      return true;
    } catch (err) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Obtiene un readable stream desde S3
   */
  async getS3Stream(storageKey) {
    const { Body } = await s3.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: storageKey
    }));
    return Body;
  }

  /**
   * Sube un stream a S3 usando multipart upload (para archivos grandes)
   */
  async putStream(storageKey, readStream, contentType = 'application/octet-stream') {
    const upload = new Upload({
      client: s3,
      params: {
        Bucket: this.bucket,
        Key: storageKey,
        Body: readStream,
        ContentType: contentType
      },
      queueSize: 4,
      partSize: 64 * 1024 * 1024 // 64MB parts
    });
    await upload.done();
  }

  // ==========================================================================
  // GUARDAR ARCHIVO CON STREAMING Y HASH (para archivos grandes hasta 2GB)
  // ==========================================================================

  async saveFileStream(readStream, folder, evidenceId, originalFilename, encrypt = true) {
    if (isBlockedExtension(originalFilename)) {
      throw new Error(`Extension de archivo bloqueada: ${path.extname(originalFilename)}`);
    }

    const storageKey = generateStorageKey(folder, evidenceId, originalFilename);

    // Calcular hash SHA-256 mientras se procesa
    const hashCalculator = crypto.createHash('sha256');
    let sizeBytes = 0;

    const hashTransform = new Transform({
      transform(chunk, encoding, callback) {
        hashCalculator.update(chunk);
        sizeBytes += chunk.length;
        if (sizeBytes > MAX_FILE_SIZE) {
          callback(new Error(`Archivo excede el tamano maximo de ${MAX_FILE_SIZE / (1024 * 1024 * 1024)}GB`));
          return;
        }
        callback(null, chunk);
      }
    });

    if (encrypt) {
      const { encKey, iv, authTag } = await this._saveEncrypted(readStream, hashTransform, storageKey);
      // Guardar metadata de cifrado como objeto separado en S3
      await this._saveEncryptionMetadata(storageKey, iv, authTag);
    } else {
      // Pipe through hash transform, then upload to S3
      const passThrough = new PassThrough();
      readStream.pipe(hashTransform).pipe(passThrough);
      await this.putStream(storageKey, passThrough);
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

  async _saveEncrypted(readStream, hashTransform, storageKey) {
    const key = ENCRYPTION_CONFIG.getKey();
    const iv = crypto.randomBytes(ENCRYPTION_CONFIG.ivLength);

    const cipher = crypto.createCipheriv(
      ENCRYPTION_CONFIG.algorithm,
      key,
      iv,
      { authTagLength: ENCRYPTION_CONFIG.authTagLength }
    );

    const encryptedKey = `${storageKey}.enc`;

    // Pipeline: readStream -> hashTransform -> cipher -> S3 upload
    const passThrough = new PassThrough();
    readStream.pipe(hashTransform).pipe(cipher).pipe(passThrough);

    await this.putStream(encryptedKey, passThrough);

    const authTag = cipher.getAuthTag();

    return { encKey: encryptedKey, iv, authTag };
  }

  async _saveEncryptionMetadata(storageKey, iv, authTag) {
    const metadataKey = `${storageKey}.meta`;
    const metadata = {
      algorithm: ENCRYPTION_CONFIG.algorithm,
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      createdAt: new Date().toISOString()
    };

    await this.putString(metadataKey, JSON.stringify(metadata), 'application/json');
  }

  // ==========================================================================
  // LEER ARCHIVO CON STREAMING
  // ==========================================================================

  async getFileStream(storageKey, encrypted = true) {
    if (encrypted) {
      return this._readEncrypted(storageKey);
    }

    const objectExists = await this.exists(storageKey);
    if (!objectExists) {
      throw new Error(`Archivo no encontrado: ${storageKey}`);
    }

    return this.getS3Stream(storageKey);
  }

  async _readEncrypted(storageKey) {
    const encryptedKey = `${storageKey}.enc`;
    const metadataKey = `${storageKey}.meta`;

    // Leer metadata de cifrado
    const metadataContent = await this.getString(metadataKey);
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

    const encStream = await this.getS3Stream(encryptedKey);

    const outputStream = new PassThrough();
    pipeline(encStream, decipher, outputStream).catch(err => {
      outputStream.destroy(err);
    });

    return outputStream;
  }

  // ==========================================================================
  // GUARDAR ARCHIVO ORIGINAL DESDE PATH TEMPORAL (usado por Multer)
  // ==========================================================================

  async storeOriginal(tempFilePath, evidenceId, originalFilename, mimeType) {
    if (!fs.existsSync(tempFilePath)) {
      throw new Error(`Archivo temporal no encontrado: ${tempFilePath}`);
    }

    const readStream = fs.createReadStream(tempFilePath, { highWaterMark: 64 * 1024 * 1024 });

    try {
      const result = await this.saveFileStream(
        readStream,
        STORAGE_STRUCTURE.ORIGINAL,
        evidenceId,
        originalFilename,
        true // Cifrar por defecto
      );

      // Eliminar archivo temporal local
      await fs.promises.unlink(tempFilePath);

      return {
        storageKey: result.storageKey,
        sizeBytes: result.sizeBytes,
        hash: result.hash,
        isEncrypted: result.isEncrypted
      };
    } catch (error) {
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

  async createBitcopy(sourceStorageKey, evidenceId, originalFilename, sourceEncrypted = true) {
    const sourceStream = await this.getFileStream(sourceStorageKey, sourceEncrypted);

    const result = await this.saveFileStream(
      sourceStream,
      STORAGE_STRUCTURE.BITCOPY,
      evidenceId,
      originalFilename,
      true
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

  async deleteFile(storageKey) {
    const keysToDelete = [storageKey, `${storageKey}.enc`, `${storageKey}.meta`];

    for (const key of keysToDelete) {
      try {
        if (await this.exists(key)) {
          await s3.send(new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: key
          }));
        }
      } catch (error) {
        console.error(`Error eliminando ${key}:`, error);
      }
    }
  }

  // ==========================================================================
  // OBTENER INFORMACION DE ARCHIVO
  // ==========================================================================

  async getFileInfo(storageKey) {
    // Verificar si existe cifrado
    const encryptedKey = `${storageKey}.enc`;
    try {
      const head = await s3.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: encryptedKey
      }));
      return {
        exists: true,
        sizeBytes: head.ContentLength,
        encrypted: true
      };
    } catch (err) {
      // No existe cifrado, verificar sin cifrar
    }

    try {
      const head = await s3.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: storageKey
      }));
      return {
        exists: true,
        sizeBytes: head.ContentLength,
        encrypted: false
      };
    } catch (err) {
      return { exists: false };
    }
  }
}

// ============================================================================
// INSTANCIA SINGLETON
// ============================================================================
const storageService = new StorageService();

module.exports = storageService;
