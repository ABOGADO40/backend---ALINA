// ============================================================================
// HASH SERVICE - Calculo de hashes SHA-256
// Sistema PRUEBA DIGITAL
// ============================================================================

const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ============================================================================
// CLASE DE SERVICIO DE HASH
// ============================================================================

class HashService {
  /**
   * Calcula hash SHA-256 de un buffer o string
   * @param {Buffer|string} data - Datos a hashear
   * @returns {string} Hash hexadecimal
   */
  calculateFromBuffer(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Calcula hash SHA-256 de un stream
   * @param {ReadableStream} stream - Stream de datos
   * @returns {Promise<string>} Hash hexadecimal
   */
  async calculateFromStream(stream) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');

      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Guarda un registro de hash en la base de datos
   * @param {number} evidenceFileId - ID del archivo de evidencia
   * @param {string} hashHex - Hash hexadecimal SHA-256
   * @param {number} userId - ID del usuario que registra
   * @returns {Promise<Object>} Registro creado
   */
  async saveHashRecord(evidenceFileId, hashHex, userId = null) {
    return prisma.hashRecord.create({
      data: {
        evidenceFileId,
        algorithm: 'SHA256',
        hashHex,
        userIdRegistration: userId
      }
    });
  }

  /**
   * Busca un hash en la base de datos
   * @param {string} hashHex - Hash hexadecimal a buscar
   * @returns {Promise<Object|null>} Registro encontrado o null
   */
  async findByHash(hashHex) {
    return prisma.hashRecord.findFirst({
      where: { hashHex },
      include: {
        evidenceFile: {
          include: {
            evidence: {
              include: {
                owner: {
                  select: {
                    id: true,
                    email: true,
                    fullName: true
                  }
                }
              }
            }
          }
        }
      }
    });
  }

  /**
   * Busca un hash y verifica si la evidencia es publica
   * @param {string} hashHex - Hash hexadecimal a buscar
   * @returns {Promise<{found: boolean, isPublic: boolean, evidence?: Object}>}
   */
  async verifyPublicHash(hashHex) {
    const hashRecord = await this.findByHash(hashHex);

    if (!hashRecord) {
      return { found: false, isPublic: false };
    }

    const evidence = hashRecord.evidenceFile.evidence;

    return {
      found: true,
      isPublic: evidence.isPublic,
      evidence: evidence.isPublic ? {
        id: evidence.id,
        title: evidence.title,
        sourceType: evidence.sourceType,
        status: evidence.status,
        createdAt: evidence.createdAt,
        hash: {
          algorithm: hashRecord.algorithm,
          hashHex: hashRecord.hashHex,
          computedAt: hashRecord.computedAt
        },
        fileRole: hashRecord.evidenceFile.fileRole
      } : null
    };
  }

  /**
   * Obtiene todos los hashes de una evidencia
   * @param {number} evidenceId - ID de la evidencia
   * @returns {Promise<Array>} Lista de hashes
   */
  async getEvidenceHashes(evidenceId) {
    return prisma.hashRecord.findMany({
      where: {
        evidenceFile: {
          evidenceId
        }
      },
      include: {
        evidenceFile: {
          select: {
            id: true,
            fileRole: true,
            version: true,
            originalFilename: true
          }
        }
      },
      orderBy: {
        computedAt: 'asc'
      }
    });
  }

  /**
   * Verifica si un hash ya existe en el sistema
   * @param {string} hashHex - Hash hexadecimal
   * @returns {Promise<boolean>}
   */
  async hashExists(hashHex) {
    const count = await prisma.hashRecord.count({
      where: { hashHex }
    });
    return count > 0;
  }

  // NOTA: Los metodos de hash de eventos (calculateEventHash, buildEventCore) fueron
  // migrados a forensicUtils.js para centralizacion. Usar:
  // - forensicUtils.buildEventForHash()
  // - forensicUtils.computeEventHash()
}

// ============================================================================
// INSTANCIA SINGLETON
// ============================================================================
const hashService = new HashService();

module.exports = hashService;
