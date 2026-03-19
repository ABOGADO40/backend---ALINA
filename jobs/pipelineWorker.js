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
const STALE_TIMEOUT_MINUTES = 30; // Considerar estancado despues de 30 minutos

let isRunning = false;
let activeJobs = 0;

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
      // Solo procesar si hay slots disponibles
      if (activeJobs < MAX_CONCURRENT_JOBS) {
        await processNextEvidence();
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
 * Procesa la siguiente evidencia en cola
 */
async function processNextEvidence() {
  // El worker SOLO recupera evidencias estancadas (más de 30 segundos en RECEIVED)
  // Las evidencias nuevas son procesadas directamente por el controller
  const staleTime = new Date(Date.now() - 30 * 1000); // 30 segundos de gracia

  const evidence = await prisma.evidence.findFirst({
    where: {
      status: 'RECEIVED',
      dateTimeModification: { lt: staleTime } // Solo si tiene más de 30 segundos
    },
    orderBy: {
      createdAt: 'asc'
    },
    select: {
      id: true,
      title: true
    }
  });

  if (!evidence) {
    return; // No hay evidencias pendientes para recuperar
  }

  // Procesar de forma asincrona (el pipeline maneja sus propias transiciones de estado)
  activeJobs++;
  console.log(`[PipelineWorker] Recuperando evidencia estancada #${evidence.id}: ${evidence.title}`);

  processEvidenceAsync(evidence.id)
    .catch(error => {
      console.error(`[PipelineWorker] Error procesando evidencia #${evidence.id}:`, error);
    })
    .finally(() => {
      activeJobs--;
    });
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
      data: { status: 'ERROR' }
    }).catch(e => {
      console.error('[PipelineWorker] Error actualizando estado a ERROR:', e);
    });
  }
}

/**
 * Recupera evidencias que quedaron estancadas
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
    console.log(`[PipelineWorker] Recuperadas ${staleEvidences.count} evidencias estancadas`);
  }
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
  processEvidenceAsync
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
