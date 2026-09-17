'use strict';

/**
 * Notifie par email les invites ayant demande l'archive d'un evenement, une fois
 * celle-ci prete. N'envoie rien si l'envoi n'est pas active en base (reglage
 * admin) ou si aucun serveur SMTP n'est configure.
 */

const logger = require('../config/logger');
const eventArchiveRequestStore = require('./eventArchiveRequestStore');
const settingsStore = require('./settingsStore');
const mailService = require('./mailService');

function buildDownloadUrl(eventItem) {
  const baseUrl = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  return `${baseUrl}/event/${eventItem.token}/archive`;
}

async function notifyArchiveRequesters(eventItem) {
  const mailEnabled = await settingsStore.getBoolSetting('mail_archive_notifications_enabled', false);
  if (!mailEnabled) {
    logger.info(`[ARCHIVE-MAIL] Notifications desactivees, aucun mail envoye pour ${eventItem.uuid}.`);
    return;
  }

  if (!mailService.isEnvConfigured()) {
    logger.warn(`[ARCHIVE-MAIL] Notifications activees mais SMTP non configure, aucun mail envoye pour ${eventItem.uuid}.`);
    return;
  }

  const requests = await eventArchiveRequestStore.listByEvent(eventItem.id);
  if (requests.length === 0) {
    return;
  }

  const downloadUrl = buildDownloadUrl(eventItem);
  const subject = `L'archive photos de "${eventItem.name}" est disponible`;
  const text = `Bonjour,\n\nL'archive complete des photos de l'evenement "${eventItem.name}" est disponible au telechargement :\n${downloadUrl}\n\nCeci est un message automatique.`;
  const html = `<p>Bonjour,</p><p>L'archive complete des photos de l'evenement <strong>${eventItem.name}</strong> est disponible au telechargement :</p><p><a href="${downloadUrl}">${downloadUrl}</a></p><p>Ceci est un message automatique.</p>`;

  const results = await Promise.allSettled(
    requests.map((requestItem) => mailService.sendMail({
      to: requestItem.email,
      subject,
      text,
      html,
    })),
  );

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.error(`[ARCHIVE-MAIL] Echec envoi a ${requests[index].email} pour ${eventItem.uuid}: ${result.reason.message}`);
    }
  });
}

module.exports = {
  notifyArchiveRequesters,
};
