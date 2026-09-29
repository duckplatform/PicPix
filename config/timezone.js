'use strict';

/**
 * Fuseau horaire "metier" de l'application.
 *
 * Les formulaires envoient une heure murale (<input type="datetime-local">,
 * sans decalage) exprimee dans le fuseau de l'organisateur, alors que la base
 * stocke en UTC (pool mysql2 en `timezone: 'Z'`). Sans conversion, 20:00 a
 * Paris serait stocke comme 20:00 UTC, soit 22:00 heure de Paris.
 *
 * APP_TIMEZONE (IANA, ex. "Europe/Paris") definit ce fuseau.
 */

const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Europe/Paris';

const NAIVE_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function getZonedParts(date) {
  return partsFormatter.formatToParts(date).reduce((accumulator, part) => {
    if (part.type !== 'literal') {
      accumulator[part.type] = Number(part.value);
    }
    return accumulator;
  }, {});
}

/** Decalage (ms) du fuseau applicatif par rapport a UTC a l'instant donne. */
function getOffsetMs(timestamp) {
  const parts = getZonedParts(new Date(timestamp));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - (timestamp - (timestamp % 1000));
}

/**
 * Convertit une date saisie en Date UTC.
 * - Heure murale sans decalage ("2026-09-29T20:00") : interpretee dans APP_TIMEZONE.
 * - Chaine avec decalage/Z ou Date : conservee telle quelle.
 * @returns {Date|null}
 */
function parseAppDateTime(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const raw = String(value || '').trim();
  const match = NAIVE_DATETIME_PATTERN.exec(raw);

  if (!match) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const [, year, month, day, hour, minute, second = '0'] = match;
  const wallClockAsUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));

  // Deux passes pour tomber juste autour des changements d'heure.
  let timestamp = wallClockAsUtc - getOffsetMs(wallClockAsUtc);
  timestamp = wallClockAsUtc - getOffsetMs(timestamp);

  return new Date(timestamp);
}

/** Valeur pour un <input type="datetime-local"> (heure murale APP_TIMEZONE). */
function toDateTimeLocal(value) {
  if (!value) {
    return '';
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const parts = getZonedParts(date);
  const pad = (number) => String(number).padStart(2, '0');

  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** Affichage lisible fr-FR dans le fuseau applicatif (independant du fuseau serveur). */
function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleString('fr-FR', { timeZone: APP_TIMEZONE });
}

module.exports = {
  APP_TIMEZONE,
  formatDateTime,
  parseAppDateTime,
  toDateTimeLocal,
};
