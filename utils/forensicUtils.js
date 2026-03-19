// ============================================================================
// FORENSIC UTILS - Funciones centralizadas para cadena de custodia forense
// Sistema PRUEBA DIGITAL
// Cumple: SWGDE, ISO/IEC 27037, NIST SP 800-86, RFC 8785 (JCS)
// ============================================================================

const crypto = require('crypto');
const canonicalize = require('canonicalize'); // RFC 8785 JCS implementation

// ============================================================================
// CONSTANTES FORENSES
// ============================================================================

/**
 * Genesis hash: 64 ceros para el primer evento de una evidencia.
 * Permite verificación externa sin casos especiales de null.
 */
const GENESIS_HASH = '0'.repeat(64);

/**
 * Algoritmo de hash estándar para eventos y archivos
 */
const HASH_ALGORITHM = 'SHA-256';

/**
 * Método de canonización estándar
 */
const CANONICALIZATION_METHOD = 'JCS-RFC8785';

/**
 * Algoritmo de firma digital
 */
const SIGNATURE_ALGORITHM = 'Ed25519';

/**
 * Encoding de firma
 */
const SIGNATURE_ENCODING = 'base64';

// ============================================================================
// FUNCIONES DE CANONIZACIÓN
// ============================================================================

/**
 * Canoniza un objeto JSON según RFC 8785 (JSON Canonicalization Scheme).
 * Garantiza serialización determinista: mismo input -> mismo output.
 *
 * @param {Object} obj - Objeto a canonizar
 * @returns {string} JSON canonizado como string UTF-8
 * @throws {Error} Si la canonización falla
 */
function canonicalizeJson(obj) {
  if (obj === undefined) {
    throw new Error('canonicalizeJson: objeto undefined no permitido');
  }

  const result = canonicalize(obj);

  if (result === undefined || result === null) {
    throw new Error('canonicalizeJson: canonización retornó null/undefined');
  }

  return result;
}

// ============================================================================
// FUNCIONES DE HASH
// ============================================================================

/**
 * Calcula SHA-256 de bytes o string.
 *
 * @param {Buffer|string} data - Datos a hashear
 * @returns {string} Hash hexadecimal en minúsculas (64 caracteres)
 */
function computeSha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Calcula SHA-256 de un objeto JSON canonizado.
 *
 * @param {Object} obj - Objeto a hashear
 * @returns {string} Hash hexadecimal (64 caracteres)
 */
function computeJsonHash(obj) {
  const canonical = canonicalizeJson(obj);
  return computeSha256Hex(canonical);
}

// ============================================================================
// FUNCIONES DE EVENTO
// ============================================================================

/**
 * Construye el objeto eventForHash según especificación forense.
 * Excluye campos derivados: eventHash, signature, publicKeyPem.
 *
 * El objeto resultante se usa para calcular eventHash = SHA256(JCS(eventForHash))
 *
 * @param {Object} params - Parámetros del evento
 * @param {string} params.eventId - UUID v4 del evento
 * @param {string} params.evidenceUuid - UUID de la evidencia
 * @param {number|null} params.caseId - ID del caso (puede ser null)
 * @param {string} params.eventType - Tipo de evento (enum CustodyEventType)
 * @param {string} params.occurredAtUtc - Timestamp ISO8601 UTC con ms
 * @param {Object} params.actor - Actor {type, id, displayName}
 * @param {number} params.sequence - Número de secuencia (1..N)
 * @param {string} params.prevEventHash - Hash del evento anterior (o GENESIS_HASH)
 * @param {Object} params.payload - Datos específicos del evento
 * @returns {Object} Objeto eventForHash listo para canonizar y hashear
 */
function buildEventForHash({
  eventId,
  evidenceUuid,
  caseId,
  eventType,
  occurredAtUtc,
  actor,
  sequence,
  prevEventHash,
  payload
}) {
  // Validaciones
  if (!eventId) throw new Error('buildEventForHash: eventId requerido');
  if (!evidenceUuid) throw new Error('buildEventForHash: evidenceUuid requerido');
  if (!eventType) throw new Error('buildEventForHash: eventType requerido');
  if (!occurredAtUtc) throw new Error('buildEventForHash: occurredAtUtc requerido');
  if (!actor) throw new Error('buildEventForHash: actor requerido');
  if (typeof sequence !== 'number' || sequence < 1) {
    throw new Error('buildEventForHash: sequence debe ser entero >= 1');
  }
  if (!prevEventHash || prevEventHash.length !== 64) {
    throw new Error('buildEventForHash: prevEventHash debe ser string de 64 caracteres hex');
  }

  // Construir objeto en orden definido (JCS ordenará alfabéticamente)
  return {
    eventId,
    evidenceUuid,
    caseId: caseId !== undefined ? caseId : null,
    eventType,
    occurredAtUtc,
    actor: {
      type: actor.type,
      id: actor.id !== undefined ? actor.id : null,
      displayName: actor.displayName || null
    },
    sequence,
    prevEventHash,
    payload: payload || {}
  };
}

/**
 * Calcula el eventHash de un evento según especificación forense.
 * eventHash = SHA256(JCS(eventForHash))
 *
 * @param {Object} eventForHash - Objeto construido con buildEventForHash
 * @returns {string} Hash hexadecimal (64 caracteres)
 */
function computeEventHash(eventForHash) {
  return computeJsonHash(eventForHash);
}

/**
 * Verifica que un eventHash es correcto recalculándolo.
 *
 * @param {Object} eventForHash - Objeto original del evento
 * @param {string} expectedHash - Hash esperado
 * @returns {{valid: boolean, computed: string, expected: string}}
 */
function verifyEventHash(eventForHash, expectedHash) {
  const computed = computeEventHash(eventForHash);
  return {
    valid: computed === expectedHash,
    computed,
    expected: expectedHash
  };
}

// ============================================================================
// FUNCIONES DE MANIFEST
// ============================================================================

/**
 * Construye el manifestContent según especificación forense.
 * Incluye hashes Y storageObjectIds de todos los componentes.
 *
 * @param {Object} params - Parámetros del manifest
 * @returns {Object} manifestContent listo para hashear y firmar
 */
function buildManifestContent({
  version = '1.0',
  evidenceUuid,
  caseId,
  original,
  bitcopy,
  sealedDocument,
  metadataPayloadHashSha256,
  metadataPayloadStorageObjectId,
  riskReportPayloadHashSha256,
  riskReportPayloadStorageObjectId,
  eventlog,
  // Backward compatibility: acepta eventLogHashSha256 si eventlog no viene
  eventLogHashSha256,
  lastEventHash,
  lastEventSequence,
  sealedAtUtc
}) {
  if (!evidenceUuid) throw new Error('buildManifestContent: evidenceUuid requerido');
  if (!lastEventHash) throw new Error('buildManifestContent: lastEventHash requerido');
  if (typeof lastEventSequence !== 'number') {
    throw new Error('buildManifestContent: lastEventSequence debe ser número');
  }

  // Construir objeto eventlog según requerimiento líneas 288-291
  let eventlogObj;
  if (eventlog && typeof eventlog === 'object') {
    eventlogObj = {
      storageObjectId: eventlog.storageObjectId || null,
      hashSha256: eventlog.hashSha256
    };
  } else if (eventLogHashSha256) {
    // Backward compatibility
    eventlogObj = {
      storageObjectId: null,
      hashSha256: eventLogHashSha256
    };
  } else {
    throw new Error('buildManifestContent: eventlog o eventLogHashSha256 requerido');
  }

  // Estructura del manifest forense
  return {
    version,
    caseId: caseId !== undefined ? caseId : null,
    evidenceId: evidenceUuid, // Solo evidenceId, NO evidenceUuid
    sealedAtUtc: sealedAtUtc || new Date().toISOString(),
    original: original || null,
    bitcopy: bitcopy || null,
    sealedDocument: sealedDocument || null,
    metadataPayloadHashSha256: metadataPayloadHashSha256 || null,
    metadataPayloadStorageObjectId: metadataPayloadStorageObjectId || null,
    riskReportPayloadHashSha256: riskReportPayloadHashSha256 || null,
    riskReportPayloadStorageObjectId: riskReportPayloadStorageObjectId || null,
    eventlog: eventlogObj,
    lastEventHash,
    lastEventSequence
  };
}

/**
 * Calcula el hash del manifest.
 * manifestHashSha256 = SHA256(JCS(manifestContent))
 *
 * @param {Object} manifestContent - Contenido del manifest
 * @returns {string} Hash hexadecimal (64 caracteres)
 */
function computeManifestHash(manifestContent) {
  return computeJsonHash(manifestContent);
}

// ============================================================================
// FUNCIONES DE EVENTLOG
// ============================================================================

/**
 * Genera el contenido del archivo eventlog.jsonl.
 * Cada línea es un JSON independiente, ordenado por sequence.
 *
 * @param {Array} events - Array de eventos ordenados por sequence
 * @returns {string} Contenido del archivo JSONL
 */
function generateEventlogJsonl(events) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('generateEventlogJsonl: events debe ser array no vacío');
  }

  // Verificar orden por sequence
  for (let i = 1; i < events.length; i++) {
    if (events[i].sequence <= events[i - 1].sequence) {
      throw new Error(`generateEventlogJsonl: eventos no ordenados por sequence en posición ${i}`);
    }
  }

  const lines = events.map(event => {
    // Fase 4: Usar actorDisplayName de columna normalizada
    // Soporta eventos legacy que tienen details._actor
    const actor = event.details?._actor || event.actor || {
      type: event.actorType,
      id: event.actorUserId || null,
      displayName: event.actorDisplayName || null
    };

    // Payload limpio (sin _actor si existe en eventos legacy)
    let payload = event.payload || event.details || {};
    if (payload._actor) {
      payload = { ...payload };
      delete payload._actor;
    }

    // Construir estructura estándar para cada línea
    const eventLine = {
      eventId: event.eventUuid || event.eventId,
      evidenceUuid: event.evidenceUuid,
      caseId: event.caseId !== undefined ? event.caseId : null,
      sequence: event.sequence,
      eventType: event.eventType,
      occurredAtUtc: event.occurredAtUtc || event.eventAt,
      actor,
      payload,
      prevEventHash: event.prevEventHash,
      eventHash: event.eventHash,
      eventHashAlgorithm: event.eventHashAlgorithm || HASH_ALGORITHM,
      eventCanonicalization: event.eventCanonicalization || CANONICALIZATION_METHOD
    };

    return JSON.stringify(eventLine);
  });

  return lines.join('\n');
}

/**
 * Calcula el hash del archivo eventlog.jsonl.
 * eventLogHashSha256 = SHA256(bytes exactos del archivo)
 *
 * @param {string} eventlogContent - Contenido del archivo JSONL
 * @returns {string} Hash hexadecimal (64 caracteres)
 */
function computeEventlogHash(eventlogContent) {
  return computeSha256Hex(eventlogContent);
}

// ============================================================================
// FUNCIONES DE VERIFICACIÓN
// ============================================================================

/**
 * Verifica la integridad de una cadena de eventos.
 *
 * @param {Array} events - Eventos ordenados por sequence
 * @param {string} evidenceUuid - UUID de la evidencia
 * @returns {{valid: boolean, errors: Array}}
 */
function verifyEventChain(events, evidenceUuid) {
  const errors = [];

  if (!events || events.length === 0) {
    return { valid: true, errors: [] };
  }

  // Verificar primer evento tiene genesis hash
  const firstEvent = events[0];
  if (firstEvent.prevEventHash !== GENESIS_HASH && firstEvent.prevEventHash !== null) {
    errors.push({
      sequence: firstEvent.sequence,
      error: `Primer evento debe tener prevEventHash = GENESIS_HASH o null. Encontrado: ${firstEvent.prevEventHash}`
    });
  }

  // Verificar cada evento
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const expectedSequence = i + 1;

    // Verificar sequence
    if (event.sequence !== expectedSequence) {
      errors.push({
        sequence: event.sequence,
        error: `Sequence esperado ${expectedSequence}, encontrado ${event.sequence}`
      });
    }

    // Verificar prevEventHash (desde segundo evento)
    if (i > 0) {
      const prevEvent = events[i - 1];
      if (event.prevEventHash !== prevEvent.eventHash) {
        errors.push({
          sequence: event.sequence,
          error: `prevEventHash no coincide. Esperado: ${prevEvent.eventHash}, Encontrado: ${event.prevEventHash}`
        });
      }
    }

    // Recalcular eventHash
    try {
      // Fase 4: Usar actorDisplayName de columna normalizada
      // Soporta eventos legacy que aun tienen details._actor
      const actor = event.details?._actor || {
        type: event.actorType,
        id: event.actorUserId || null,
        displayName: event.actorDisplayName || null
      };

      // Payload limpio (sin _actor ni caseId que van en campos separados)
      const payload = { ...(event.details || {}) };
      delete payload._actor;
      delete payload.caseId;

      const eventForHash = buildEventForHash({
        eventId: event.eventUuid,
        evidenceUuid,
        caseId: event.details?.caseId || null,
        eventType: event.eventType,
        occurredAtUtc: event.eventAt instanceof Date
          ? event.eventAt.toISOString()
          : event.eventAt,
        actor,
        sequence: event.sequence,
        prevEventHash: event.prevEventHash || GENESIS_HASH,
        payload
      });

      const computed = computeEventHash(eventForHash);
      if (computed !== event.eventHash) {
        errors.push({
          sequence: event.sequence,
          error: `eventHash no coincide. Esperado: ${event.eventHash}, Calculado: ${computed}`
        });
      }
    } catch (err) {
      errors.push({
        sequence: event.sequence,
        error: `Error verificando hash: ${err.message}`
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Verifica una firma Ed25519.
 *
 * @param {string} data - Datos firmados (el hash del manifest)
 * @param {string} signatureBase64 - Firma en base64
 * @param {string} publicKeyPem - Clave pública PEM (SPKI)
 * @returns {boolean} true si la firma es válida
 */
function verifyEd25519Signature(data, signatureBase64, publicKeyPem) {
  try {
    const pubKey = crypto.createPublicKey(publicKeyPem);
    const signature = Buffer.from(signatureBase64, 'base64');
    // Ed25519 firma el hash directamente (no necesita algoritmo de hash)
    return crypto.verify(null, Buffer.from(data, 'utf8'), pubKey, signature);
  } catch (error) {
    console.error('[ForensicUtils] Error verificando firma:', error.message);
    return false;
  }
}

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  // Constantes
  GENESIS_HASH,
  HASH_ALGORITHM,
  CANONICALIZATION_METHOD,
  SIGNATURE_ALGORITHM,
  SIGNATURE_ENCODING,

  // Canonización
  canonicalizeJson,

  // Hash
  computeSha256Hex,
  computeJsonHash,

  // Eventos
  buildEventForHash,
  computeEventHash,
  verifyEventHash,

  // Manifest
  buildManifestContent,
  computeManifestHash,

  // Eventlog
  generateEventlogJsonl,
  computeEventlogHash,

  // Verificación
  verifyEventChain,
  verifyEd25519Signature
};
