'use strict';

const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

const logger = require('../config/logger');
const eventStore = require('./eventStore');

const VARIANT_SPECS = {
  xl: { width: 1600, quality: 84 },
  md: { width: 1024, quality: 82 },
  sm: { width: 640, quality: 78 },
};

/**
 * Extensions d'image raster acceptees a l'upload, par type MIME.
 * Les originaux sont servis avec un Content-Type deduit de l'extension : une
 * extension libre (.html, .svg...) permettrait d'executer du script sur
 * l'origine de l'application. SVG est volontairement exclu (scriptable).
 */
const IMAGE_EXTENSION_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/pjpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
};

const ALLOWED_IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.jfif', '.png', '.gif', '.webp', '.avif', '.heic', '.heif', '.bmp', '.tif', '.tiff',
]);

/** Nom de fichier stocke : uuid + extension image autorisee. */
const STORED_NAME_PATTERN = /^[0-9a-f-]{36}\.(jpe?g|jfif|png|gif|webp|avif|heic|heif|bmp|tiff?)$/i;

const queue = [];
let isProcessing = false;

function sanitizeStoredName(storedName) {
  return STORED_NAME_PATTERN.test(storedName || '');
}

/**
 * Extension a utiliser pour stocker un upload, ou null si le fichier n'est
 * pas une image raster acceptee.
 */
function resolveImageExtension(originalName, mimeType) {
  const nameExtension = path.extname(originalName || '').toLowerCase();
  if (ALLOWED_IMAGE_EXTENSIONS.has(nameExtension)) {
    return nameExtension;
  }

  return IMAGE_EXTENSION_BY_MIME[String(mimeType || '').toLowerCase()] || null;
}

function getVariantFileName(storedName, variantKey) {
  const ext = path.extname(storedName);
  const base = path.basename(storedName, ext);
  return `${base}-${variantKey}.jpg`;
}

function getOriginalPath(eventUuid, storedName) {
  return path.join(eventStore.getEventOriginalStoragePath(eventUuid), storedName);
}

function getVariantPath(eventUuid, storedName, variantKey) {
  return path.join(eventStore.getEventDerivedStoragePath(eventUuid), getVariantFileName(storedName, variantKey));
}

async function processOne(job) {
  const { eventUuid, storedName } = job;

  if (!sanitizeStoredName(storedName)) {
    logger.warn(`[IMG] Nom de fichier invalide ignore: ${storedName}`);
    return;
  }

  const inputPath = getOriginalPath(eventUuid, storedName);

  try {
    await fs.access(inputPath);
  } catch {
    logger.warn(`[IMG] Fichier original introuvable: ${inputPath}`);
    return;
  }

  try {
    await fs.mkdir(eventStore.getEventDerivedStoragePath(eventUuid), { recursive: true });

    const baseImage = sharp(inputPath, { failOn: 'none' }).rotate();

    await Promise.all(
      Object.entries(VARIANT_SPECS).map(async ([variantKey, spec]) => {
        const outputPath = getVariantPath(eventUuid, storedName, variantKey);

        await baseImage
          .clone()
          .resize({ width: spec.width, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: spec.quality, mozjpeg: true })
          .toFile(outputPath);
      }),
    );

    logger.info(`[IMG] Variantes generees pour ${eventUuid}/${storedName}`);
  } catch (err) {
    // Les uploads ne doivent jamais echouer a cause du post-processing.
    logger.warn(`[IMG] Echec generation variantes pour ${eventUuid}/${storedName}: ${err.message}`);
  }
}

async function drainQueue() {
  if (isProcessing) {
    return;
  }

  isProcessing = true;

  try {
    while (queue.length > 0) {
      const job = queue.shift();
      // eslint-disable-next-line no-await-in-loop
      await processOne(job);
    }
  } finally {
    isProcessing = false;
  }
}

function enqueueVariantGeneration(eventUuid, storedName) {
  queue.push({ eventUuid, storedName });
  setImmediate(() => {
    void drainQueue();
  });
}

async function variantExists(eventUuid, storedName, variantKey) {
  try {
    await fs.access(getVariantPath(eventUuid, storedName, variantKey));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  STORED_NAME_PATTERN,
  VARIANT_SPECS,
  enqueueVariantGeneration,
  getOriginalPath,
  getVariantFileName,
  getVariantPath,
  resolveImageExtension,
  sanitizeStoredName,
  variantExists,
};
