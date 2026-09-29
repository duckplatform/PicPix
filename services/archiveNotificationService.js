'use strict';

/**
 * Notifie par email les invites ayant demande l'archive d'un evenement, une fois
 * celle-ci prete. N'envoie rien si l'envoi n'est pas active en base (reglage
 * admin), si aucun serveur SMTP n'est configure ou si APP_BASE_URL manque (le
 * lien serait relatif, donc inutilisable depuis un client mail).
 */

const logger = require('../config/logger');
const eventArchiveRequestStore = require('./eventArchiveRequestStore');
const settingsStore = require('./settingsStore');
const mailService = require('./mailService');

function getBaseUrl() {
  return (process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
}

/** True si APP_BASE_URL est une URL absolue http(s). */
function isBaseUrlConfigured() {
  return /^https?:\/\/[^/]+/i.test(getBaseUrl());
}

function buildDownloadUrl(eventItem) {
  return `${getBaseUrl()}/event/${eventItem.token}/archive`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {object} eventItem
 * @param {{ emails?: string[] }} [options] restreint l'envoi a ces adresses
 *   (inscription survenue apres la generation de l'archive).
 */
async function notifyArchiveRequesters(eventItem, { emails } = {}) {
  const mailEnabled = await settingsStore.getBoolSetting('mail_archive_notifications_enabled', false);
  if (!mailEnabled) {
    logger.info(`[ARCHIVE-MAIL] Notifications desactivees, aucun mail envoye pour ${eventItem.uuid}.`);
    return;
  }

  if (!mailService.isEnvConfigured()) {
    logger.warn(`[ARCHIVE-MAIL] Notifications activees mais SMTP non configure, aucun mail envoye pour ${eventItem.uuid}.`);
    return;
  }

  if (!isBaseUrlConfigured()) {
    logger.warn(`[ARCHIVE-MAIL] Notifications activees mais APP_BASE_URL absent ou invalide, aucun mail envoye pour ${eventItem.uuid}.`);
    return;
  }

  const recipients = emails
    ? emails.map((email) => ({ email }))
    : await eventArchiveRequestStore.listByEvent(eventItem.id);
  if (recipients.length === 0) {
    return;
  }

  const downloadUrl = buildDownloadUrl(eventItem);
  const safeEventName = escapeHtml(eventItem.name);
  const safeDownloadUrl = escapeHtml(downloadUrl);
  const subject = `L'archive photos de "${eventItem.name}" est disponible`;
  const text = `Bonjour,\n\nL'archive complète des photos de l'événement "${eventItem.name}" est disponible au téléchargement :\n${downloadUrl}\n\nCeci est un message automatique.`;
  const html = `<p>Bonjour,</p><p>L'archive complète des photos de l'événement <strong>${safeEventName}</strong> est disponible au téléchargement :</p><p><a href="${safeDownloadUrl}">${safeDownloadUrl}</a></p><p>Ceci est un message automatique.</p>`;

  const results = await Promise.allSettled(
    recipients.map((requestItem) => mailService.sendMail({
      to: requestItem.email,
      subject,
      text,
      html,
    })),
  );

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      const reason = result.reason && result.reason.message ? result.reason.message : String(result.reason);
      logger.error(`[ARCHIVE-MAIL] Echec envoi a ${recipients[index].email} pour ${eventItem.uuid}: ${reason}`);
    }
  });
}

module.exports = {
  isBaseUrlConfigured,
  notifyArchiveRequesters,
};
