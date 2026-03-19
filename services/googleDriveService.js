// ============================================================================
// GOOGLE DRIVE SERVICE - Interaccion con Google Drive API v3
// Sistema PRUEBA DIGITAL
// ============================================================================

const { google } = require('googleapis');
const path = require('path');
const { MAX_FILE_SIZE, BLOCKED_EXTENSIONS } = require('../config/storage');

// MIME types nativos de Google (no son archivos binarios, no se pueden descargar directamente)
const GOOGLE_NATIVE_MIMETYPES = [
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.form',
  'application/vnd.google-apps.drawing',
  'application/vnd.google-apps.site',
  'application/vnd.google-apps.script',
  'application/vnd.google-apps.folder',
  'application/vnd.google-apps.shortcut'
];

class GoogleDriveService {
  /**
   * Crea un cliente Drive autenticado con el access_token del usuario
   * @param {string} accessToken - OAuth2 access token del usuario
   * @returns {import('googleapis').drive_v3.Drive}
   */
  _createDriveClient(accessToken) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    return google.drive({ version: 'v3', auth });
  }

  /**
   * Obtiene metadatos ricos de un archivo en Google Drive
   * @param {string} accessToken - OAuth2 access token
   * @param {string} fileId - ID del archivo en Drive
   * @returns {Promise<Object>} Metadatos del archivo
   */
  async getFileMetadata(accessToken, fileId) {
    const drive = this._createDriveClient(accessToken);

    const response = await drive.files.get({
      fileId,
      fields: 'id,name,mimeType,size,createdTime,modifiedTime,originalFilename,owners,md5Checksum,sha256Checksum',
      supportsAllDrives: true
    });

    const file = response.data;

    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.size ? parseInt(file.size) : 0,
      createdTime: file.createdTime || null,
      modifiedTime: file.modifiedTime || null,
      originalFilename: file.originalFilename || file.name,
      ownerEmail: file.owners?.[0]?.emailAddress || null,
      ownerName: file.owners?.[0]?.displayName || null,
      md5Checksum: file.md5Checksum || null,
      sha256Checksum: file.sha256Checksum || null
    };
  }

  /**
   * Descarga un archivo de Google Drive como stream
   * @param {string} accessToken - OAuth2 access token
   * @param {string} fileId - ID del archivo en Drive
   * @returns {Promise<ReadableStream>} Stream del contenido del archivo
   */
  async downloadFileStream(accessToken, fileId) {
    const drive = this._createDriveClient(accessToken);

    const response = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );

    return response.data;
  }

  /**
   * Valida que un archivo sea importable
   * @param {Object} metadata - Metadatos del archivo (de getFileMetadata)
   * @returns {{ valid: boolean, error?: string }}
   */
  validateFile(metadata) {
    // No permitir archivos nativos de Google
    if (GOOGLE_NATIVE_MIMETYPES.includes(metadata.mimeType)) {
      return {
        valid: false,
        error: `No se pueden importar archivos nativos de Google (${metadata.mimeType}). Solo se aceptan archivos binarios (PDF, imagenes, documentos Office, etc.)`
      };
    }

    // Verificar tamano
    if (metadata.sizeBytes > MAX_FILE_SIZE) {
      const maxGB = MAX_FILE_SIZE / (1024 * 1024 * 1024);
      return {
        valid: false,
        error: `El archivo excede el tamano maximo permitido de ${maxGB}GB`
      };
    }

    // Verificar extension bloqueada
    const filename = metadata.originalFilename || metadata.name;
    const ext = path.extname(filename).toLowerCase();
    if (BLOCKED_EXTENSIONS.includes(ext)) {
      return {
        valid: false,
        error: `Extension de archivo bloqueada: ${ext}`
      };
    }

    // Verificar que tenga tamano (no vacio)
    if (metadata.sizeBytes === 0) {
      return {
        valid: false,
        error: 'El archivo esta vacio (0 bytes)'
      };
    }

    return { valid: true };
  }
}

module.exports = new GoogleDriveService();
