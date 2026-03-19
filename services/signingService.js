// ============================================================================
// SIGNING SERVICE - Firma digital Ed25519 para sello criptografico
// Sistema PRUEBA DIGITAL
// Cumple: Cambio 6 - Sello verificable con firma real
// ============================================================================

const crypto = require('crypto');
const canonicalize = require('canonicalize');
const { PrismaClient } = require('@prisma/client');
const hashService = require('./hashService');

const prisma = new PrismaClient();

// ============================================================================
// CLASE DE SERVICIO DE FIRMA DIGITAL
// ============================================================================

class SigningService {
  constructor() {
    this._activeKey = null; // Cache en memoria
  }

  /**
   * Obtiene o crea el keypair Ed25519 activo.
   * La clave privada se almacena cifrada con STORAGE_ENCRYPTION_KEY (AES-256-GCM).
   * @returns {Promise<{fingerprint: string, publicKeyPem: string, privateKey: crypto.KeyObject}>}
   */
  async getOrCreateActiveKey() {
    if (this._activeKey) return this._activeKey;

    // Buscar clave activa en BD
    let keyRecord = await prisma.signingKey.findFirst({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' }
    });

    if (!keyRecord) {
      console.log('[SigningService] No se encontro clave activa, generando nueva keypair Ed25519...');
      keyRecord = await this._generateAndStoreKey();
      console.log(`[SigningService] Keypair generada. Fingerprint: ${keyRecord.fingerprint}`);
    }

    this._activeKey = {
      fingerprint: keyRecord.fingerprint,
      publicKeyPem: keyRecord.publicKeyPem,
      privateKey: this._decryptPrivateKey(keyRecord)
    };

    return this._activeKey;
  }

  /**
   * Genera keypair Ed25519, cifra la clave privada y la almacena en BD
   * @returns {Promise<Object>} Registro de SigningKey creado
   */
  async _generateAndStoreKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

    // Fingerprint = SHA-256 del DER de la clave publica
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    const fingerprint = crypto.createHash('sha256').update(publicKeyDer).digest('hex');

    // Cifrar clave privada con STORAGE_ENCRYPTION_KEY (AES-256-GCM)
    const encryptionKey = this._getEncryptionKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);

    let encrypted = cipher.update(privateKeyPem, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag();

    const record = await prisma.signingKey.create({
      data: {
        fingerprint,
        algorithm: 'Ed25519',
        publicKeyPem,
        privateKeyEnc: encrypted,
        privateKeyIv: iv.toString('hex'),
        privateKeyAuthTag: authTag.toString('hex'),
        isActive: true
      }
    });

    return record;
  }

  /**
   * Descifra la clave privada desde un registro de SigningKey
   * @param {Object} keyRecord - Registro de BD
   * @returns {crypto.KeyObject} Clave privada descifrada
   */
  _decryptPrivateKey(keyRecord) {
    const encryptionKey = this._getEncryptionKey();
    const iv = Buffer.from(keyRecord.privateKeyIv, 'hex');
    const authTag = Buffer.from(keyRecord.privateKeyAuthTag, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(keyRecord.privateKeyEnc, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    return crypto.createPrivateKey(decrypted);
  }

  /**
   * Obtiene la clave de cifrado del environment
   * @returns {Buffer} Clave de 32 bytes
   */
  _getEncryptionKey() {
    const keyHex = process.env.STORAGE_ENCRYPTION_KEY;
    if (!keyHex || keyHex.length !== 64) {
      throw new Error('STORAGE_ENCRYPTION_KEY debe ser un string hexadecimal de 64 caracteres (256 bits)');
    }
    return Buffer.from(keyHex, 'hex');
  }

  /**
   * Firma un manifest con Ed25519.
   *
   * IMPORTANTE: La firma es sobre el manifestHashSha256 (el hash del JSON canonizado),
   * NO sobre el JSON canonizado directamente. Esto permite verificar la firma
   * conociendo solo el hash, sin necesitar reconstruir el JSON completo.
   *
   * signedContent = manifestHashSha256 = SHA256(JCS(manifestContent))
   * signature = Ed25519_sign(signedContent)
   *
   * @param {Object} manifest - Objeto manifest a firmar
   * @returns {Promise<Object>} Resultado de la firma
   */
  async signManifest(manifest) {
    const key = await this.getOrCreateActiveKey();

    // Canonicalizar manifest para hash determinista
    const canonicalManifest = canonicalize(manifest);
    if (!canonicalManifest) {
      throw new Error('Error canonicalizando manifest con JCS');
    }

    // Calcular hash del manifest canonizado
    const manifestHash = hashService.calculateFromBuffer(canonicalManifest);

    // IMPORTANTE: Firmar el HASH (string UTF-8), no el JSON completo
    // Esto permite verificación más simple y eficiente
    const signature = crypto.sign(null, Buffer.from(manifestHash, 'utf8'), key.privateKey);

    return {
      manifestHashSha256: manifestHash,
      signature: signature.toString('base64'),
      signatureAlgorithm: 'Ed25519',
      signingKeyFingerprint: key.fingerprint,
      publicKeyPem: key.publicKeyPem
    };
  }

  /**
   * Verifica la firma de un manifest.
   * La firma es sobre el manifestHashSha256, no sobre el JSON.
   *
   * @param {string} manifestHashSha256 - Hash del manifest (64 hex chars)
   * @param {string} signatureBase64 - Firma en base64
   * @param {string} publicKeyPem - Clave publica PEM
   * @returns {boolean} true si la firma es valida
   */
  verifyManifestSignature(manifestHashSha256, signatureBase64, publicKeyPem) {
    try {
      const pubKey = crypto.createPublicKey(publicKeyPem);
      const signature = Buffer.from(signatureBase64, 'base64');
      // La firma es sobre el hash como string UTF-8
      return crypto.verify(null, Buffer.from(manifestHashSha256, 'utf8'), pubKey, signature);
    } catch (error) {
      console.error('[SigningService] Error verificando firma:', error.message);
      return false;
    }
  }

  /**
   * Verifica una firma Ed25519
   * @param {string} canonicalData - Datos canonicalizados (string)
   * @param {string} signatureBase64 - Firma en base64
   * @param {string} publicKeyPem - Clave publica PEM
   * @returns {boolean} true si la firma es valida
   */
  verifySignature(canonicalData, signatureBase64, publicKeyPem) {
    const pubKey = crypto.createPublicKey(publicKeyPem);
    const signature = Buffer.from(signatureBase64, 'base64');
    return crypto.verify(null, Buffer.from(canonicalData, 'utf8'), pubKey, signature);
  }

  /**
   * Exporta la clave publica activa como PEM
   * @returns {Promise<string>} Clave publica en formato PEM
   */
  async getPublicKeyPem() {
    const key = await this.getOrCreateActiveKey();
    return key.publicKeyPem;
  }

  /**
   * Obtiene el fingerprint de la clave activa
   * @returns {Promise<string>} SHA-256 fingerprint
   */
  async getActiveFingerprint() {
    const key = await this.getOrCreateActiveKey();
    return key.fingerprint;
  }

  /**
   * Invalida el cache de la clave (util tras rotacion de claves)
   */
  invalidateCache() {
    this._activeKey = null;
  }
}

// ============================================================================
// INSTANCIA SINGLETON
// ============================================================================
const signingService = new SigningService();

module.exports = signingService;
