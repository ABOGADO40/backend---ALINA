// ============================================================================
// CLEANUP WORKER - Limpieza periodica de archivos temporales
// Sistema PRUEBA DIGITAL
// ============================================================================

const fs = require('fs');
const path = require('path');
const { prisma } = require('../config/db');
const { UPLOAD_BASE_DIR } = require('../config/storage');

// ============================================================================
// CONFIGURACION
// ============================================================================

const CLEANUP_INTERVAL_HOURS = 1; // Ejecutar cada hora
const TEMP_FILE_MAX_AGE_HOURS = 2; // Archivos temp mayores a 2 horas
const EXPORT_EXPIRY_DAYS = 7; // Exportaciones expiran en 7 dias
const SESSION_EXPIRY_HOURS = 4; // Sesiones expiran en 4 horas

// ============================================================================
// TAREAS DE LIMPIEZA
// ============================================================================

/**
 * Limpia archivos temporales de upload
 */
async function cleanupTempFiles() {
  const tempDir = path.join(UPLOAD_BASE_DIR, 'temp');
  const maxAge = TEMP_FILE_MAX_AGE_HOURS * 60 * 60 * 1000;
  let cleaned = 0;

  try {
    if (!fs.existsSync(tempDir)) {
      return { cleaned: 0, message: 'Directorio temp no existe' };
    }

    const files = await fs.promises.readdir(tempDir);
    const now = Date.now();

    for (const file of files) {
      try {
        const filePath = path.join(tempDir, file);
        const stats = await fs.promises.stat(filePath);

        if (now - stats.mtimeMs > maxAge) {
          await fs.promises.unlink(filePath);
          cleaned++;
        }
      } catch (e) {
        // Ignorar errores individuales
      }
    }

    return { cleaned, message: `${cleaned} archivos temporales eliminados` };
  } catch (error) {
    console.error('[CleanupWorker] Error limpiando temp:', error);
    return { cleaned: 0, error: error.message };
  }
}

/**
 * Limpia sesiones expiradas
 */
async function cleanupExpiredSessions() {
  try {
    const result = await prisma.session.deleteMany({
      where: {
        expiresAt: {
          lt: new Date()
        }
      }
    });

    return {
      cleaned: result.count,
      message: `${result.count} sesiones expiradas eliminadas`
    };
  } catch (error) {
    console.error('[CleanupWorker] Error limpiando sesiones:', error);
    return { cleaned: 0, error: error.message };
  }
}

/**
 * Marca exportaciones expiradas
 */
async function markExpiredExports() {
  try {
    const result = await prisma.export.updateMany({
      where: {
        status: 'READY',
        expiresAt: {
          lt: new Date()
        }
      },
      data: {
        status: 'EXPIRED'
      }
    });

    return {
      marked: result.count,
      message: `${result.count} exportaciones marcadas como expiradas`
    };
  } catch (error) {
    console.error('[CleanupWorker] Error marcando exportaciones:', error);
    return { marked: 0, error: error.message };
  }
}

/**
 * Limpia archivos de exportaciones expiradas (opcional)
 */
async function cleanupExpiredExportFiles() {
  try {
    // Obtener exportaciones expiradas hace mas de 30 dias
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const expiredExports = await prisma.export.findMany({
      where: {
        status: 'EXPIRED',
        expiresAt: {
          lt: thirtyDaysAgo
        },
        storageKey: {
          not: null
        }
      },
      select: {
        id: true,
        storageKey: true
      }
    });

    let deleted = 0;

    for (const exp of expiredExports) {
      try {
        const filePath = path.join(UPLOAD_BASE_DIR, exp.storageKey);
        if (fs.existsSync(filePath)) {
          await fs.promises.unlink(filePath);
          deleted++;
        }

        // Limpiar referencia
        await prisma.export.update({
          where: { id: exp.id },
          data: { storageKey: null }
        });
      } catch (e) {
        // Ignorar errores individuales
      }
    }

    return {
      deleted,
      message: `${deleted} archivos de exportaciones eliminados`
    };
  } catch (error) {
    console.error('[CleanupWorker] Error limpiando archivos de exportaciones:', error);
    return { deleted: 0, error: error.message };
  }
}

// ============================================================================
// EJECUTOR PRINCIPAL
// ============================================================================

/**
 * Ejecuta todas las tareas de limpieza
 */
async function runCleanup() {
  console.log('[CleanupWorker] Iniciando tareas de limpieza...');
  const startTime = Date.now();

  const results = {
    tempFiles: await cleanupTempFiles(),
    sessions: await cleanupExpiredSessions(),
    exports: await markExpiredExports(),
    exportFiles: await cleanupExpiredExportFiles()
  };

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`[CleanupWorker] Limpieza completada en ${duration}s`);
  console.log('[CleanupWorker] Resultados:', JSON.stringify(results, null, 2));

  return results;
}

/**
 * Inicia el worker en modo continuo
 */
function startWorker() {
  console.log('[CleanupWorker] Iniciando worker de limpieza...');
  console.log(`[CleanupWorker] Intervalo: cada ${CLEANUP_INTERVAL_HOURS} hora(s)`);

  // Ejecutar inmediatamente
  runCleanup().catch(console.error);

  // Programar ejecucion periodica
  const intervalMs = CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000;
  setInterval(() => {
    runCleanup().catch(console.error);
  }, intervalMs);
}

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  runCleanup,
  startWorker,
  cleanupTempFiles,
  cleanupExpiredSessions,
  markExpiredExports,
  cleanupExpiredExportFiles
};

// ============================================================================
// EJECUCION STANDALONE
// ============================================================================

if (require.main === module) {
  console.log('='.repeat(60));
  console.log('PRUEBA DIGITAL - Cleanup Worker');
  console.log('='.repeat(60));

  // Ejecutar una vez y salir, o continuo si se pasa --daemon
  if (process.argv.includes('--daemon')) {
    startWorker();
  } else {
    runCleanup()
      .then(() => {
        console.log('[CleanupWorker] Limpieza completada');
        process.exit(0);
      })
      .catch(error => {
        console.error('[CleanupWorker] Error:', error);
        process.exit(1);
      });
  }
}
