// ============================================================================
// PIPELINE WORKER - Procesador de cola de evidencias
// Sistema PRUEBA DIGITAL
// ============================================================================

const { prisma } = require('../config/db');
const pipelineService = require('../services/pipelineService');

// ============================================================================
// CONFIGURACION
// ============================================================================

const POLL_INTERVAL_MS = 5000; // 5 segundos
const MAX_CONCURRENT_JOBS = 2; // Procesar 2 evidencias en paralelo
const STALE_TIMEOUT_MINUTES = 15; // Estados intermedios sin progreso por > 15 min se consideran estancados
const RECEIVED_STALE_MINUTES = 5; // Evidencias en RECEIVED sin actividad por > 5 min se reprocesan
const RECOVERY_INTERVAL_POLLS = 12; // Cada 12 polls (~60s) corre recovery exhaustivo

let isRunning = false;
let activeJobs = 0;
let pollCounter = 0;

// ============================================================================
// WORKER PRINCIPAL
// ============================================================================

/**
 * Inicia el worker de pipeline
 */
async function startWorker() {
  if (isRunning) {
    console.log('[PipelineWorker] El worker ya esta en ejecucion');
    return;
  }

  isRunning = true;
  console.log('[PipelineWorker] Iniciando worker de pipeline...');
  console.log(`[PipelineWorker] Intervalo de polling: ${POLL_INTERVAL_MS}ms`);
  console.log(`[PipelineWorker] Max trabajos concurrentes: ${MAX_CONCURRENT_JOBS}`);
  console.log(`[PipelineWorker] Stale timeout estados intermedios: ${STALE_TIMEOUT_MINUTES} min`);
  console.log(`[PipelineWorker] Stale timeout RECEIVED: ${RECEIVED_STALE_MINUTES} min`);

  // Recuperar evidencias estancadas al iniciar
  await recoverStaleEvidences();

  // Iniciar loop de polling
  pollLoop();
}

/**
 * Detiene el worker de pipeline
 */
function stopWorker() {
  console.log('[PipelineWorker] Deteniendo worker...');
  isRunning = false;
}

/**
 * Loop de polling para buscar nuevas evidencias
 */
async function pollLoop() {
  while (isRunning) {
    try {
      // Recovery periodico exhaustivo: vuelve a RECEIVED las evidencias huerfanas
      pollCounter++;
      if (pollCounter % RECOVERY_INTERVAL_POLLS === 0) {
        await recoverStaleEvidences();
      }

      // Procesar mientras haya slots disponibles (no solo una por poll)
      while (isRunning && activeJobs < MAX_CONCURRENT_JOBS) {
        const claimed = await claimAndProcessNextEvidence();
        if (!claimed) break; // No hay mas evidencias para procesar
      }
    } catch (error) {
      console.error('[PipelineWorker] Error en loop de polling:', error);
    }

    // Esperar antes de siguiente poll
    await sleep(POLL_INTERVAL_MS);
  }

  console.log('[PipelineWorker] Worker detenido');
}

/**
 * Intenta reclamar y procesar la siguiente evidencia en cola usando lock pesimista atomico.
 *
 * Lock pesimista: se hace un updateMany con condicion de staleness. Si afecta 1 fila, ESTE
 * worker la "reclamo". Si afecta 0 filas, otro worker la tomo primero.
 *
 * @returns {Promise<boolean>} true si se inicio procesamiento, false si no hay evidencias.
 */
async function claimAndProcessNextEvidence() {
  // Ventana de gracia: evidencias en RECEIVED necesitan al menos N segundos sin modificacion
  // para considerar que el controller que las disparo ya fallo o esta atascado.
  const gracePeriodMs = RECEIVED_STALE_MINUTES * 60 * 1000;
  const staleTime = new Date(Date.now() - gracePeriodMs);

  // Paso 1: BUSCAR candidatos (sin lock) - solo para obtener IDs
  const candidates = await prisma.evidence.findMany({
    where: {
      status: 'RECEIVED',
      OR: [
        { dateTimeModification: { lt: staleTime } },
        { dateTimeModification: null, createdAt: { lt: staleTime } }
      ]
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, title: true, dateTimeModification: true, createdAt: true },
    take: MAX_CONCURRENT_JOBS * 5 // pool de candidatos por si hay carreras
  });

  if (candidates.length === 0) {
    return false;
  }

  // Paso 2: RECLAMAR atomicamente uno por uno hasta que tengamos exito
  for (const candidate of candidates) {
    const now = new Date();
    // updateMany devuelve count; si es 1 = lo tomamos, si es 0 = otro worker se adelanto
    const claimed = await prisma.evidence.updateMany({
      where: {
        id: candidate.id,
        status: 'RECEIVED',
        OR: [
          { dateTimeModification: { lt: staleTime } },
          { dateTimeModification: null, createdAt: { lt: staleTime } }
        ]
      },
      data: {
        dateTimeModification: now // Marca como "tomada por mi"
      }
    });

    if (claimed.count === 1) {
      // Procesamos de forma asincrona
      activeJobs++;
      console.log(`[PipelineWorker] Reclamada evidencia #${candidate.id}: ${candidate.title}`);

      processEvidenceAsync(candidate.id)
        .catch(error => {
          console.error(`[PipelineWorker] Error procesando evidencia #${candidate.id}:`, error);
        })
        .finally(() => {
          activeJobs--;
        });

      return true;
    }
    // Si claimed.count === 0, otro worker lo tomo primero. Probamos con el siguiente candidato.
  }

  return false;
}

/**
 * Procesa una evidencia de forma asincrona
 */
async function processEvidenceAsync(evidenceId) {
  const startTime = Date.now();

  try {
    await pipelineService.processEvidence(evidenceId);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[PipelineWorker] Evidencia #${evidenceId} procesada en ${duration}s`);
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.error(`[PipelineWorker] Evidencia #${evidenceId} fallo despues de ${duration}s:`, error.message);

    // Actualizar estado a ERROR
    await prisma.evidence.update({
      where: { id: evidenceId },
      data: { status: 'ERROR', dateTimeModification: new Date() }
    }).catch(e => {
      console.error('[PipelineWorker] Error actualizando estado a ERROR:', e);
    });
  }
}

/**
 * Recupera evidencias que quedaron estancadas.
 * Se ejecuta al iniciar el worker Y periodicamente cada RECOVERY_INTERVAL_POLLS polls.
 *
 * Restablece a RECEIVED las evidencias en estados intermedios cuya dateTimeModification
 * sea anterior a STALE_TIMEOUT_MINUTES atras.
 */
async function recoverStaleEvidences() {
  const staleTime = new Date(Date.now() - STALE_TIMEOUT_MINUTES * 60 * 1000);
  const intermediateStatuses = ['SCANNED_OK', 'HASHED', 'CLONED_BITCOPY', 'SEALED', 'ANALYZED'];

  const staleEvidences = await prisma.evidence.updateMany({
    where: {
      status: { in: intermediateStatuses },
      dateTimeModification: { lt: staleTime }
    },
    data: {
      status: 'RECEIVED',
      dateTimeModification: new Date()
    }
  });

  if (staleEvidences.count > 0) {
    console.log(`[PipelineWorker] Recuperadas ${staleEvidences.count} evidencias estancadas en estados intermedios`);
  }
}

/**
 * Detecta evidencias problematicas (RECEIVED por mucho tiempo o en ERROR) para reportes admin.
 * No actua sobre ellas, solo informa.
 */
async function detectStuckEvidences() {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const [stuckReceived, errorCount] = await Promise.all([
    prisma.evidence.findMany({
      where: {
        status: 'RECEIVED',
        OR: [
          { dateTimeModification: { lt: oneHourAgo } },
          { dateTimeModification: null, createdAt: { lt: oneHourAgo } }
        ]
      },
      select: { id: true, title: true, status: true, createdAt: true, dateTimeModification: true },
      take: 100
    }),
    prisma.evidence.count({ where: { status: 'ERROR' } })
  ]);

  return {
    stuckReceived,
    errorCount,
    detectedAt: new Date().toISOString()
  };
}

/**
 * Utilidad de sleep
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// ESTADISTICAS
// ============================================================================

/**
 * Obtiene estadisticas del worker
 */
async function getStats() {
  const intermediateStatuses = ['SCANNED_OK', 'HASHED', 'CLONED_BITCOPY', 'SEALED', 'ANALYZED'];

  const [received, processing, ready, error] = await Promise.all([
    prisma.evidence.count({ where: { status: 'RECEIVED' } }),
    prisma.evidence.count({ where: { status: { in: intermediateStatuses } } }),
    prisma.evidence.count({ where: { status: 'READY_FOR_EXPORT' } }),
    prisma.evidence.count({ where: { status: 'ERROR' } })
  ]);

  return {
    isRunning,
    activeJobs,
    maxConcurrentJobs: MAX_CONCURRENT_JOBS,
    pollCounter,
    queue: {
      received,
      processing,
      ready,
      error
    }
  };
}

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  startWorker,
  stopWorker,
  getStats,
  processEvidenceAsync,
  detectStuckEvidences,
  recoverStaleEvidences
};

// ============================================================================
// EJECUCION STANDALONE
// ============================================================================

if (require.main === module) {
  console.log('='.repeat(60));
  console.log('PRUEBA DIGITAL - Pipeline Worker');
  console.log('='.repeat(60));

  // Manejar senales de terminacion
  process.on('SIGINT', () => {
    console.log('\n[PipelineWorker] Recibida senal SIGINT');
    stopWorker();
    setTimeout(() => process.exit(0), 2000);
  });

  process.on('SIGTERM', () => {
    console.log('\n[PipelineWorker] Recibida senal SIGTERM');
    stopWorker();
    setTimeout(() => process.exit(0), 2000);
  });

  // Iniciar worker
  startWorker().catch(error => {
    console.error('[PipelineWorker] Error fatal:', error);
    process.exit(1);
  });
}
