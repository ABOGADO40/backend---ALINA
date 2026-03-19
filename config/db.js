// ============================================================================
// DATABASE CONFIGURATION
// Sistema PRUEBA DIGITAL
// ============================================================================
// CONFIGURACION HIBRIDA: LOCAL / RAILWAY
//
// La conexion a la base de datos se determina por la variable DATABASE_URL:
//
// [LOCAL]   DATABASE_URL apunta a PostgreSQL en tu maquina:
//           postgresql://postgres:sql@localhost:5432/prueba_digital
//           (definida en el archivo .env del backend)
//
// [RAILWAY] DATABASE_URL apunta al PostgreSQL gestionado por Railway:
//           (definida automaticamente en el dashboard de Railway)
//
// Este archivo NO necesita cambios para alternar entre LOCAL y RAILWAY.
// La diferenciacion es automatica segun la variable de entorno.
// ============================================================================

const { PrismaClient } = require('@prisma/client');

// ============================================================================
// SINGLETON PRISMA CLIENT
// En LOCAL: usa hot-reload friendly (global.__prisma) para evitar
//           multiples conexiones cuando nodemon reinicia
// En RAILWAY: crea una instancia directa optimizada para produccion
// ============================================================================

let prisma;

if (process.env.NODE_ENV === 'production') {
  prisma = new PrismaClient({
    log: ['error', 'warn'],
    errorFormat: 'minimal'
  });
} else {
  // En desarrollo, reutilizar la misma instancia para evitar
  // multiples conexiones durante hot-reload
  if (!global.__prisma) {
    global.__prisma = new PrismaClient({
      log: ['warn', 'error'],
      errorFormat: 'pretty'
    });
  }
  prisma = global.__prisma;
}

// ============================================================================
// CONEXION Y DESCONEXION
// ============================================================================

/**
 * Conecta a la base de datos
 */
async function connectDatabase() {
  try {
    await prisma.$connect();
    // Mostrar a que base de datos estamos conectados (LOCAL vs RAILWAY)
    const isLocal = process.env.NODE_ENV !== 'production';
    console.log(`[Database] Conexion establecida exitosamente (${isLocal ? 'LOCAL - prueba_digital' : 'RAILWAY - produccion'})`);
    return true;
  } catch (error) {
    console.error('[Database] Error al conectar:', error);
    throw error;
  }
}

/**
 * Desconecta de la base de datos
 */
async function disconnectDatabase() {
  try {
    await prisma.$disconnect();
    console.log('[Database] Desconexion exitosa');
  } catch (error) {
    console.error('[Database] Error al desconectar:', error);
  }
}

/**
 * Verifica la conexion a la base de datos
 */
async function healthCheck() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'healthy', message: 'Database connection OK' };
  } catch (error) {
    return { status: 'unhealthy', message: error.message };
  }
}

// ============================================================================
// MANEJO DE CIERRE GRACEFUL
// ============================================================================

process.on('beforeExit', async () => {
  await disconnectDatabase();
});

process.on('SIGINT', async () => {
  await disconnectDatabase();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await disconnectDatabase();
  process.exit(0);
});

// ============================================================================
// EXPORTACIONES
// ============================================================================

module.exports = {
  prisma,
  connectDatabase,
  disconnectDatabase,
  healthCheck
};
