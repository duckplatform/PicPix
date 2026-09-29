'use strict';

const logger = require('../config/logger');
const userStore = require('../services/userStore');

async function attachCurrentUser(req, res) {
  const userId = req.session && req.session.userId;
  if (!userId) {
    req.currentUser = null;
    res.locals.user = null;
    return;
  }

  try {
    const currentUser = await userStore.findPublicById(userId);
    if (!currentUser || currentUser.status !== 'active') {
      req.currentUser = null;
      res.locals.user = null;
      if (req.session) {
        req.session.userId = null;
      }
      return;
    }

    req.currentUser = currentUser;
    res.locals.user = currentUser;
  } catch (err) {
    req.currentUser = null;
    res.locals.user = null;
    logger.error(`[AUTH] Impossible de charger l'utilisateur courant: ${err.message}`);
  }
}

function injectLocals(req, res, next) {
  res.locals.user = null;
  res.locals.messages = {
    success: req.flash('success'),
    error: req.flash('error'),
  };
  res.locals.csrfToken = typeof req.csrfToken === 'function' ? req.csrfToken() : '';

  void attachCurrentUser(req, res)
    .then(() => next())
    .catch(next);
}

function requireAuth(req, res, next) {
  if (!req.currentUser) {
    req.flash('error', 'Veuillez vous connecter pour accéder à cette page.');
    return res.redirect('/login');
  }

  return next();
}

function requireAdmin(req, res, next) {
  if (!req.currentUser) {
    req.flash('error', 'Veuillez vous connecter pour accéder à cette page.');
    return res.redirect('/login');
  }

  if (req.currentUser.role !== 'admin') {
    req.flash('error', 'Accès réservé aux administrateurs.');
    return res.status(403).render('errors/500', {
      title: 'Accès refusé',
      pageClass: 'page-error',
      statusCode: 403,
      message: 'Vous ne disposez pas des droits nécessaires pour accéder à cette page.',
    });
  }

  return next();
}

module.exports = { injectLocals, requireAuth, requireAdmin };
