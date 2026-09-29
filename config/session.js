'use strict';

/**
 * Configuration des sessions.
 *
 * - Secret obligatoire en production : un secret par defaut (public, present
 *   dans le depot) permettrait de forger des cookies `sid`.
 * - Store MySQL en dehors des tests : le MemoryStore d'express-session fuit en
 *   memoire, perd les sessions a chaque redemarrage et n'est pas partage entre
 *   les processus Passenger (deconnexions et erreurs CSRF aleatoires).
 */

const session = require('express-session');

const { pool } = require('./database');
const logger = require('./logger');

const ENV = process.env.NODE_ENV || 'development';
const DEV_FALLBACK_SECRET = 'dev-only-session-secret-not-for-production';
const EXPIRED_SESSIONS_CLEANUP_MS = 15 * 60 * 1000;

function resolveSessionSecret() {
  if (process.env.SESSION_SECRET) {
    return process.env.SESSION_SECRET;
  }

  if (ENV === 'production') {
    throw new Error('SESSION_SECRET doit etre defini en production.');
  }

  return DEV_FALLBACK_SECRET;
}

const SESSION_SECRET = resolveSessionSecret();

/**
 * Store express-session adosse a la table `sessions` (cf. database/install.sql).
 * Reutilise le pool applicatif plutot que d'ouvrir une connexion dediee.
 */
class MySqlSessionStore extends session.Store {
  constructor({ defaultTtlMs }) {
    super();
    this.defaultTtlMs = defaultTtlMs;

    const timer = setInterval(() => {
      void this.clearExpired().catch((err) => {
        logger.warn(`[SESSION] Purge des sessions expirees impossible : ${err.message}`);
      });
    }, EXPIRED_SESSIONS_CLEANUP_MS);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  expiresAt(sess) {
    const cookieExpires = sess && sess.cookie && sess.cookie.expires;
    if (cookieExpires) {
      return new Date(cookieExpires);
    }

    return new Date(Date.now() + this.defaultTtlMs);
  }

  get(sid, callback) {
    pool.query('SELECT data FROM sessions WHERE session_id = ? AND expires_at > UTC_TIMESTAMP() LIMIT 1', [sid])
      .then(([rows]) => {
        if (rows.length === 0) {
          callback(null, null);
          return;
        }

        callback(null, JSON.parse(rows[0].data));
      })
      .catch((err) => callback(err));
  }

  set(sid, sess, callback = () => {}) {
    pool.query(`
      INSERT INTO sessions (session_id, expires_at, data)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE expires_at = VALUES(expires_at), data = VALUES(data)
    `, [sid, this.expiresAt(sess), JSON.stringify(sess)])
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  touch(sid, sess, callback = () => {}) {
    pool.query('UPDATE sessions SET expires_at = ? WHERE session_id = ?', [this.expiresAt(sess), sid])
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  destroy(sid, callback = () => {}) {
    pool.query('DELETE FROM sessions WHERE session_id = ?', [sid])
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  async clearExpired() {
    await pool.query('DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP()');
  }
}

function createSessionStore(defaultTtlMs) {
  if (ENV === 'test') {
    // Les tests tournent sans MySQL : MemoryStore par defaut.
    return undefined;
  }

  return new MySqlSessionStore({ defaultTtlMs });
}

module.exports = {
  SESSION_SECRET,
  createSessionStore,
};
