// ============================================================================
// PRUEBA DIGITAL - SERVIDOR PRINCIPAL
// Sistema de Evidencia Digital con Cadena de Custodia
// ============================================================================
// ******************************************************************************
// * CONFIGURACION HIBRIDA: LOCAL / RAILWAY                                     *
// *                                                                            *
// * Este archivo funciona tanto en DESARROLLO LOCAL como en RAILWAY.            *
// * La diferenciacion se hace mediante variables de entorno:                    *
// *   - LOCAL:   Lee del archivo .env (NODE_ENV=development)                   *
// *   - RAILWAY: Lee variables del dashboard de Railway (NODE_ENV=production)  *
// *                                                                            *
// * NO se necesitan cambios en este archivo para alternar entre ambos.         *
// ******************************************************************************

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { connectDatabase, healthCheck } = require('./config/db');
const { initializeStorageStructure, ENCRYPTION_CONFIG } = require('./config/storage');

// ============================================================================
// VALIDACION DE CONFIGURACION CRITICA AL INICIO
// ============================================================================
(function validateCriticalConfig() {
  try {
    ENCRYPTION_CONFIG.getKey();
    console.log('[Config] STORAGE_ENCRYPTION_KEY validada correctamente');
  } catch (error) {
    console.error('=========================================================');
    console.error('ERROR CRITICO: STORAGE_ENCRYPTION_KEY no configurada');
    console.error('=========================================================');
    console.error(error.message);
    console.error('');
    console.error('Solucion: Agregue en su archivo .env:');
    console.error('STORAGE_ENCRYPTION_KEY=<cadena_hexadecimal_64_caracteres>');
    console.error('');
    console.error('Puede generar una clave con:');
    console.error('node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    console.error('=========================================================');
    process.exit(1);
  }
})();

// ============================================================================
// IMPORTAR RUTAS
// ============================================================================
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const caseRoutes = require('./routes/caseRoutes');
const evidenceRoutes = require('./routes/evidenceRoutes');
const exportRoutes = require('./routes/exportRoutes');
const verificationRoutes = require('./routes/verificationRoutes');
const auditRoutes = require('./routes/auditRoutes');
const custodyRoutes = require('./routes/custodyRoutes');

// ============================================================================
// CONFIGURACION
// ============================================================================
const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost');

// ============================================================================
// MIDDLEWARES GLOBALES
// ============================================================================

// Seguridad HTTP
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting global
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Demasiadas solicitudes. Intente mas tarde.'
    }
  }
});
app.use('/api', limiter);

// Logging
app.use(morgan(process.env.LOG_FORMAT || 'dev'));

// Parser JSON con limite aumentado para metadata
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================================================
// RUTAS DE API
// ============================================================================

// Health check
app.get('/health', async (req, res) => {
  const dbHealth = await healthCheck();
  res.json({
    status: dbHealth.status === 'healthy' ? 'OK' : 'ERROR',
    timestamp: new Date().toISOString(),
    services: {
      database: dbHealth,
      server: { status: 'healthy' }
    }
  });
});

// API v1
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/cases', caseRoutes);
app.use('/api/evidence', evidenceRoutes);
app.use('/api/exports', exportRoutes);
app.use('/api/verify', verificationRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/custody', custodyRoutes);

// ============================================================================
// MANEJO DE ERRORES GLOBAL
// ============================================================================

// Ruta no encontrada
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Ruta no encontrada: ${req.method} ${req.path}`
    }
  });
});

// Error handler global
app.use((err, req, res, next) => {
  console.error('[Error]', err);

  // Error de Multer (upload)
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: {
        code: 'FILE_TOO_LARGE',
        message: 'El archivo excede el tamano maximo permitido de 2GB'
      }
    });
  }

  // Error de validacion
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: err.message,
        details: err.errors
      }
    });
  }

  // Error de Prisma
  if (err.code && err.code.startsWith('P')) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'DATABASE_ERROR',
        message: 'Error en operacion de base de datos'
      }
    });
  }

  // Error generico
  res.status(err.status || 500).json({
    success: false,
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'production'
        ? 'Error interno del servidor'
        : err.message
    }
  });
});

// ============================================================================
// MANEJADORES GLOBALES DE ERRORES NO CAPTURADOS
// ============================================================================

process.on('unhandledRejection', (reason, promise) => {
  console.error('============================================');
  console.error('[UNHANDLED REJECTION]');
  console.error('Reason:', reason);
  console.error('============================================');
});

process.on('uncaughtException', (error) => {
  console.error('============================================');
  console.error('[UNCAUGHT EXCEPTION]');
  console.error('Error:', error.message);
  console.error('Stack:', error.stack);
  console.error('============================================');
});

// ============================================================================
// INICIAR SERVIDOR
// ============================================================================

async function startServer() {
  try {
    // Conectar a base de datos
    await connectDatabase();
    console.log('[Server] Base de datos conectada');

    // Inicializar estructura de almacenamiento
    initializeStorageStructure();
    console.log('[Server] Estructura de almacenamiento inicializada');

    // Iniciar servidor HTTP
    app.listen(PORT, HOST, () => {
      const isLocal = process.env.NODE_ENV !== 'production';

      console.log('============================================');
      console.log('  PRUEBA DIGITAL - Servidor Iniciado');
      console.log('============================================');

      // ================================================================
      // INDICADOR VISUAL: LOCAL vs RAILWAY
      // Esto ayuda a identificar rapidamente en que entorno estamos
      // ================================================================
      if (isLocal) {
        console.log('  >>> MODO: DESARROLLO LOCAL <<<');
        console.log(`  Backend:  http://${HOST}:${PORT}`);
        console.log(`  Frontend: ${process.env.CORS_ORIGIN || 'http://localhost:5173'}`);
        console.log(`  Database: PostgreSQL LOCAL (prueba_digital)`);
      } else {
        console.log('  >>> MODO: PRODUCCION (RAILWAY) <<<');
        console.log(`  URL: http://${HOST}:${PORT}`);
        console.log(`  Database: PostgreSQL RAILWAY`);
      }

      console.log(`  Ambiente: ${process.env.NODE_ENV || 'development'}`);
      console.log(`  Timestamp: ${new Date().toISOString()}`);
      console.log('============================================');

      // Iniciar pipeline worker en background
      const { startWorker } = require('./jobs/pipelineWorker');
      startWorker();
      console.log('[Server] Pipeline worker iniciado');
    });

  } catch (error) {
    console.error('[Server] Error al iniciar:', error);
    process.exit(1);
  }
}

startServer();

module.exports = app;
