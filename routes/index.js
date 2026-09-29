'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs/promises');
const multer = require('multer');
const path = require('path');
const rateLimit = require('express-rate-limit');
const sanitizeHtml = require('sanitize-html');
const { marked } = require('marked');
const { body, param, validationResult } = require('express-validator');

const logger = require('../config/logger');
const eventTransitions = require('../config/eventTransitions');
const eventThemes = require('../config/eventThemes');
const { SESSION_SECRET } = require('../config/session');
const { toDateTimeLocal } = require('../config/timezone');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const archiveNotificationService = require('../services/archiveNotificationService');
const eventArchiveService = require('../services/eventArchiveService');
const eventArchiveRequestStore = require('../services/eventArchiveRequestStore');
const eventFileStore = require('../services/eventFileStore');
const imageVariantService = require('../services/imageVariantService');
const mailService = require('../services/mailService');
const settingsStore = require('../services/settingsStore');
const userStore = require('../services/userStore');
const eventStore = require('../services/eventStore');

const router = express.Router();
const MAX_EVENT_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;
const EVENT_UPLOAD_SOURCE_MODES = ['default', 'camera_only', 'library_only'];
const EVENT_THEME_KEYS = Object.keys(eventThemes.EVENT_THEMES);
const EVENT_TRANSITION_KEYS = Object.keys(eventTransitions.EVENT_TRANSITIONS);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 10 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Trop de tentatives, veuillez réessayer plus tard.',
});

const EVENT_DESCRIPTION_RENDER_POLICY = {
  allowedTags: ['p', 'br', 'strong', 'em', 'u', 'ul', 'ol', 'li', 'a', 'blockquote', 'h1', 'h2', 'h3', 'code', 'pre'],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  disallowedTagsMode: 'discard',
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', {
      target: '_blank',
      rel: 'noopener noreferrer nofollow',
    }),
  },
};

function stripHtmlToText(value) {
  return sanitizeHtml(value || '', {
    allowedTags: [],
    allowedAttributes: {},
  }).replace(/\s+/g, ' ').trim();
}

function normalizeEventDescriptionMarkdown(value) {
  return sanitizeHtml(value || '', {
    allowedTags: [],
    allowedAttributes: {},
  }).trim();
}

function renderEventDescriptionMarkdown(value) {
  const markdownValue = value || '';
  const html = marked.parse(markdownValue, {
    breaks: true,
    gfm: true,
  });

  return sanitizeHtml(html, EVENT_DESCRIPTION_RENDER_POLICY).trim();
}

function renderView(res, view, payload = {}, status = 200) {
  return res.status(status).render(view, {
    title: 'PicPix',
    pageClass: '',
    formData: {},
    fieldErrors: {},
    headCssPaths: [],
    footerScriptPaths: [],
    eventThemeOptions: eventThemes.listThemes(),
    eventTransitionOptions: eventTransitions.listTransitions(),
    ...payload,
  });
}

function collectFieldErrors(result) {
  return result.array().reduce((accumulator, error) => {
    if (!accumulator[error.path]) {
      accumulator[error.path] = error.msg;
    }
    return accumulator;
  }, {});
}

function ensureGuest(req, res, next) {
  if (req.currentUser) {
    return res.redirect('/profile');
  }

  return next();
}

function eventGuestCookieName(token) {
  return `event_guest_${token}`;
}

function getCookieValue(req, cookieName) {
  const rawCookieHeader = req.headers.cookie || '';
  if (!rawCookieHeader) {
    return null;
  }

  const parts = rawCookieHeader.split(';');
  for (const part of parts) {
    const [name, ...valueParts] = part.trim().split('=');
    if (name !== cookieName) {
      continue;
    }

    return decodeURIComponent(valueParts.join('='));
  }

  return null;
}

function getEventGuestName(req, token) {
  const value = getCookieValue(req, eventGuestCookieName(token));
  return value ? value.trim() : '';
}

function eventArchiveRequestCookieName(token) {
  return `event_archive_request_${token}`;
}

function signCookieValue(value) {
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
  return `${value}.${signature}`;
}

/** Valeur d'origine si la signature HMAC est valide, sinon null. */
function unsignCookieValue(signedValue) {
  const separatorIndex = signedValue.lastIndexOf('.');
  if (separatorIndex <= 0) {
    return null;
  }

  const value = signedValue.slice(0, separatorIndex);
  const expected = Buffer.from(signCookieValue(value));
  const actual = Buffer.from(signedValue);

  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual) ? value : null;
}

/**
 * Email de la demande d'archive de ce navigateur.
 * Le cookie est signe : il sert a retrouver (et supprimer) la demande en base,
 * un invite ne doit donc pas pouvoir y placer l'adresse de quelqu'un d'autre.
 */
function getEventArchiveRequestEmail(req, token) {
  const value = getCookieValue(req, eventArchiveRequestCookieName(token));
  const email = value ? unsignCookieValue(value.trim()) : null;
  return email || '';
}

function buildEventSiteNav(token, guestName, eventName, themeKey, isClosed = false) {
  return {
    token,
    guestName: (guestName || 'Visiteur').trim().slice(0, 120),
    eventName: (eventName || 'Evenement').trim().slice(0, 120),
    eventTheme: eventThemes.getTheme(themeKey),
    eventUrl: `/event/${token}`,
    galleryUrl: `/event/${token}/gallery`,
    // Evenement cloture : le lien d'upload disparait de la navigation.
    uploadUrl: isClosed ? null : `/event/${token}/upload`,
  };
}

function buildEventPageClass(themeKey) {
  return `page-event event-theme-${eventThemes.normalizeThemeKey(themeKey)}`;
}

function parseUploadAllowMultiple(value) {
  return value === true || value === 'true' || value === '1' || value === 'on';
}

function parseModerationEnabled(value) {
  return value === true || value === 'true' || value === '1' || value === 'on';
}

function isFileApprovedForDisplay(fileItem) {
  return Boolean(fileItem) && fileItem.moderationStatus === 'approved';
}

function buildOwnerPhotoRealtimePayload(eventItem, fileItem) {
  return {
    eventId: eventItem.id,
    fileId: fileItem.id,
    storedName: fileItem.storedName,
    originalName: fileItem.originalName,
    uploaderName: fileItem.uploaderName,
    uploadedAt: fileItem.createdAt,
    moderationStatus: fileItem.moderationStatus,
    urls: {
      original: `/profile/events/${eventItem.id}/photos/${fileItem.storedName}/original`,
      md: `/profile/events/${eventItem.id}/photos/${fileItem.storedName}/md`,
      sm: `/profile/events/${eventItem.id}/photos/${fileItem.storedName}/sm`,
    },
  };
}

async function autoApprovePendingFilesIfModerationDisabled(previousEvent, nextModerationEnabled, app) {
  if (!previousEvent || !previousEvent.moderationEnabled || nextModerationEnabled) {
    return 0;
  }

  const approvedFiles = await eventFileStore.approvePendingByEvent(previousEvent.id);
  if (approvedFiles.length === 0) {
    return 0;
  }

  const io = app && app.locals ? app.locals.io : null;
  if (io) {
    approvedFiles.forEach((fileItem) => {
      io.to(`event:${previousEvent.id}:slideshow`).emit('slideshow:new-photo', {
        eventId: previousEvent.id,
        storedName: fileItem.storedName,
        originalName: fileItem.originalName,
        uploaderName: fileItem.uploaderName,
        uploadedAt: fileItem.createdAt,
      });

      io.to(`event:${previousEvent.id}:moderation`).emit('moderation:photo-reviewed', {
        eventId: previousEvent.id,
        fileId: fileItem.id,
        storedName: fileItem.storedName,
        moderationStatus: fileItem.moderationStatus,
      });
    });
  }

  return approvedFiles.length;
}

function normalizeEventFormData(formData = {}, fallback = {}) {
  const uploadSourceMode = EVENT_UPLOAD_SOURCE_MODES.includes(formData.uploadSourceMode)
    ? formData.uploadSourceMode
    : (fallback.uploadSourceMode || 'default');

  const uploadAllowMultiple = formData.uploadAllowMultiple !== undefined
    ? parseUploadAllowMultiple(formData.uploadAllowMultiple)
    : (fallback.uploadAllowMultiple !== undefined ? Boolean(fallback.uploadAllowMultiple) : true);

  const moderationEnabled = formData.moderationEnabled !== undefined
    ? parseModerationEnabled(formData.moderationEnabled)
    : (fallback.moderationEnabled !== undefined ? Boolean(fallback.moderationEnabled) : false);

  return {
    ...formData,
    theme: eventThemes.normalizeThemeKey(formData.theme || fallback.theme),
    slideshowTransition: eventTransitions.normalizeTransitionKey(
      formData.slideshowTransition || fallback.slideshowTransition,
    ),
    uploadSourceMode,
    uploadAllowMultiple,
    moderationEnabled,
  };
}

async function computeFileChecksum(filePath) {
  const fileBuffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

async function loadEventByTokenOr404(req, res) {
  const eventItem = await eventStore.findByToken(req.params.token);
  if (!eventItem) {
    res.status(404).render('errors/404', {
      title: 'Événement introuvable',
      pageClass: 'page-error',
    });
    return null;
  }

  return eventItem;
}

function createEventUploadMiddleware(maxFiles = 10) {
  const storage = multer.diskStorage({
    async destination(req, file, callback) {
      try {
        const dir = eventStore.getEventOriginalStoragePath(req.eventItem.uuid);
        await fs.mkdir(dir, { recursive: true });
        callback(null, dir);
      } catch (err) {
        callback(err);
      }
    },
    filename(req, file, callback) {
      // fileFilter garantit qu'une extension d'image autorisee existe.
      const extension = imageVariantService.resolveImageExtension(file.originalname, file.mimetype);
      callback(null, `${crypto.randomUUID()}${extension}`);
    },
  });

  return multer({
    storage,
    limits: {
      fileSize: MAX_EVENT_UPLOAD_SIZE_BYTES,
      files: maxFiles,
    },
    fileFilter(req, file, callback) {
      // Le type MIME est declare par le client : on exige en plus une
      // extension d'image raster, car c'est elle qui determine le
      // Content-Type au moment de servir le fichier.
      if (!file.mimetype || !file.mimetype.startsWith('image/')
        || !imageVariantService.resolveImageExtension(file.originalname, file.mimetype)) {
        callback(new Error('INVALID_FILE_TYPE'));
        return;
      }

      callback(null, true);
    },
  }).fields([
    { name: 'photos', maxCount: maxFiles },
    ...Array.from({ length: maxFiles }, (_, index) => ({
      name: `photos[${index}]`,
      maxCount: 1,
    })),
  ]);
}

function passwordRules(fieldName = 'password', required = true) {
  const chain = body(fieldName)
    .trim()
    .isLength({ min: 8, max: 72 }).withMessage('Le mot de passe doit contenir entre 8 et 72 caractères.')
    .matches(/[a-z]/).withMessage('Le mot de passe doit contenir au moins une minuscule.')
    .matches(/[A-Z]/).withMessage('Le mot de passe doit contenir au moins une majuscule.')
    .matches(/[0-9]/).withMessage('Le mot de passe doit contenir au moins un chiffre.');

  return required ? chain : chain.optional({ values: 'falsy' });
}

const registrationValidators = [
  body('fullName')
    .trim()
    .isLength({ min: 2, max: 120 }).withMessage('Le nom complet doit contenir entre 2 et 120 caractères.'),
  body('email')
    .trim()
    .isEmail().withMessage('Adresse email invalide.')
    .normalizeEmail(),
  passwordRules('password'),
  body('confirmPassword')
    .trim()
    .custom((value, { req }) => value === req.body.password).withMessage('La confirmation du mot de passe est invalide.'),
];

const loginValidators = [
  body('email').trim().isEmail().withMessage('Adresse email invalide.').normalizeEmail(),
  body('password').trim().notEmpty().withMessage('Mot de passe requis.'),
];

const adminUserValidators = [
  body('fullName')
    .trim()
    .isLength({ min: 2, max: 120 }).withMessage('Le nom complet doit contenir entre 2 et 120 caractères.'),
  body('email')
    .trim()
    .isEmail().withMessage('Adresse email invalide.')
    .normalizeEmail(),
  body('role')
    .trim()
    .isIn(['user', 'admin']).withMessage('Rôle invalide.'),
  body('status')
    .trim()
    .isIn(['active', 'disabled']).withMessage('Statut invalide.'),
  passwordRules('password', false),
];

const profileValidators = [
  body('fullName')
    .trim()
    .isLength({ min: 2, max: 120 }).withMessage('Le nom complet doit contenir entre 2 et 120 caractères.'),
  body('currentPassword')
    .trim()
    .custom((value, { req }) => {
      if (req.body.password && !value) {
        throw new Error('Le mot de passe actuel est requis pour modifier votre mot de passe.');
      }
      return true;
    }),
  passwordRules('password', false),
  body('confirmPassword')
    .trim()
    .custom((value, { req }) => {
      if (!req.body.password) {
        return true;
      }
      return value === req.body.password;
    }).withMessage('La confirmation du mot de passe est invalide.'),
];

const eventValidators = [
  body('name')
    .trim()
    .isLength({ min: 3, max: 180 }).withMessage('Le nom de l\'événement doit contenir entre 3 et 180 caractères.'),
  body('description')
    .custom((value) => {
      const plainText = stripHtmlToText(value);
      if (plainText.length < 10 || plainText.length > 5000) {
        throw new Error('La description doit contenir entre 10 et 5000 caracteres utiles.');
      }

      return true;
    }),
  body('startsAt')
    .trim()
    .notEmpty().withMessage('La date et l\'heure de l\'événement sont requises.')
    .isISO8601().withMessage('Format de date/heure invalide.'),
  body('status')
    .trim()
    .isIn(['active', 'inactive']).withMessage('Statut d\'événement invalide.'),
  body('theme')
    .optional({ values: 'falsy' })
    .trim()
    .isIn(EVENT_THEME_KEYS).withMessage('Thème d\'événement invalide.'),
  body('slideshowTransition')
    .optional({ values: 'falsy' })
    .trim()
    .isIn(EVENT_TRANSITION_KEYS).withMessage('Transition du diaporama invalide.'),
  body('uploadSourceMode')
    .optional({ values: 'falsy' })
    .trim()
    .isIn(EVENT_UPLOAD_SOURCE_MODES).withMessage('Source des photos invalide.'),
  body('uploadAllowMultiple')
    .optional({ values: 'falsy' })
    .isIn(['1', 'true', 'on']).withMessage('Option d\'envoi multiple invalide.'),
  body('moderationEnabled')
    .optional({ values: 'falsy' })
    .isIn(['1', 'true', 'on']).withMessage('Option de modération invalide.'),
];

const adminEventValidators = [
  ...eventValidators,
  body('ownerUserId')
    .trim()
    .isInt({ min: 1 }).withMessage('Propriétaire invalide.'),
];

const eventGuestRegistrationValidators = [
  body('guestName')
    .trim()
    .isLength({ min: 2, max: 120 }).withMessage('Le nom doit contenir entre 2 et 120 caractères.'),
];

const eventArchiveRequestValidators = [
  body('wantsArchive')
    .optional({ values: 'falsy' })
    .isIn(['1']).withMessage('Valeur invalide.'),
  body('email')
    .if(body('wantsArchive').equals('1'))
    .trim()
    .isEmail().withMessage('Adresse email invalide.')
    .isLength({ max: 190 }).withMessage('Adresse email trop longue.')
    .normalizeEmail(),
];

async function findOwnedEvent(userId, eventId) {
  const eventItem = await eventStore.findById(eventId);
  if (!eventItem || eventItem.ownerUserId !== Number(userId)) {
    return null;
  }

  return eventItem;
}

async function renderProfile(req, res, payload = {}, status = 200) {
  const events = await eventStore.listByOwner(req.currentUser.id);

  // Le dashboard a besoin du nombre de photos non moderees pour savoir s'il
  // peut proposer la cloture (celle-ci est bloquee tant qu'il en reste).
  // Une seule requete groupee pour tous les evenements non clos.
  const pendingCounts = await eventFileStore.countByEventsAndStatus(
    events.filter((eventItem) => eventItem.status !== 'closed').map((eventItem) => eventItem.id),
    'pending',
  );
  const eventsWithPendingCount = events.map((eventItem) => ({
    ...eventItem,
    pendingModerationCount: pendingCounts.get(eventItem.id) || 0,
  }));

  return renderView(res, 'profile', {
    title: 'Mon profil',
    pageClass: 'page-profile',
    userEvents: eventsWithPendingCount,
    footerScriptPaths: ['/profile-event-close.js'],
    formData: {
      fullName: req.currentUser.fullName,
      eventStatus: 'inactive',
      theme: eventThemes.DEFAULT_EVENT_THEME,
      slideshowTransition: eventTransitions.DEFAULT_EVENT_TRANSITION,
      uploadSourceMode: 'default',
      uploadAllowMultiple: true,
      moderationEnabled: false,
      ...payload.formData,
    },
    ...payload,
  }, status);
}

function renderEventNotFound(res) {
  return res.status(404).render('errors/404', {
    title: 'Événement introuvable',
    pageClass: 'page-error',
  });
}

function isEventClosed(eventItem) {
  return Boolean(eventItem) && eventItem.status === 'closed';
}

/**
 * Refuse une action de modification sur un evenement clos.
 * La cloture est definitive : on ne propose aucune reouverture.
 */
function rejectClosedEvent(req, res, redirectTo = '/profile') {
  req.flash('error', 'Cet événement est clôturé définitivement : il ne peut plus être modifié.');
  return res.redirect(redirectTo);
}

/** Vue publique de l'archive telle qu'exposee au dashboard proprietaire. */
function buildArchiveViewModel(eventItem) {
  return {
    status: eventItem.archiveStatus || 'none',
    photoCount: eventItem.archivePhotoCount,
    sizeBytes: eventItem.archiveSizeBytes,
    generatedAt: eventItem.archiveGeneratedAt,
    downloadUrl: eventItem.archiveStatus === 'ready'
      ? `/profile/events/${eventItem.id}/archive`
      : null,
  };
}

/**
 * Sert le ZIP d'un evenement clos.
 * Le lien n'est valide que si l'archive est marquee `ready` ET presente sur
 * disque : on ne sert jamais une archive partielle.
 */
async function sendEventArchive(req, res, next, eventItem, redirectTo) {
  if (eventItem.archiveStatus !== 'ready' || !(await eventArchiveService.archiveExists(eventItem.uuid))) {
    req.flash('error', eventItem.archiveStatus === 'failed'
      ? 'La génération de l\'archive a échoué. Contactez un administrateur.'
      : 'L\'archive n\'est pas encore prête. Réessayez dans quelques instants.');
    return res.redirect(redirectTo);
  }

  return res.download(
    eventArchiveService.getArchivePath(eventItem.uuid),
    eventArchiveService.buildDownloadFileName(eventItem),
    (sendErr) => {
      if (!sendErr || res.headersSent) {
        return;
      }

      next(sendErr);
    },
  );
}

function renderProfileEventCreateForm(req, res, payload = {}, status = 200) {
  return renderView(res, 'profile-event-create', {
    title: 'Nouvel événement',
    pageClass: 'page-profile',
    formData: {
      status: 'inactive',
      theme: eventThemes.DEFAULT_EVENT_THEME,
      slideshowTransition: eventTransitions.DEFAULT_EVENT_TRANSITION,
      uploadSourceMode: 'default',
      uploadAllowMultiple: true,
      moderationEnabled: false,
      ...payload.formData,
    },
    ...payload,
  }, status);
}

function renderProfileEventForm(req, res, eventItem, payload = {}, status = 200) {
  return renderView(res, 'profile-event-form', {
    title: 'Modifier l\'événement',
    pageClass: 'page-profile',
    editingEvent: eventItem,
    formData: {
      name: eventItem.name,
      description: eventItem.description,
      startsAt: toDateTimeLocal(eventItem.startsAt),
      status: eventItem.status,
      theme: eventItem.theme || eventThemes.DEFAULT_EVENT_THEME,
      slideshowTransition: eventItem.slideshowTransition || eventTransitions.DEFAULT_EVENT_TRANSITION,
      uploadSourceMode: eventItem.uploadSourceMode,
      uploadAllowMultiple: eventItem.uploadAllowMultiple,
      moderationEnabled: eventItem.moderationEnabled,
      ...payload.formData,
    },
    ...payload,
  }, status);
}

async function buildOwnerGalleryFiles(eventItem) {
  const uploadedFiles = await eventFileStore.listByEvent(eventItem.id);

  return Promise.all(uploadedFiles.map(async (fileItem) => {
    const hasXl = await imageVariantService.variantExists(eventItem.uuid, fileItem.storedName, 'xl');
    const hasMd = await imageVariantService.variantExists(eventItem.uuid, fileItem.storedName, 'md');
    const hasSm = await imageVariantService.variantExists(eventItem.uuid, fileItem.storedName, 'sm');

    return {
      ...fileItem,
      isProcessed: hasSm || hasMd || hasXl,
      urls: {
        original: `/profile/events/${eventItem.id}/photos/${fileItem.storedName}/original`,
        xl: hasXl ? `/profile/events/${eventItem.id}/photos/${fileItem.storedName}/xl` : null,
        md: hasMd ? `/profile/events/${eventItem.id}/photos/${fileItem.storedName}/md` : null,
        sm: hasSm ? `/profile/events/${eventItem.id}/photos/${fileItem.storedName}/sm` : null,
      },
    };
  }));
}

router.get('/', (req, res) => {
  res.render('home', {
    title: 'Accueil',
    pageClass: 'page-home',
  });
});

router.get('/event/:token', param('token').trim().matches(/^[A-Za-z0-9]{10}$/), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(404).render('errors/404', {
      title: 'Événement introuvable',
      pageClass: 'page-error',
    });
  }

  try {
    const eventItem = await loadEventByTokenOr404(req, res);
    if (!eventItem) {
      return undefined;
    }

    const guestName = getEventGuestName(req, req.params.token);
    if (!guestName) {
      return res.redirect(`/event/${req.params.token}/register`);
    }

    const now = new Date();
    const startsAtDate = new Date(eventItem.startsAt);
    const hasValidStartDate = !Number.isNaN(startsAtDate.getTime());
    const shouldShowCountdown = eventItem.status !== 'active'
      && hasValidStartDate
      && startsAtDate.getTime() > now.getTime();

    return renderView(res, 'event', {
      title: eventItem.name,
      pageClass: buildEventPageClass(eventItem.theme),
      eventItem,
      guestName,
      eventSiteNav: buildEventSiteNav(req.params.token, guestName, eventItem.name, eventItem.theme, isEventClosed(eventItem)),
      renderedDescriptionHtml: renderEventDescriptionMarkdown(eventItem.description),
      nowIso: new Date().toISOString(),
      eventStartsAtIso: hasValidStartDate ? startsAtDate.toISOString() : null,
      shouldShowCountdown,
      archiveRequestEmail: getEventArchiveRequestEmail(req, req.params.token),
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/event/:token/upload', param('token').trim().matches(/^[A-Za-z0-9]{10}$/), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(404).render('errors/404', {
      title: 'Événement introuvable',
      pageClass: 'page-error',
    });
  }

  try {
    const eventItem = await loadEventByTokenOr404(req, res);
    if (!eventItem) {
      return undefined;
    }

    const guestName = getEventGuestName(req, req.params.token);
    if (!guestName) {
      return res.redirect(`/event/${req.params.token}/register`);
    }

    // Evenement cloture : plus d'envoi possible, on renvoie vers la galerie.
    if (isEventClosed(eventItem)) {
      return res.redirect(`/event/${req.params.token}/gallery`);
    }

    return renderView(res, 'event-upload', {
      title: `${eventItem.name} - Envoi de photos`,
      pageClass: buildEventPageClass(eventItem.theme),
      eventItem,
      guestName,
      eventSiteNav: buildEventSiteNav(req.params.token, guestName, eventItem.name, eventItem.theme, isEventClosed(eventItem)),
      uploadOptions: {
        sourceMode: eventItem.uploadSourceMode,
        allowMultiple: eventItem.uploadAllowMultiple,
        moderationEnabled: eventItem.moderationEnabled,
      },
      headCssPaths: ['/vendor/dropzone/dropzone.css'],
      footerScriptPaths: ['/vendor/dropzone/dropzone-min.js', '/event-upload.js', '/camera.js'],
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/event/:token/gallery', param('token').trim().matches(/^[A-Za-z0-9]{10}$/), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(404).render('errors/404', {
      title: 'Événement introuvable',
      pageClass: 'page-error',
    });
  }

  try {
    const eventItem = await loadEventByTokenOr404(req, res);
    if (!eventItem) {
      return undefined;
    }

    const guestName = getEventGuestName(req, req.params.token);
    if (!guestName) {
      return res.redirect(`/event/${req.params.token}/register`);
    }

    const uploadedFiles = await eventFileStore.listByEventAndStatus(eventItem.id, 'approved');
    const galleryFiles = await Promise.all(uploadedFiles.map(async (fileItem) => {
      const hasXl = await imageVariantService.variantExists(eventItem.uuid, fileItem.storedName, 'xl');
      const hasMd = await imageVariantService.variantExists(eventItem.uuid, fileItem.storedName, 'md');
      const hasSm = await imageVariantService.variantExists(eventItem.uuid, fileItem.storedName, 'sm');

      return {
        ...fileItem,
        isProcessed: hasSm || hasMd || hasXl,
        urls: {
          original: `/event/${req.params.token}/media/${fileItem.storedName}/original`,
          xl: hasXl ? `/event/${req.params.token}/media/${fileItem.storedName}/xl` : null,
          md: hasMd ? `/event/${req.params.token}/media/${fileItem.storedName}/md` : null,
          sm: hasSm ? `/event/${req.params.token}/media/${fileItem.storedName}/sm` : null,
        },
      };
    }));

    return renderView(res, 'event-gallery', {
      title: `${eventItem.name} - Galerie`,
      pageClass: buildEventPageClass(eventItem.theme),
      eventItem,
      guestName,
      eventSiteNav: buildEventSiteNav(req.params.token, guestName, eventItem.name, eventItem.theme, isEventClosed(eventItem)),
      galleryFiles,
    });
  } catch (err) {
    return next(err);
  }
});

router.get(
  '/event/:token/media/:storedName/:variant',
  [
    param('token').trim().matches(/^[A-Za-z0-9]{10}$/),
    param('storedName').trim().matches(imageVariantService.STORED_NAME_PATTERN),
    param('variant').trim().matches(/^(original|xl|md|sm)$/),
  ],
  async (req, res, next) => {
    const result = validationResult(req);
    if (!result.isEmpty()) {
      return res.status(404).render('errors/404', {
        title: 'Événement introuvable',
        pageClass: 'page-error',
      });
    }

    try {
      const eventItem = await eventStore.findByToken(req.params.token);
      if (!eventItem) {
        return res.status(404).render('errors/404', {
          title: 'Événement introuvable',
          pageClass: 'page-error',
        });
      }

      const guestName = getEventGuestName(req, req.params.token);
      if (!guestName) {
        return res.status(403).render('errors/500', {
          title: 'Accès refusé',
          pageClass: 'page-error',
          statusCode: 403,
          message: 'Inscription visiteur requise.',
        });
      }

      const variant = req.params.variant;
      const storedName = req.params.storedName;
      const fileItem = await eventFileStore.findByEventAndStoredName(eventItem.id, storedName);
      if (!isFileApprovedForDisplay(fileItem)) {
        return res.status(404).end();
      }

      const filePath = variant === 'original'
        ? imageVariantService.getOriginalPath(eventItem.uuid, storedName)
        : imageVariantService.getVariantPath(eventItem.uuid, storedName, variant);

      return res.sendFile(filePath, (sendErr) => {
        if (!sendErr) {
          return;
        }

        if (sendErr.code === 'ENOENT') {
          res.status(404).end();
          return;
        }

        next(sendErr);
      });
    } catch (err) {
      return next(err);
    }
  },
);

router.post('/event/:token/upload', param('token').trim().matches(/^[A-Za-z0-9]{10}$/), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(404).json({ message: 'Événement introuvable.' });
  }

  try {
    const eventItem = await eventStore.findByToken(req.params.token);
    if (!eventItem) {
      return res.status(404).json({ message: 'Événement introuvable.' });
    }

    req.eventItem = eventItem;

    const guestName = getEventGuestName(req, req.params.token);
    if (!guestName) {
      return res.status(403).json({ message: 'Inscription visiteur requise avant upload.' });
    }

    if (isEventClosed(eventItem)) {
      return res.status(403).json({ message: 'Cet événement est clôturé : les envois de photos sont terminés.' });
    }

    const eventUploadMiddleware = createEventUploadMiddleware(eventItem.uploadAllowMultiple ? 10 : 1);

    return eventUploadMiddleware(req, res, async (uploadErr) => {
      if (uploadErr) {
        if (uploadErr.message === 'INVALID_FILE_TYPE') {
          return res.status(415).json({ message: 'Seules les images sont autorisées.' });
        }

        if (uploadErr.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ message: 'Un fichier dépasse la taille maximale autorisée (10 Mo).' });
        }

        if (uploadErr.code === 'LIMIT_FILE_COUNT') {
          return res.status(413).json({ message: 'Trop de fichiers envoyés en une seule fois.' });
        }

        if (uploadErr.code === 'ENOENT') {
          logger.error('[EVENT] Répertoire de stockage inaccessible :', uploadErr.message);
          return res.status(500).json({ message: 'Erreur de stockage serveur. Veuillez réessayer.' });
        }

        logger.error('[EVENT] Erreur upload inattendue :', uploadErr.message);
        return res.status(500).json({ message: 'Erreur lors du traitement du fichier.' });
      }

      const uploadedFiles = req.files
        ? Object.values(req.files).flat()
        : [];

      if (uploadedFiles.length === 0) {
        return res.status(400).json({ message: 'Aucun fichier image reçu.' });
      }

      const createdFiles = [];
      try {
        for (const file of uploadedFiles) {
          const checksumSha256 = await computeFileChecksum(file.path);
          const record = await eventFileStore.createFileRecord({
            eventId: eventItem.id,
            uploadedByUserId: req.currentUser ? req.currentUser.id : null,
            uploaderName: guestName,
            originalName: file.originalname,
            storedName: file.filename,
            sizeBytes: file.size,
            storagePath: path.posix.join('events', eventItem.uuid, 'original', file.filename),
            checksumSha256,
            moderationStatus: eventItem.moderationEnabled ? 'pending' : 'approved',
          });

          imageVariantService.enqueueVariantGeneration(eventItem.uuid, file.filename);
          createdFiles.push(record);
        }

        logger.info(`[EVENT] Upload visiteur ${guestName} sur evenement ${eventItem.uuid}: ${createdFiles.length} fichier(s)`);

        const io = req.app && req.app.locals ? req.app.locals.io : null;
        if (io) {
          createdFiles.forEach((fileItem) => {
            if (!isFileApprovedForDisplay(fileItem)) {
              io.to(`event:${eventItem.id}:moderation`).emit(
                'moderation:pending-photo',
                buildOwnerPhotoRealtimePayload(eventItem, fileItem),
              );
              return;
            }

            io.to(`event:${eventItem.id}:slideshow`).emit('slideshow:new-photo', {
              eventId: eventItem.id,
              storedName: fileItem.storedName,
              originalName: fileItem.originalName,
              uploaderName: fileItem.uploaderName,
              uploadedAt: fileItem.createdAt,
            });
          });
        }

        return res.status(201).json({
          message: eventItem.moderationEnabled
            ? `${createdFiles.length} photo(s) envoyée(s). Publication après modération.`
            : `${createdFiles.length} photo(s) envoyée(s).`,
          files: createdFiles,
        });
      } catch (err) {
        // Seuls les fichiers sans enregistrement en base sont supprimes : ceux
        // deja enregistres restent references (galerie, moderation, archive).
        const recordedNames = new Set(createdFiles.map((fileItem) => fileItem.storedName));
        await Promise.all(uploadedFiles
          .filter((file) => !recordedNames.has(file.filename))
          .map((file) => fs.rm(file.path, { force: true })));

        // Cloture survenue pendant la reception de l'envoi (cf. createFileRecord).
        if (err.code === 'EVENT_CLOSED') {
          return res.status(403).json({ message: 'Cet événement est clôturé : les envois de photos sont terminés.' });
        }

        return next(err);
      }
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/event/:token/register', param('token').trim().matches(/^[A-Za-z0-9]{10}$/), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(404).render('errors/404', {
      title: 'Événement introuvable',
      pageClass: 'page-error',
    });
  }

  try {
    const eventItem = await loadEventByTokenOr404(req, res);
    if (!eventItem) {
      return undefined;
    }

    const guestName = getEventGuestName(req, req.params.token);
    if (guestName) {
      return res.redirect(`/event/${req.params.token}`);
    }

    return renderView(res, 'event-register', {
      title: `${eventItem.name} - Inscription`,
      pageClass: buildEventPageClass(eventItem.theme),
      eventItem,
      eventSiteNav: buildEventSiteNav(req.params.token, null, eventItem.name, eventItem.theme, isEventClosed(eventItem)),
      formData: { guestName: '' },
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/event/:token/register', param('token').trim().matches(/^[A-Za-z0-9]{10}$/), eventGuestRegistrationValidators, async (req, res, next) => {
  const result = validationResult(req);
  try {
    const eventItem = await loadEventByTokenOr404(req, res);
    if (!eventItem) {
      return undefined;
    }

    if (!result.isEmpty()) {
      return renderView(res, 'event-register', {
        title: `${eventItem.name} - Inscription`,
        pageClass: buildEventPageClass(eventItem.theme),
        eventItem,
        eventSiteNav: buildEventSiteNav(req.params.token, req.body.guestName || '', eventItem.name, eventItem.theme, isEventClosed(eventItem)),
        formData: { guestName: req.body.guestName || '' },
        fieldErrors: collectFieldErrors(result),
      }, 422);
    }

    const guestName = req.body.guestName.trim();
    res.cookie(eventGuestCookieName(req.params.token), guestName, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: `/event/${req.params.token}`,
    });

    return res.redirect(`/event/${req.params.token}`);
  } catch (err) {
    return next(err);
  }
});

/**
 * Opt-in "recevoir l'archive photos par email" depuis la page evenement.
 * Persiste en base (pour la notification a la cloture) ET en cookie (pour que
 * l'invite revoie son choix, sans reinterroger la base a chaque affichage).
 */
router.post('/event/:token/archive-request', param('token').trim().matches(/^[A-Za-z0-9]{10}$/), eventArchiveRequestValidators, async (req, res, next) => {
  const result = validationResult(req);
  try {
    const eventItem = await loadEventByTokenOr404(req, res);
    if (!eventItem) {
      return undefined;
    }

    const guestName = getEventGuestName(req, req.params.token);
    if (!guestName) {
      return res.redirect(`/event/${req.params.token}/register`);
    }

    if (!result.isEmpty()) {
      req.flash('error', Object.values(collectFieldErrors(result))[0]);
      return res.redirect(`/event/${req.params.token}`);
    }

    const wantsArchive = req.body.wantsArchive === '1';
    const previousEmail = getEventArchiveRequestEmail(req, req.params.token);
    const cookieOptions = {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: `/event/${req.params.token}`,
    };

    if (wantsArchive) {
      const email = req.body.email.trim().toLowerCase();

      if (previousEmail && previousEmail !== email) {
        await eventArchiveRequestStore.removeRequest(eventItem.id, previousEmail);
      }

      await eventArchiveRequestStore.upsertRequest(eventItem.id, email);
      res.cookie(eventArchiveRequestCookieName(req.params.token), signCookieValue(email), {
        ...cookieOptions,
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });

      // Les notifications partent une seule fois, a la fin de la generation :
      // une inscription posterieure a une archive deja prete est servie tout
      // de suite, sinon elle ne recevrait jamais rien.
      if (isEventClosed(eventItem) && eventItem.archiveStatus === 'ready') {
        void archiveNotificationService.notifyArchiveRequesters(eventItem, { emails: [email] }).catch((err) => {
          logger.error(`[ARCHIVE-MAIL] Notification immediate echouee pour ${eventItem.uuid}: ${err.message}`);
        });
        req.flash('success', `L'archive des photos est déjà prête : le lien vous est envoyé à ${email}.`);
      } else {
        req.flash('success', `Vous recevrez l'archive des photos à ${email} dès sa génération.`);
      }
    } else {
      if (previousEmail) {
        await eventArchiveRequestStore.removeRequest(eventItem.id, previousEmail);
      }

      res.clearCookie(eventArchiveRequestCookieName(req.params.token), { path: cookieOptions.path });
      req.flash('success', 'Vous ne recevrez pas l\'archive par email.');
    }

    return res.redirect(`/event/${req.params.token}`);
  } catch (err) {
    return next(err);
  }
});

/**
 * Telechargement public de l'archive ZIP via le lien envoye par email.
 * Aucune verification du cookie invite : ce lien peut etre ouvert sur un autre
 * appareil que celui utilise pour s'inscrire a l'evenement.
 */
router.get('/event/:token/archive', param('token').trim().matches(/^[A-Za-z0-9]{10}$/), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(404).render('errors/404', {
      title: 'Événement introuvable',
      pageClass: 'page-error',
    });
  }

  try {
    const eventItem = await loadEventByTokenOr404(req, res);
    if (!eventItem) {
      return undefined;
    }

    return sendEventArchive(req, res, next, eventItem, `/event/${req.params.token}`);
  } catch (err) {
    return next(err);
  }
});

/**
 * Ouvre une session authentifiee sur un NOUVEL identifiant de session.
 * Reutiliser l'identifiant pre-authentification permettrait une fixation de
 * session (un sid pose a l'avance par un tiers deviendrait authentifie).
 */
function establishUserSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((regenerateErr) => {
      if (regenerateErr) {
        reject(regenerateErr);
        return;
      }

      req.session.userId = userId;
      resolve();
    });
  });
}

router.get('/register', ensureGuest, (req, res) => renderView(res, 'auth/register', {
  title: 'Inscription',
  pageClass: 'page-auth',
}));

router.post('/register', authLimiter, ensureGuest, registrationValidators, async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return renderView(res, 'auth/register', {
      title: 'Inscription',
      pageClass: 'page-auth',
      formData: req.body,
      fieldErrors: collectFieldErrors(result),
    }, 422);
  }

  try {
    const user = await userStore.createUser({
      email: req.body.email,
      password: req.body.password,
      fullName: req.body.fullName,
    });

    await establishUserSession(req, user.id);
    logger.info(`[AUTH] Nouvelle inscription: ${user.email}`);
    req.flash('success', 'Votre compte a été créé.');
    return res.redirect('/profile');
  } catch (err) {
    if (err.code === 'EMAIL_ALREADY_EXISTS') {
      return renderView(res, 'auth/register', {
        title: 'Inscription',
        pageClass: 'page-auth',
        formData: req.body,
        fieldErrors: { email: 'Cette adresse email est deja utilisee.' },
      }, 409);
    }

    return next(err);
  }
});

router.get('/login', ensureGuest, (req, res) => renderView(res, 'auth/login', {
  title: 'Connexion',
  pageClass: 'page-auth',
}));

router.post('/login', authLimiter, ensureGuest, loginValidators, async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return renderView(res, 'auth/login', {
      title: 'Connexion',
      pageClass: 'page-auth',
      formData: req.body,
      fieldErrors: collectFieldErrors(result),
    }, 422);
  }

  try {
    const user = await userStore.findByEmail(req.body.email);
    if (!user || user.status !== 'active') {
      req.flash('error', 'Identifiants invalides.');
      return res.redirect('/login');
    }

    const passwordMatches = await bcrypt.compare(req.body.password, user.passwordHash);
    if (!passwordMatches) {
      req.flash('error', 'Identifiants invalides.');
      return res.redirect('/login');
    }

    await establishUserSession(req, user.id);
    await userStore.updateLastLogin(user.id);
    logger.info(`[AUTH] Connexion reussie: ${user.email}`);
    req.flash('success', 'Connexion réussie.');
    return res.redirect('/profile');
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', requireAuth, (req, res, next) => {
  const email = req.currentUser.email;
  req.session.destroy((err) => {
    if (err) {
      return next(err);
    }

    logger.info(`[AUTH] Deconnexion: ${email}`);
    res.clearCookie('sid');
    return res.redirect('/login');
  });
});

router.get('/profile', requireAuth, async (req, res, next) => {
  try {
    return await renderProfile(req, res);
  } catch (err) {
    return next(err);
  }
});

router.get('/profile/events/new', requireAuth, (req, res) => {
  return renderProfileEventCreateForm(req, res);
});

router.put('/profile', requireAuth, profileValidators, async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return renderProfile(req, res, {
      formData: req.body,
      fieldErrors: collectFieldErrors(result),
    }, 422);
  }

  try {
    const storedUser = await userStore.findById(req.currentUser.id);

    if (req.body.password) {
      const passwordMatches = await bcrypt.compare(req.body.currentPassword, storedUser.passwordHash);
      if (!passwordMatches) {
        return renderProfile(req, res, {
          formData: req.body,
          fieldErrors: { currentPassword: 'Le mot de passe actuel est incorrect.' },
        }, 422);
      }
    }

    await userStore.updateUser(req.currentUser.id, {
      fullName: req.body.fullName,
      password: req.body.password || undefined,
    });

    logger.info(`[PROFILE] Mise a jour du profil: ${req.currentUser.email}`);
    req.flash('success', 'Votre profil a été mis à jour.');
    return res.redirect('/profile');
  } catch (err) {
    return next(err);
  }
});

router.post('/profile/events', requireAuth, eventValidators, async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return renderProfileEventCreateForm(req, res, {
      formData: normalizeEventFormData({
        fullName: req.currentUser.fullName,
        ...req.body,
      }),
      fieldErrors: collectFieldErrors(result),
    }, 422);
  }

  try {
    await eventStore.createEvent({
      ownerUserId: req.currentUser.id,
      name: req.body.name,
      description: normalizeEventDescriptionMarkdown(req.body.description),
      startsAt: req.body.startsAt,
      status: req.body.status,
      theme: eventThemes.normalizeThemeKey(req.body.theme),
      slideshowTransition: eventTransitions.normalizeTransitionKey(req.body.slideshowTransition),
      uploadSourceMode: req.body.uploadSourceMode,
      uploadAllowMultiple: parseUploadAllowMultiple(req.body.uploadAllowMultiple),
      moderationEnabled: parseModerationEnabled(req.body.moderationEnabled),
    });

    logger.info(`[EVENT] ${req.currentUser.email} a cree l'evenement ${req.body.name}`);
    req.flash('success', 'Événement créé.');
    return res.redirect('/profile');
  } catch (err) {
    return next(err);
  }
});

router.get('/profile/events/:id/edit', requireAuth, param('id').isInt({ min: 1 }), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return renderEventNotFound(res);
  }

  try {
    const eventId = Number(req.params.id);
    const editingEvent = await findOwnedEvent(req.currentUser.id, eventId);
    if (!editingEvent) {
      return renderEventNotFound(res);
    }

    if (isEventClosed(editingEvent)) {
      return rejectClosedEvent(req, res);
    }

    return renderProfileEventForm(req, res, editingEvent);
  } catch (err) {
    return next(err);
  }
});

router.get('/profile/events/:id/gallery', requireAuth, param('id').isInt({ min: 1 }), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return renderEventNotFound(res);
  }

  try {
    const eventId = Number(req.params.id);
    const editingEvent = await findOwnedEvent(req.currentUser.id, eventId);
    if (!editingEvent) {
      return renderEventNotFound(res);
    }

    const galleryFiles = await buildOwnerGalleryFiles(editingEvent);

    return renderView(res, 'profile-event-gallery', {
      title: `Galerie - ${editingEvent.name}`,
      pageClass: 'page-profile',
      editingEvent,
      galleryFiles,
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/profile/events/:id/slideshow', requireAuth, param('id').isInt({ min: 1 }), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return renderEventNotFound(res);
  }

  try {
    const eventId = Number(req.params.id);
    const editingEvent = await findOwnedEvent(req.currentUser.id, eventId);
    if (!editingEvent) {
      return renderEventNotFound(res);
    }

    const uploadedFiles = await eventFileStore.listByEventAndStatus(editingEvent.id, 'approved');
    const initialPhotos = uploadedFiles.map((fileItem) => ({
      storedName: fileItem.storedName,
      originalName: fileItem.originalName,
      uploaderName: fileItem.uploaderName,
      uploadedAt: fileItem.createdAt,
    }));

    return renderView(res, 'profile-event-slideshow', {
      title: `Diaporama - ${editingEvent.name}`,
      pageClass: 'page-profile',
      editingEvent,
      eventTheme: eventThemes.getTheme(editingEvent.theme),
      slideshowTransition: eventTransitions.normalizeTransitionKey(editingEvent.slideshowTransition),
      initialPhotos,
      footerScriptPaths: ['/socket.io/socket.io.js', '/profile-event-slideshow.js'],
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * API GET /profile/event/:id/moderation/csrf-token
 * ⚠️ ROUTE PLUS SPÉCIFIQUE - DOIT ÊTRE AVANT /profile/event/:id/moderation
 * Retourne un token CSRF frais pour les requêtes AJAX
 */
router.get(
  '/profile/event/:id/moderation/csrf-token',
  requireAuth,
  param('id').isInt({ min: 1 }),
  async (req, res, next) => {
    const result = validationResult(req);
    if (!result.isEmpty()) {
      return res.status(400).json({ error: 'ID d\'événement invalide' });
    }

    try {
      const eventId = Number(req.params.id);
      const editingEvent = await findOwnedEvent(req.currentUser.id, eventId);
      if (!editingEvent) {
        return res.status(404).json({ error: 'Événement non trouvé' });
      }

      // Générer un token CSRF frais
      const csrfToken = typeof req.csrfToken === 'function' ? req.csrfToken() : '';

      logger.debug(`[CSRF-API] Token frais généré pour event ${eventId}`);

      return res.json({
        csrfToken: csrfToken,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      logger.error(`[CSRF-API] Erreur GET token: ${err.message}`);
      return res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

router.get('/profile/event/:id/moderation', requireAuth, param('id').isInt({ min: 1 }), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return renderEventNotFound(res);
  }

  try {
    const eventId = Number(req.params.id);
    const editingEvent = await findOwnedEvent(req.currentUser.id, eventId);
    if (!editingEvent) {
      return renderEventNotFound(res);
    }

    const moderationFiles = (await buildOwnerGalleryFiles(editingEvent))
      .filter((fileItem) => fileItem.moderationStatus === 'pending');

    return renderView(res, 'profile-event-moderation', {
      title: `Modération - ${editingEvent.name}`,
      pageClass: 'page-profile',
      editingEvent,
      moderationFiles,
      footerScriptPaths: ['/socket.io/socket.io.js', '/profile-event-moderation.js'],
    });
  } catch (err) {
    return next(err);
  }
});

router.post(
  '/profile/event/:id/moderation/:fileId',
  [requireAuth, param('id').isInt({ min: 1 }), param('fileId').isInt({ min: 1 })],
  async (req, res, next) => {
    const result = validationResult(req);
    if (!result.isEmpty()) {
      return renderEventNotFound(res);
    }

    try {
      const eventId = Number(req.params.id);
      const fileId = Number(req.params.fileId);
      const moderationStatus = req.body.moderationStatus;
      if (!eventFileStore.MODERATION_STATUSES.has(moderationStatus)) {
        req.flash('error', 'Statut de modération invalide.');
        return res.redirect(`/profile/event/${eventId}/moderation`);
      }

      const editingEvent = await findOwnedEvent(req.currentUser.id, eventId);
      if (!editingEvent) {
        return renderEventNotFound(res);
      }

      // Apres cloture l'archive ZIP est deja figee : moderer encore
      // desynchroniserait la galerie et l'archive remise a l'organisateur.
      if (isEventClosed(editingEvent)) {
        return rejectClosedEvent(req, res, `/profile/event/${eventId}/moderation`);
      }

      const existingFile = await eventFileStore.listByEvent(editingEvent.id);
      const targetFile = existingFile.find((fileItem) => fileItem.id === fileId);
      if (!targetFile) {
        return renderEventNotFound(res);
      }

      const updatedFile = await eventFileStore.updateModerationStatus(fileId, moderationStatus);
      const io = req.app && req.app.locals ? req.app.locals.io : null;

      if (io) {
        if (moderationStatus === 'pending') {
          io.to(`event:${editingEvent.id}:moderation`).emit(
            'moderation:pending-photo',
            buildOwnerPhotoRealtimePayload(editingEvent, updatedFile),
          );
        } else {
          io.to(`event:${editingEvent.id}:moderation`).emit('moderation:photo-reviewed', {
            eventId: editingEvent.id,
            fileId: updatedFile.id,
            storedName: updatedFile.storedName,
            moderationStatus,
          });
        }
      }

      if (isFileApprovedForDisplay(updatedFile)) {
        if (io) {
          io.to(`event:${editingEvent.id}:slideshow`).emit('slideshow:new-photo', {
            eventId: editingEvent.id,
            storedName: updatedFile.storedName,
            originalName: updatedFile.originalName,
            uploaderName: updatedFile.uploaderName,
            uploadedAt: updatedFile.createdAt,
          });
        }
      }

      if (req.xhr || (req.headers.accept || '').includes('application/json')) {
        return res.json({
          ok: true,
          file: {
            id: updatedFile.id,
            moderationStatus: updatedFile.moderationStatus,
          },
        });
      }

      req.flash('success', moderationStatus === 'approved'
        ? 'Photo approuvée et visible dans le diaporama.'
        : (moderationStatus === 'rejected' ? 'Photo rejetée.' : 'Photo remise en attente.'));
      return res.redirect(`/profile/event/${eventId}/moderation`);
    } catch (err) {
      return next(err);
    }
  },
);

router.get(
  '/profile/events/:id/photos/:storedName/:variant',
  [
    requireAuth,
    param('id').isInt({ min: 1 }),
    param('storedName').trim().matches(imageVariantService.STORED_NAME_PATTERN),
    param('variant').trim().matches(/^(original|xl|md|sm)$/),
  ],
  async (req, res, next) => {
    const result = validationResult(req);
    if (!result.isEmpty()) {
      return renderEventNotFound(res);
    }

    try {
      const eventId = Number(req.params.id);
      const editingEvent = await findOwnedEvent(req.currentUser.id, eventId);
      if (!editingEvent) {
        return renderEventNotFound(res);
      }

      const variant = req.params.variant;
      const storedName = req.params.storedName;
      const filePath = variant === 'original'
        ? imageVariantService.getOriginalPath(editingEvent.uuid, storedName)
        : imageVariantService.getVariantPath(editingEvent.uuid, storedName, variant);

      return res.sendFile(filePath, (sendErr) => {
        if (!sendErr) {
          return;
        }

        if (sendErr.code === 'ENOENT') {
          res.status(404).end();
          return;
        }

        next(sendErr);
      });
    } catch (err) {
      return next(err);
    }
  },
);

router.put('/profile/events/:id', requireAuth, param('id').isInt({ min: 1 }), eventValidators, async (req, res, next) => {
  const eventId = Number(req.params.id);
  const result = validationResult(req);
  if (!result.isEmpty()) {
    try {
      const editingEvent = await findOwnedEvent(req.currentUser.id, eventId);
      if (!editingEvent) {
        return renderEventNotFound(res);
      }

      return renderProfileEventForm(req, res, editingEvent, {
        formData: normalizeEventFormData(req.body, editingEvent),
        fieldErrors: collectFieldErrors(result),
      }, 422);
    } catch (err) {
      return next(err);
    }
  }

  try {
    const editingEvent = await findOwnedEvent(req.currentUser.id, eventId);
    if (!editingEvent) {
      return renderEventNotFound(res);
    }

    if (isEventClosed(editingEvent)) {
      return rejectClosedEvent(req, res);
    }

    const nextModerationEnabled = parseModerationEnabled(req.body.moderationEnabled);

    await eventStore.updateEvent(eventId, {
      name: req.body.name,
      description: normalizeEventDescriptionMarkdown(req.body.description),
      startsAt: req.body.startsAt,
      status: req.body.status,
      theme: eventThemes.normalizeThemeKey(req.body.theme),
      slideshowTransition: eventTransitions.normalizeTransitionKey(req.body.slideshowTransition),
      uploadSourceMode: req.body.uploadSourceMode,
      uploadAllowMultiple: parseUploadAllowMultiple(req.body.uploadAllowMultiple),
      moderationEnabled: nextModerationEnabled,
    });

    const autoApprovedCount = await autoApprovePendingFilesIfModerationDisabled(
      editingEvent,
      nextModerationEnabled,
      req.app,
    );

    logger.info(`[EVENT] ${req.currentUser.email} a mis a jour son evenement ${editingEvent.uuid}`);
    req.flash('success', autoApprovedCount > 0
      ? `Événement mis à jour. ${autoApprovedCount} photo(s) en attente ont été automatiquement approuvées.`
      : 'Événement mis à jour.');
    return res.redirect('/profile');
  } catch (err) {
    return next(err);
  }
});

router.post('/profile/events/:id/activate', requireAuth, param('id').isInt({ min: 1 }), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return renderEventNotFound(res);
  }

  try {
    const eventId = Number(req.params.id);
    const editingEvent = await findOwnedEvent(req.currentUser.id, eventId);
    if (!editingEvent) {
      return renderEventNotFound(res);
    }

    if (isEventClosed(editingEvent)) {
      return rejectClosedEvent(req, res);
    }

    if (editingEvent.status !== 'active') {
      await eventStore.updateEvent(eventId, { status: 'active' });
      logger.info(`[EVENT] ${req.currentUser.email} a active son evenement ${editingEvent.uuid}`);
      req.flash('success', 'Événement activé.');
    } else {
      req.flash('success', 'Événement déjà actif.');
    }

    return res.redirect('/profile');
  } catch (err) {
    return next(err);
  }
});

/**
 * Cloture DEFINITIVE d'un evenement.
 *
 * Pas de retour arriere : l'evenement passe en `closed`, les uploads visiteurs
 * sont refuses et la generation du ZIP des photos est mise en file d'attente.
 * Le lien de telechargement n'apparait sur le dashboard qu'une fois l'archive
 * reellement ecrite sur disque (archive_status = 'ready').
 */
router.post('/profile/events/:id/close', requireAuth, param('id').isInt({ min: 1 }), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return renderEventNotFound(res);
  }

  try {
    const eventId = Number(req.params.id);
    const editingEvent = await findOwnedEvent(req.currentUser.id, eventId);
    if (!editingEvent) {
      return renderEventNotFound(res);
    }

    if (isEventClosed(editingEvent)) {
      req.flash('error', 'Cet événement est déjà clôturé.');
      return res.redirect('/profile');
    }

    // Le champ de confirmation est genere par la popup : sans lui, on refuse.
    // Cela garantit qu'aucune cloture ne peut partir d'un simple lien ou d'un
    // double-submit accidentel.
    // Meme normalisation que la popup (trim), qui active le bouton sur ce critere.
    if (String(req.body.confirmClose || '').trim() !== 'CLOTURER') {
      req.flash('error', 'Clôture annulée : la confirmation est obligatoire.');
      return res.redirect('/profile');
    }

    // Une photo restee 'pending' n'entrerait ni dans la galerie ni dans
    // l'archive, et la moderation devient inaccessible apres cloture : elle
    // serait perdue. On exige donc que tout soit tranche avant de figer.
    const pendingCount = await eventFileStore.countByEventAndStatus(eventId, 'pending');
    if (pendingCount > 0) {
      req.flash('error', `Clôture impossible : ${pendingCount} photo(s) attendent encore votre modération. `
        + 'Approuvez-les ou rejetez-les avant de clôturer, sinon elles seraient définitivement perdues.');
      return res.redirect(`/profile/event/${eventId}/moderation`);
    }

    let closedEvent;
    try {
      closedEvent = await eventStore.closeEvent(eventId);
    } catch (closeErr) {
      // Photo arrivee en moderation entre la verification ci-dessus et la cloture.
      if (closeErr.code !== 'EVENT_PENDING_MODERATION') {
        throw closeErr;
      }

      req.flash('error', 'Clôture impossible : de nouvelles photos attendent votre modération. '
        + 'Approuvez-les ou rejetez-les avant de clôturer.');
      return res.redirect(`/profile/event/${eventId}/moderation`);
    }

    if (!closedEvent) {
      req.flash('error', 'Cet événement est déjà clôturé.');
      return res.redirect('/profile');
    }

    eventArchiveService.enqueueArchiveGeneration(closedEvent.id);

    logger.info(`[EVENT] ${req.currentUser.email} a cloture definitivement l'evenement ${closedEvent.uuid}`);
    req.flash('success', 'Événement clôturé définitivement. L\'archive ZIP des photos est en cours de préparation.');
    return res.redirect('/profile');
  } catch (err) {
    return next(err);
  }
});

/**
 * Etat de l'archive (JSON) : interroge par le dashboard tant que le ZIP
 * n'est pas pret, pour remplacer le message d'attente par le lien.
 */
router.get('/profile/events/:id/archive/status', requireAuth, param('id').isInt({ min: 1 }), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(400).json({ error: 'Identifiant d\'événement invalide.' });
  }

  try {
    const eventItem = await findOwnedEvent(req.currentUser.id, Number(req.params.id));
    if (!eventItem) {
      return res.status(404).json({ error: 'Événement introuvable.' });
    }

    return res.json(buildArchiveViewModel(eventItem));
  } catch (err) {
    return next(err);
  }
});

/** Telechargement de l'archive ZIP par le proprietaire de l'evenement. */
router.get('/profile/events/:id/archive', requireAuth, param('id').isInt({ min: 1 }), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return renderEventNotFound(res);
  }

  try {
    const eventItem = await findOwnedEvent(req.currentUser.id, Number(req.params.id));
    if (!eventItem) {
      return renderEventNotFound(res);
    }

    return sendEventArchive(req, res, next, eventItem, '/profile');
  } catch (err) {
    return next(err);
  }
});

router.post('/profile/events/:id/regenerate-token', requireAuth, param('id').isInt({ min: 1 }), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return renderEventNotFound(res);
  }

  try {
    const eventId = Number(req.params.id);
    const editingEvent = await findOwnedEvent(req.currentUser.id, eventId);
    if (!editingEvent) {
      return renderEventNotFound(res);
    }

    if (isEventClosed(editingEvent)) {
      return rejectClosedEvent(req, res);
    }

    const newToken = await eventStore.generateUniqueToken();
    await eventStore.updateEvent(eventId, { token: newToken });

    logger.info(`[EVENT] ${req.currentUser.email} a regenere le token de ${editingEvent.uuid}`);
    req.flash('success', 'Lien invité régénéré.');
    return res.redirect(`/profile/events/${eventId}/edit`);
  } catch (err) {
    return next(err);
  }
});

router.delete('/profile/events/:id', requireAuth, param('id').isInt({ min: 1 }), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return renderEventNotFound(res);
  }

  try {
    const eventId = Number(req.params.id);
    const editingEvent = await findOwnedEvent(req.currentUser.id, eventId);
    if (!editingEvent) {
      return renderEventNotFound(res);
    }

    await eventStore.deleteEvent(eventId);
    logger.info(`[EVENT] ${req.currentUser.email} a supprime son evenement ${editingEvent.uuid}`);
    req.flash('success', 'Événement supprimé.');
    return res.redirect('/profile');
  } catch (err) {
    return next(err);
  }
});

router.get('/admin', requireAdmin, async (req, res, next) => {
  try {
    const users = await userStore.listUsers();
    const events = await eventStore.listAll();
    return renderView(res, 'admin/dashboard', {
      title: 'Administration',
      pageClass: 'page-admin',
      users,
      events,
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/admin/settings', requireAdmin, async (req, res, next) => {
  try {
    const mailNotificationsEnabled = await settingsStore.getBoolSetting('mail_archive_notifications_enabled', false);
    return renderView(res, 'admin/settings', {
      title: 'Réglages',
      pageClass: 'page-admin',
      mailNotificationsEnabled,
      mailEnvConfigured: mailService.isEnvConfigured(),
      mailBaseUrlConfigured: archiveNotificationService.isBaseUrlConfigured(),
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/admin/settings', requireAdmin, async (req, res, next) => {
  try {
    await settingsStore.setBoolSetting('mail_archive_notifications_enabled', req.body.mailNotificationsEnabled === '1');
    req.flash('success', 'Réglages mis à jour.');
    return res.redirect('/admin/settings');
  } catch (err) {
    return next(err);
  }
});

router.get('/admin/events/new', requireAdmin, async (req, res, next) => {
  try {
    const users = await userStore.listUsers();
    return renderView(res, 'admin/event-form', {
      title: 'Nouvel événement',
      pageClass: 'page-admin',
      mode: 'create',
      users,
      eventFiles: [],
      editingEvent: null,
      formData: {
        status: 'inactive',
        theme: eventThemes.DEFAULT_EVENT_THEME,
        slideshowTransition: eventTransitions.DEFAULT_EVENT_TRANSITION,
        uploadSourceMode: 'default',
        uploadAllowMultiple: true,
        moderationEnabled: false,
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/admin/events', requireAdmin, adminEventValidators, async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    try {
      const users = await userStore.listUsers();
      return renderView(res, 'admin/event-form', {
        title: 'Nouvel événement',
        pageClass: 'page-admin',
        mode: 'create',
        users,
        eventFiles: [],
        editingEvent: null,
        formData: normalizeEventFormData(req.body),
        fieldErrors: collectFieldErrors(result),
      }, 422);
    } catch (err) {
      return next(err);
    }
  }

  try {
    await eventStore.createEvent({
      ownerUserId: Number(req.body.ownerUserId),
      name: req.body.name,
      description: normalizeEventDescriptionMarkdown(req.body.description),
      startsAt: req.body.startsAt,
      status: req.body.status,
      theme: eventThemes.normalizeThemeKey(req.body.theme),
      slideshowTransition: eventTransitions.normalizeTransitionKey(req.body.slideshowTransition),
      uploadSourceMode: req.body.uploadSourceMode,
      uploadAllowMultiple: parseUploadAllowMultiple(req.body.uploadAllowMultiple),
      moderationEnabled: parseModerationEnabled(req.body.moderationEnabled),
    });

    logger.info(`[ADMIN] ${req.currentUser.email} a cree un evenement (${req.body.name})`);
    req.flash('success', 'Événement créé.');
    return res.redirect('/admin');
  } catch (err) {
    return next(err);
  }
});

router.get('/admin/events/:id/edit', requireAdmin, param('id').isInt({ min: 1 }), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(404).render('errors/404', {
      title: 'Événement introuvable',
      pageClass: 'page-error',
    });
  }

  try {
    const editingEvent = await eventStore.findById(Number(req.params.id));
    if (!editingEvent) {
      return res.status(404).render('errors/404', {
        title: 'Événement introuvable',
        pageClass: 'page-error',
      });
    }

    if (isEventClosed(editingEvent)) {
      return rejectClosedEvent(req, res, '/admin');
    }

    const users = await userStore.listUsers();
    const eventFiles = await eventFileStore.listByEvent(editingEvent.id);
    return renderView(res, 'admin/event-form', {
      title: 'Modifier l\'événement',
      pageClass: 'page-admin',
      mode: 'edit',
      users,
      eventFiles,
      editingEvent,
      formData: normalizeEventFormData({
        ...editingEvent,
        startsAt: toDateTimeLocal(editingEvent.startsAt),
      }, editingEvent),
    });
  } catch (err) {
    return next(err);
  }
});

router.put('/admin/events/:id', requireAdmin, param('id').isInt({ min: 1 }), adminEventValidators, async (req, res, next) => {
  const eventId = Number(req.params.id);
  const result = validationResult(req);
  if (!result.isEmpty()) {
    try {
      const users = await userStore.listUsers();
      const editingEvent = await eventStore.findById(eventId);
      const eventFiles = editingEvent ? await eventFileStore.listByEvent(editingEvent.id) : [];
      return renderView(res, 'admin/event-form', {
        title: 'Modifier l\'événement',
        pageClass: 'page-admin',
        mode: 'edit',
        users,
        eventFiles,
        editingEvent,
        formData: normalizeEventFormData({ ...req.body, id: eventId }, editingEvent || {}),
        fieldErrors: collectFieldErrors(result),
      }, 422);
    } catch (err) {
      return next(err);
    }
  }

  try {
    const currentEvent = await eventStore.findById(eventId);
    if (!currentEvent) {
      return res.status(404).render('errors/404', {
        title: 'Événement introuvable',
        pageClass: 'page-error',
      });
    }

    if (isEventClosed(currentEvent)) {
      return rejectClosedEvent(req, res, '/admin');
    }

    const nextModerationEnabled = parseModerationEnabled(req.body.moderationEnabled);

    const updated = await eventStore.updateEvent(eventId, {
      ownerUserId: Number(req.body.ownerUserId),
      name: req.body.name,
      description: normalizeEventDescriptionMarkdown(req.body.description),
      startsAt: req.body.startsAt,
      status: req.body.status,
      theme: eventThemes.normalizeThemeKey(req.body.theme),
      slideshowTransition: eventTransitions.normalizeTransitionKey(req.body.slideshowTransition),
      uploadSourceMode: req.body.uploadSourceMode,
      uploadAllowMultiple: parseUploadAllowMultiple(req.body.uploadAllowMultiple),
      moderationEnabled: nextModerationEnabled,
    });

    if (!updated) {
      return res.status(404).render('errors/404', {
        title: 'Événement introuvable',
        pageClass: 'page-error',
      });
    }

    const autoApprovedCount = await autoApprovePendingFilesIfModerationDisabled(
      currentEvent,
      nextModerationEnabled,
      req.app,
    );

    logger.info(`[ADMIN] ${req.currentUser.email} a mis a jour l'evenement ${updated.uuid}`);
    req.flash('success', autoApprovedCount > 0
      ? `Événement mis à jour. ${autoApprovedCount} photo(s) en attente ont été automatiquement approuvées.`
      : 'Événement mis à jour.');
    return res.redirect('/admin');
  } catch (err) {
    return next(err);
  }
});

/**
 * Telechargement de l'archive ZIP depuis l'interface d'administration.
 * Meme garde-fou que cote organisateur : archive `ready` et presente sur disque.
 */
router.get('/admin/events/:id/archive', requireAdmin, param('id').isInt({ min: 1 }), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return renderEventNotFound(res);
  }

  try {
    const eventItem = await eventStore.findById(Number(req.params.id));
    if (!eventItem) {
      return renderEventNotFound(res);
    }

    return sendEventArchive(req, res, next, eventItem, '/admin');
  } catch (err) {
    return next(err);
  }
});

/** Nouvelle tentative de generation d'une archive ZIP en echec. */
router.post('/admin/events/:id/archive/retry', requireAdmin, param('id').isInt({ min: 1 }), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return renderEventNotFound(res);
  }

  try {
    const restarted = await eventArchiveService.retryArchiveGeneration(Number(req.params.id));
    if (restarted) {
      logger.info(`[ADMIN] ${req.currentUser.email} a relance l'archive de l'evenement ${req.params.id}`);
      req.flash('success', 'Génération de l\'archive relancée.');
    } else {
      req.flash('error', 'Seule une archive en échec d\'un événement clôturé peut être relancée.');
    }

    return res.redirect('/admin');
  } catch (err) {
    return next(err);
  }
});

router.post('/admin/events/:id/regenerate-token', requireAdmin, param('id').isInt({ min: 1 }), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return renderEventNotFound(res);
  }

  try {
    const eventId = Number(req.params.id);
    const editingEvent = await eventStore.findById(eventId);
    if (!editingEvent) {
      return renderEventNotFound(res);
    }

    if (isEventClosed(editingEvent)) {
      return rejectClosedEvent(req, res, '/admin');
    }

    const newToken = await eventStore.generateUniqueToken();
    await eventStore.updateEvent(eventId, { token: newToken });

    logger.info(`[ADMIN] ${req.currentUser.email} a regenere le token de l'evenement ${editingEvent.uuid}`);
    req.flash('success', 'Lien invité régénéré.');
    return res.redirect(`/admin/events/${eventId}/edit`);
  } catch (err) {
    return next(err);
  }
});

router.delete('/admin/events/:id', requireAdmin, param('id').isInt({ min: 1 }), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(404).render('errors/404', {
      title: 'Événement introuvable',
      pageClass: 'page-error',
    });
  }

  try {
    await eventStore.deleteEvent(Number(req.params.id));
    logger.info(`[ADMIN] ${req.currentUser.email} a supprime l'evenement #${req.params.id}`);
    req.flash('success', 'Événement supprimé.');
    return res.redirect('/admin');
  } catch (err) {
    return next(err);
  }
});

router.get('/admin/users/new', requireAdmin, (req, res) => renderView(res, 'admin/user-form', {
  title: 'Nouvel utilisateur',
  pageClass: 'page-admin',
  mode: 'create',
  userEvents: [],
  formData: { role: 'user', status: 'active' },
  editingUser: null,
}));

router.post('/admin/users', requireAdmin, adminUserValidators, async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty() || !req.body.password) {
    const fieldErrors = collectFieldErrors(result);
    if (!req.body.password) {
      fieldErrors.password = 'Le mot de passe est requis.';
    }

    return renderView(res, 'admin/user-form', {
      title: 'Nouvel utilisateur',
      pageClass: 'page-admin',
      mode: 'create',
      userEvents: [],
      editingUser: null,
      formData: req.body,
      fieldErrors,
    }, 422);
  }

  try {
    await userStore.createUser({
      email: req.body.email,
      password: req.body.password,
      fullName: req.body.fullName,
      role: req.body.role,
      status: req.body.status,
    });

    logger.info(`[ADMIN] ${req.currentUser.email} a cree l'utilisateur ${req.body.email}`);
    req.flash('success', 'Utilisateur créé.');
    return res.redirect('/admin');
  } catch (err) {
    if (err.code === 'EMAIL_ALREADY_EXISTS') {
      return renderView(res, 'admin/user-form', {
        title: 'Nouvel utilisateur',
        pageClass: 'page-admin',
        mode: 'create',
        userEvents: [],
        editingUser: null,
        formData: req.body,
        fieldErrors: { email: 'Cette adresse email est deja utilisee.' },
      }, 409);
    }

    return next(err);
  }
});

router.get('/admin/users/:id/edit', requireAdmin, param('id').isInt({ min: 1 }), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(404).render('errors/404', {
      title: 'Utilisateur introuvable',
      pageClass: 'page-error',
    });
  }

  try {
    const editingUser = await userStore.findPublicById(Number(req.params.id));
    if (!editingUser) {
      return res.status(404).render('errors/404', {
        title: 'Utilisateur introuvable',
        pageClass: 'page-error',
      });
    }

    const userEvents = await eventStore.listByOwner(editingUser.id);

    return renderView(res, 'admin/user-form', {
      title: 'Modifier l\'utilisateur',
      pageClass: 'page-admin',
      mode: 'edit',
      editingUser,
      userEvents,
      formData: editingUser,
    });
  } catch (err) {
    return next(err);
  }
});

router.put('/admin/users/:id', requireAdmin, param('id').isInt({ min: 1 }), adminUserValidators, async (req, res, next) => {
  const result = validationResult(req);
  const userId = Number(req.params.id);
  if (!result.isEmpty()) {
    const editingUser = await userStore.findPublicById(userId);
    const userEvents = editingUser ? await eventStore.listByOwner(editingUser.id) : [];
    return renderView(res, 'admin/user-form', {
      title: 'Modifier l\'utilisateur',
      pageClass: 'page-admin',
      mode: 'edit',
      editingUser,
      userEvents,
      formData: { ...req.body, id: userId },
      fieldErrors: collectFieldErrors(result),
    }, 422);
  }

  try {
    const targetUser = await userStore.findById(userId);
    if (!targetUser) {
      return res.status(404).render('errors/404', {
        title: 'Utilisateur introuvable',
        pageClass: 'page-error',
      });
    }

    if (targetUser.id === req.currentUser.id && req.body.role !== 'admin') {
      req.flash('error', 'Vous ne pouvez pas retirer votre propre rôle administrateur.');
      return res.redirect(`/admin/users/${targetUser.id}/edit`);
    }

    if (targetUser.id === req.currentUser.id && req.body.status !== 'active') {
      req.flash('error', 'Vous ne pouvez pas désactiver votre propre compte.');
      return res.redirect(`/admin/users/${targetUser.id}/edit`);
    }

    if (targetUser.role === 'admin' && targetUser.status === 'active') {
      const remainingAdmins = await userStore.countActiveAdmins(targetUser.id);
      if ((req.body.role !== 'admin' || req.body.status !== 'active') && remainingAdmins === 0) {
        req.flash('error', 'Au moins un administrateur actif doit être conservé.');
        return res.redirect(`/admin/users/${targetUser.id}/edit`);
      }
    }

    await userStore.updateUser(userId, {
      email: req.body.email,
      fullName: req.body.fullName,
      role: req.body.role,
      status: req.body.status,
      password: req.body.password || undefined,
    });

    logger.info(`[ADMIN] ${req.currentUser.email} a mis a jour l'utilisateur ${targetUser.email}`);
    req.flash('success', 'Utilisateur mis à jour.');
    return res.redirect('/admin');
  } catch (err) {
    if (err.code === 'EMAIL_ALREADY_EXISTS') {
      const editingUser = await userStore.findPublicById(userId);
      const userEvents = editingUser ? await eventStore.listByOwner(editingUser.id) : [];
      return renderView(res, 'admin/user-form', {
        title: 'Modifier l\'utilisateur',
        pageClass: 'page-admin',
        mode: 'edit',
        editingUser,
        userEvents,
        formData: { ...req.body, id: userId },
        fieldErrors: { email: 'Cette adresse email est deja utilisee.' },
      }, 409);
    }

    return next(err);
  }
});

router.delete('/admin/users/:id', requireAdmin, param('id').isInt({ min: 1 }), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(404).render('errors/404', {
      title: 'Utilisateur introuvable',
      pageClass: 'page-error',
    });
  }

  try {
    const targetUser = await userStore.findById(Number(req.params.id));
    if (!targetUser) {
      return res.status(404).render('errors/404', {
        title: 'Utilisateur introuvable',
        pageClass: 'page-error',
      });
    }

    if (targetUser.id === req.currentUser.id) {
      req.flash('error', 'Vous ne pouvez pas supprimer votre propre compte.');
      return res.redirect('/admin');
    }

    if (targetUser.role === 'admin' && targetUser.status === 'active') {
      const remainingAdmins = await userStore.countActiveAdmins(targetUser.id);
      if (remainingAdmins === 0) {
        req.flash('error', 'Au moins un administrateur actif doit être conservé.');
        return res.redirect('/admin');
      }
    }

    // Supprime d'abord les evenements via eventStore pour effacer aussi leur
    // stockage disque : la cascade SQL de users ne supprimerait que les lignes.
    await eventStore.deleteEventsByOwner(targetUser.id);
    await userStore.deleteUser(targetUser.id);
    logger.info(`[ADMIN] ${req.currentUser.email} a supprime l'utilisateur ${targetUser.email}`);
    req.flash('success', 'Utilisateur supprimé.');
    return res.redirect('/admin');
  } catch (err) {
    return next(err);
  }
});

router.get(
  '/admin/events/:id/photos/:storedName/:variant',
  [
    requireAdmin,
    param('id').isInt({ min: 1 }),
    param('storedName').trim().matches(imageVariantService.STORED_NAME_PATTERN),
    param('variant').trim().matches(/^(original|xl|md|sm)$/),
  ],
  async (req, res, next) => {
    const result = validationResult(req);
    if (!result.isEmpty()) {
      return res.status(404).render('errors/404', {
        title: 'Événement introuvable',
        pageClass: 'page-error',
      });
    }

    try {
      const eventItem = await eventStore.findById(Number(req.params.id));
      if (!eventItem) {
        return res.status(404).render('errors/404', {
          title: 'Événement introuvable',
          pageClass: 'page-error',
        });
      }

      const variant = req.params.variant;
      const storedName = req.params.storedName;
      const filePath = variant === 'original'
        ? imageVariantService.getOriginalPath(eventItem.uuid, storedName)
        : imageVariantService.getVariantPath(eventItem.uuid, storedName, variant);

      return res.sendFile(filePath, (sendErr) => {
        if (!sendErr) {
          return;
        }

        if (sendErr.code === 'ENOENT') {
          res.status(404).end();
          return;
        }

        next(sendErr);
      });
    } catch (err) {
      return next(err);
    }
  },
);

module.exports = router;
