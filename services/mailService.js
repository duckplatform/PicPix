'use strict';

/**
 * Envoi de mail via SMTP.
 * Configuration entierement pilotee par variables d'environnement (definies en
 * cPanel, pas de dotenv), sur le meme principe que config/database.js.
 */

const nodemailer = require('nodemailer');

const logger = require('../config/logger');

let transporter = null;

function isEnvConfigured() {
  return Boolean(process.env.SMTP_HOST);
}

function getTransporter() {
  if (transporter) {
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });

  return transporter;
}

/**
 * Envoie un mail. Ne doit jamais etre appele sans verifier isEnvConfigured() au
 * prealable : un echec d'envoi ne doit jamais faire echouer l'appelant (generation
 * d'archive notamment), c'est a l'appelant de catcher.
 */
async function sendMail({ to, subject, text, html }) {
  const from = process.env.SMTP_FROM || 'PicPix <no-reply@picpix.local>';

  await getTransporter().sendMail({ from, to, subject, text, html });
  logger.info(`[MAIL] Envoye a ${to}: ${subject}`);
}

module.exports = {
  isEnvConfigured,
  sendMail,
};
