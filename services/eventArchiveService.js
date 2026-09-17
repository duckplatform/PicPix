'use strict';

/**
 * Generation asynchrone de l'archive ZIP des photos d'un evenement clos.
 *
 * Meme principe que imageVariantService : une file d'attente en memoire
 * drainee sequentiellement, pour ne jamais bloquer la requete HTTP de cloture
 * ni saturer le disque avec plusieurs archives simultanees.
 *
 * L'etat de progression est persiste dans events.archive_status
 * ('pending' -> 'ready' | 'failed'), ce qui permet au dashboard d'afficher un
 * message d'attente tant que le lien de telechargement n'est pas disponible.
 */

const archiver = require('archiver');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

const logger = require('../config/logger');
const eventStore = require('./eventStore');
const eventFileStore = require('./eventFileStore');
const archiveNotificationService = require('./archiveNotificationService');

const queue = [];
let isProcessing = false;

/** Nom de fichier ZIP stable et devinable uniquement par l'uuid de l'evenement. */
function archiveFileName(eventUuid) {
  return `picpix-${eventUuid}.zip`;
}

function getArchivePath(eventUuid) {
  return path.join(eventStore.getEventArchiveStoragePath(eventUuid), archiveFileName(eventUuid));
}

/**
 * Nom lisible propose au telechargement, derive du nom de l'evenement.
 * On reste volontairement en ASCII pour eviter les entetes Content-Disposition
 * mal interpretees par certains navigateurs.
 */
function buildDownloadFileName(eventItem) {
  const slug = String(eventItem.name || 'evenement')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60) || 'evenement';

  return `photos-${slug}.zip`;
}

/**
 * Nom d'entree unique dans le ZIP.
 * Les visiteurs uploadent souvent des fichiers homonymes (IMG_0001.jpg) : on
 * prefixe par un index pour ne perdre aucune photo dans l'archive.
 */
function buildEntryName(fileItem, index, usedNames) {
  const rawName = path.basename(fileItem.originalName || fileItem.storedName)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .slice(0, 120) || fileItem.storedName;

  const paddedIndex = String(index + 1).padStart(4, '0');
  let entryName = `${paddedIndex}-${rawName}`;

  let suffix = 1;
  while (usedNames.has(entryName.toLowerCase())) {
    const parsed = path.parse(entryName);
    entryName = `${parsed.name}-${suffix}${parsed.ext}`;
    suffix += 1;
  }

  usedNames.add(entryName.toLowerCase());
  return entryName;
}

/**
 * Ecrit le ZIP des originaux approuves dans <storage>/<uuid>/archive/.
 * @returns {Promise<{sizeBytes: number, photoCount: number}>}
 */
async function writeArchive(eventItem, files) {
  const archiveDir = eventStore.getEventArchiveStoragePath(eventItem.uuid);
  await fs.mkdir(archiveDir, { recursive: true });

  const finalPath = getArchivePath(eventItem.uuid);
  // On ecrit d'abord dans un fichier temporaire : tant que le rename n'a pas eu
  // lieu, aucune archive partielle ne peut etre servie en telechargement.
  const tempPath = `${finalPath}.part`;

  await fs.rm(tempPath, { force: true });

  const usedNames = new Set();
  let photoCount = 0;

  await new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(tempPath);
    const archive = archiver('zip', { zlib: { level: 1 } });

    let settled = false;
    const fail = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      archive.abort();
      reject(err);
    };

    output.on('close', () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    });

    output.on('error', fail);
    archive.on('error', fail);
    // ENOENT sur une photo isolee ne doit pas faire echouer toute l'archive.
    archive.on('warning', (warning) => {
      if (warning.code === 'ENOENT') {
        logger.warn(`[ARCHIVE] Fichier ignore pour ${eventItem.uuid}: ${warning.message}`);
        return;
      }
      fail(warning);
    });

    archive.pipe(output);

    files.forEach((fileItem, index) => {
      const sourcePath = path.join(
        eventStore.getEventOriginalStoragePath(eventItem.uuid),
        fileItem.storedName,
      );

      if (!fsSync.existsSync(sourcePath)) {
        logger.warn(`[ARCHIVE] Original introuvable, ignore: ${sourcePath}`);
        return;
      }

      archive.file(sourcePath, { name: buildEntryName(fileItem, index, usedNames) });
      photoCount += 1;
    });

    void archive.finalize();
  });

  await fs.rename(tempPath, finalPath);
  const stats = await fs.stat(finalPath);

  return { sizeBytes: stats.size, photoCount };
}

async function processOne(eventId) {
  const eventItem = await eventStore.findById(eventId);
  if (!eventItem) {
    logger.warn(`[ARCHIVE] Evenement ${eventId} introuvable, generation annulee.`);
    return;
  }

  try {
    const files = await eventFileStore.listByEventAndStatus(eventItem.id, 'approved');
    // Ordre chronologique : l'archive raconte l'evenement dans l'ordre vecu.
    const orderedFiles = [...files].sort(
      (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
    );

    const { sizeBytes, photoCount } = await writeArchive(eventItem, orderedFiles);

    await eventStore.updateArchiveState(eventItem.id, {
      archiveStatus: 'ready',
      archiveFile: archiveFileName(eventItem.uuid),
      archiveSizeBytes: sizeBytes,
      archivePhotoCount: photoCount,
      archiveError: null,
    });

    logger.info(`[ARCHIVE] Archive prete pour ${eventItem.uuid} (${photoCount} photo(s), ${sizeBytes} octets)`);

    await archiveNotificationService.notifyArchiveRequesters(eventItem).catch((err) => {
      logger.error(`[ARCHIVE] Notification mail echouee pour ${eventItem.uuid}: ${err.message}`);
    });
  } catch (err) {
    await eventStore.updateArchiveState(eventItem.id, {
      archiveStatus: 'failed',
      archiveError: err.message,
    }).catch(() => {});

    logger.error(`[ARCHIVE] Echec generation pour ${eventItem.uuid}: ${err.message}`);
  }
}

async function drainQueue() {
  if (isProcessing) {
    return;
  }

  isProcessing = true;

  try {
    while (queue.length > 0) {
      const eventId = queue.shift();
      await processOne(eventId);
    }
  } finally {
    isProcessing = false;
  }
}

/**
 * Place la generation de l'archive en file d'attente (non bloquant).
 * @param {number} eventId
 */
function enqueueArchiveGeneration(eventId) {
  const numericId = Number(eventId);
  if (!Number.isInteger(numericId) || numericId <= 0 || queue.includes(numericId)) {
    return;
  }

  queue.push(numericId);
  void drainQueue();
}

/**
 * Relance les archives restees `pending` (redemarrage serveur pendant un
 * traitement). Appele une fois au demarrage.
 */
async function resumePendingArchives() {
  const pending = await eventStore.listPendingArchives();
  pending.forEach((eventItem) => enqueueArchiveGeneration(eventItem.id));

  if (pending.length > 0) {
    logger.info(`[ARCHIVE] ${pending.length} archive(s) en attente relancee(s) au demarrage.`);
  }
}

/** True si le ZIP existe reellement sur disque. */
async function archiveExists(eventUuid) {
  try {
    await fs.access(getArchivePath(eventUuid));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  archiveExists,
  archiveFileName,
  buildDownloadFileName,
  enqueueArchiveGeneration,
  getArchivePath,
  resumePendingArchives,
};
