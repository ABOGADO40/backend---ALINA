// ============================================================================
// WASABI S3 CONFIGURATION
// Sistema PRUEBA DIGITAL - Almacenamiento persistente en la nube
// ============================================================================

const { S3Client, HeadBucketCommand, CreateBucketCommand } = require('@aws-sdk/client-s3');

const WASABI_REGION = process.env.WASABI_REGION || 'us-east-1';
const WASABI_ENDPOINT = process.env.WASABI_ENDPOINT || `https://s3.${WASABI_REGION}.wasabisys.com`;
const WASABI_BUCKET = process.env.WASABI_BUCKET || 'prueba-digital-alina';

const s3 = new S3Client({
  region: WASABI_REGION,
  endpoint: WASABI_ENDPOINT,
  credentials: {
    accessKeyId: process.env.WASABI_ACCESS_KEY,
    secretAccessKey: process.env.WASABI_SECRET_KEY
  },
  forcePathStyle: true
});

/**
 * Verifica que el bucket existe, si no lo crea
 */
async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: WASABI_BUCKET }));
    console.log(`[Wasabi] Bucket '${WASABI_BUCKET}' verificado`);
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      console.log(`[Wasabi] Creando bucket '${WASABI_BUCKET}'...`);
      await s3.send(new CreateBucketCommand({ Bucket: WASABI_BUCKET }));
      console.log(`[Wasabi] Bucket '${WASABI_BUCKET}' creado exitosamente`);
    } else {
      throw err;
    }
  }
}

module.exports = {
  s3,
  WASABI_BUCKET,
  WASABI_REGION,
  WASABI_ENDPOINT,
  ensureBucket
};
