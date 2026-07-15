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
const { requireAuth, requireAdmin } = require('../middleware/auth');
const eventFileStore = require('../services/eventFileStore');
const imageVariantService = require('../services/imageVariantService');
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
  message: 'Trop de tentatives, veuillez reessayer plus tard.',
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

function buildEventSiteNav(token, guestName, eventName, themeKey) {
  return {
    token,
    guestName: (guestName || 'Visiteur').trim().slice(0, 120),
    eventName: (eventName || 'Evenement').trim().slice(0, 120),
    eventTheme: eventThemes.getTheme(themeKey),
    eventUrl: `/event/${token}`,
    galleryUrl: `/event/${token}/gallery`,
    uploadUrl: `/event/${token}/upload`,
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

function sanitizeFileExtension(originalName) {
  const extension = path.extname(originalName || '').toLowerCase();
  if (!extension || !/^\.[a-z0-9]{1,10}$/.test(extension)) {
    return '';
  }

  return extension;
}

async function computeFileChecksum(filePath) {
  const fileBuffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

async function loadEventByTokenOr404(req, res) {
  const eventItem = await eventStore.findByToken(req.params.token);
  if (!eventItem) {
    res.status(404).render('errors/404', {
      title: 'Evenement introuvable',
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
      const extension = sanitizeFileExtension(file.originalname);
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
      if (!file.mimetype || !file.mimetype.startsWith('image/')) {
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
    .isLength({ min: 8, max: 72 }).withMessage('Le mot de passe doit contenir entre 8 et 72 caracteres.')
    .matches(/[a-z]/).withMessage('Le mot de passe doit contenir au moins une minuscule.')
    .matches(/[A-Z]/).withMessage('Le mot de passe doit contenir au moins une majuscule.')
    .matches(/[0-9]/).withMessage('Le mot de passe doit contenir au moins un chiffre.');

  return required ? chain : chain.optional({ values: 'falsy' });
}

const registrationValidators = [
  body('fullName')
    .trim()
    .isLength({ min: 2, max: 120 }).withMessage('Le nom complet doit contenir entre 2 et 120 caracteres.'),
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
    .isLength({ min: 2, max: 120 }).withMessage('Le nom complet doit contenir entre 2 et 120 caracteres.'),
  body('email')
    .trim()
    .isEmail().withMessage('Adresse email invalide.')
    .normalizeEmail(),
  body('role')
    .trim()
    .isIn(['user', 'admin']).withMessage('Role invalide.'),
  body('status')
    .trim()
    .isIn(['active', 'disabled']).withMessage('Statut invalide.'),
  passwordRules('password', false),
];

const profileValidators = [
  body('fullName')
    .trim()
    .isLength({ min: 2, max: 120 }).withMessage('Le nom complet doit contenir entre 2 et 120 caracteres.'),
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
    .isLength({ min: 3, max: 180 }).withMessage('Le nom de l\'evenement doit contenir entre 3 et 180 caracteres.'),
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
    .notEmpty().withMessage('La date/heure de l\'evenement est requise.')
    .isISO8601().withMessage('Format de date/heure invalide.'),
  body('status')
    .trim()
    .isIn(['active', 'inactive']).withMessage('Statut evenement invalide.'),
  body('theme')
    .optional({ values: 'falsy' })
    .trim()
    .isIn(EVENT_THEME_KEYS).withMessage('Theme evenement invalide.'),
  body('slideshowTransition')
    .optional({ values: 'falsy' })
    .trim()
    .isIn(EVENT_TRANSITION_KEYS).withMessage('Transition slideshow invalide.'),
  body('uploadSourceMode')
    .optional({ values: 'falsy' })
    .trim()
    .isIn(EVENT_UPLOAD_SOURCE_MODES).withMessage('Mode d\'upload invalide.'),
  body('uploadAllowMultiple')
    .optional({ values: 'falsy' })
    .isIn(['1', 'true', 'on']).withMessage('Option d\'upload multiple invalide.'),
  body('moderationEnabled')
    .optional({ values: 'falsy' })
    .isIn(['1', 'true', 'on']).withMessage('Option de moderation invalide.'),
];

const adminEventValidators = [
  ...eventValidators,
  body('ownerUserId')
    .trim()
    .isInt({ min: 1 }).withMessage('Proprietaire invalide.'),
];

const eventGuestRegistrationValidators = [
  body('guestName')
    .trim()
    .isLength({ min: 2, max: 120 }).withMessage('Le nom doit contenir entre 2 et 120 caracteres.'),
];

function toDateTimeLocal(value) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toISOString().slice(0, 16);
}

async function findOwnedEvent(userId, eventId) {
  const eventItem = await eventStore.findById(eventId);
  if (!eventItem || eventItem.ownerUserId !== Number(userId)) {
    return null;
  }

  return eventItem;
}

async function renderProfile(req, res, payload = {}, status = 200) {
  const events = await eventStore.listByOwner(req.currentUser.id);
  return renderView(res, 'profile', {
    title: 'Mon profil',
    pageClass: 'page-profile',
    userEvents: events,
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
    title: 'Evenement introuvable',
    pageClass: 'page-error',
  });
}

function renderProfileEventCreateForm(req, res, payload = {}, status = 200) {
  return renderView(res, 'profile-event-create', {
    title: 'Creer un evenement',
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
    title: 'Modifier evenement',
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
      title: 'Evenement introuvable',
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
      eventSiteNav: buildEventSiteNav(req.params.token, guestName, eventItem.name, eventItem.theme),
      renderedDescriptionHtml: renderEventDescriptionMarkdown(eventItem.description),
      nowIso: new Date().toISOString(),
      eventStartsAtIso: hasValidStartDate ? startsAtDate.toISOString() : null,
      shouldShowCountdown,
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/event/:token/upload', param('token').trim().matches(/^[A-Za-z0-9]{10}$/), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(404).render('errors/404', {
      title: 'Evenement introuvable',
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

    return renderView(res, 'event-upload', {
      title: `${eventItem.name} - Upload photos`,
      pageClass: buildEventPageClass(eventItem.theme),
      eventItem,
      guestName,
      eventSiteNav: buildEventSiteNav(req.params.token, guestName, eventItem.name, eventItem.theme),
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
      title: 'Evenement introuvable',
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
      eventSiteNav: buildEventSiteNav(req.params.token, guestName, eventItem.name, eventItem.theme),
      galleryFiles,
    });
  } catch (err) {
    return next(err);
  }
});

router.get(
  '/event/:token/media/:storedName/:variant(original|xl|md|sm)',
  [
    param('token').trim().matches(/^[A-Za-z0-9]{10}$/),
    param('storedName').trim().matches(/^[0-9a-f-]{36}\.[a-z0-9]{1,10}$/i),
  ],
  async (req, res, next) => {
    const result = validationResult(req);
    if (!result.isEmpty()) {
      return res.status(404).render('errors/404', {
        title: 'Evenement introuvable',
        pageClass: 'page-error',
      });
    }

    try {
      const eventItem = await eventStore.findByToken(req.params.token);
      if (!eventItem) {
        return res.status(404).render('errors/404', {
          title: 'Evenement introuvable',
          pageClass: 'page-error',
        });
      }

      const guestName = getEventGuestName(req, req.params.token);
      if (!guestName) {
        return res.status(403).render('errors/500', {
          title: 'Acces refuse',
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
    return res.status(404).json({ message: 'Evenement introuvable.' });
  }

  try {
    const eventItem = await eventStore.findByToken(req.params.token);
    if (!eventItem) {
      return res.status(404).json({ message: 'Evenement introuvable.' });
    }

    req.eventItem = eventItem;

    const guestName = getEventGuestName(req, req.params.token);
    if (!guestName) {
      return res.status(403).json({ message: 'Inscription visiteur requise avant upload.' });
    }

    const eventUploadMiddleware = createEventUploadMiddleware(eventItem.uploadAllowMultiple ? 10 : 1);

    return eventUploadMiddleware(req, res, async (uploadErr) => {
      if (uploadErr) {
        if (uploadErr.message === 'INVALID_FILE_TYPE') {
          return res.status(415).json({ message: 'Seules les images sont autorisees.' });
        }

        if (uploadErr.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ message: 'Un fichier depasse la taille maximale autorisee (10 Mo).' });
        }

        if (uploadErr.code === 'LIMIT_FILE_COUNT') {
          return res.status(413).json({ message: 'Trop de fichiers envoyes en une seule fois.' });
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
        return res.status(400).json({ message: 'Aucun fichier image recu.' });
      }

      try {
        const createdFiles = [];
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
            ? `${createdFiles.length} fichier(s) televerse(s) avec succes. Publication apres moderation.`
            : `${createdFiles.length} fichier(s) televerse(s) avec succes.`,
          files: createdFiles,
        });
      } catch (err) {
        if (uploadedFiles.length > 0) {
          await Promise.all(uploadedFiles.map((file) => fs.rm(file.path, { force: true })));
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
      title: 'Evenement introuvable',
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
      eventSiteNav: buildEventSiteNav(req.params.token, null, eventItem.name, eventItem.theme),
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
        eventSiteNav: buildEventSiteNav(req.params.token, req.body.guestName || '', eventItem.name, eventItem.theme),
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

    req.session.userId = user.id;
    logger.info(`[AUTH] Nouvelle inscription: ${user.email}`);
    req.flash('success', 'Votre compte a ete cree.');
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

    req.session.userId = user.id;
    await userStore.updateLastLogin(user.id);
    logger.info(`[AUTH] Connexion reussie: ${user.email}`);
    req.flash('success', 'Connexion reussie.');
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
    req.flash('success', 'Votre profil a ete mis a jour.');
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
    req.flash('success', 'Evenement cree avec succes.');
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
      title: `Slideshow - ${editingEvent.name}`,
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
      title: `Moderation - ${editingEvent.name}`,
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
        req.flash('error', 'Statut de moderation invalide.');
        return res.redirect(`/profile/event/${eventId}/moderation`);
      }

      const editingEvent = await findOwnedEvent(req.currentUser.id, eventId);
      if (!editingEvent) {
        return renderEventNotFound(res);
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
        ? 'Photo approuvee et visible sur le slideshow.'
        : (moderationStatus === 'rejected' ? 'Photo rejetee.' : 'Photo remise en attente.'));
      return res.redirect(`/profile/event/${eventId}/moderation`);
    } catch (err) {
      return next(err);
    }
  },
);

router.get(
  '/profile/events/:id/photos/:storedName/:variant(original|xl|md|sm)',
  [
    requireAuth,
    param('id').isInt({ min: 1 }),
    param('storedName').trim().matches(/^[0-9a-f-]{36}\.[a-z0-9]{1,10}$/i),
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
      ? `Evenement mis a jour. ${autoApprovedCount} photo(s) en attente ont ete automatiquement approuvees.`
      : 'Evenement mis a jour.');
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

    if (editingEvent.status !== 'active') {
      await eventStore.updateEvent(eventId, { status: 'active' });
      logger.info(`[EVENT] ${req.currentUser.email} a active son evenement ${editingEvent.uuid}`);
      req.flash('success', 'Evenement active.');
    } else {
      req.flash('success', 'Evenement deja actif.');
    }

    return res.redirect('/profile');
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

    const newToken = await eventStore.generateUniqueToken();
    await eventStore.updateEvent(eventId, { token: newToken });

    logger.info(`[EVENT] ${req.currentUser.email} a regenere le token de ${editingEvent.uuid}`);
    req.flash('success', 'Token regenere avec succes.');
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
    req.flash('success', 'Evenement supprime.');
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

router.get('/admin/events/new', requireAdmin, async (req, res, next) => {
  try {
    const users = await userStore.listUsers();
    return renderView(res, 'admin/event-form', {
      title: 'Nouvel evenement',
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
        title: 'Nouvel evenement',
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
    req.flash('success', 'Evenement cree avec succes.');
    return res.redirect('/admin');
  } catch (err) {
    return next(err);
  }
});

router.get('/admin/events/:id/edit', requireAdmin, param('id').isInt({ min: 1 }), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(404).render('errors/404', {
      title: 'Evenement introuvable',
      pageClass: 'page-error',
    });
  }

  try {
    const editingEvent = await eventStore.findById(Number(req.params.id));
    if (!editingEvent) {
      return res.status(404).render('errors/404', {
        title: 'Evenement introuvable',
        pageClass: 'page-error',
      });
    }

    const users = await userStore.listUsers();
    const eventFiles = await eventFileStore.listByEvent(editingEvent.id);
    return renderView(res, 'admin/event-form', {
      title: 'Modifier evenement',
      pageClass: 'page-admin',
      mode: 'edit',
      users,
      eventFiles,
      editingEvent,
      formData: normalizeEventFormData({
        ...editingEvent,
        startsAt: new Date(editingEvent.startsAt).toISOString().slice(0, 16),
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
        title: 'Modifier evenement',
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
        title: 'Evenement introuvable',
        pageClass: 'page-error',
      });
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
        title: 'Evenement introuvable',
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
      ? `Evenement mis a jour. ${autoApprovedCount} photo(s) en attente ont ete automatiquement approuvees.`
      : 'Evenement mis a jour.');
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

    const newToken = await eventStore.generateUniqueToken();
    await eventStore.updateEvent(eventId, { token: newToken });

    logger.info(`[ADMIN] ${req.currentUser.email} a regenere le token de l'evenement ${editingEvent.uuid}`);
    req.flash('success', 'Token regenere avec succes.');
    return res.redirect(`/admin/events/${eventId}/edit`);
  } catch (err) {
    return next(err);
  }
});

router.delete('/admin/events/:id', requireAdmin, param('id').isInt({ min: 1 }), async (req, res, next) => {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return res.status(404).render('errors/404', {
      title: 'Evenement introuvable',
      pageClass: 'page-error',
    });
  }

  try {
    await eventStore.deleteEvent(Number(req.params.id));
    logger.info(`[ADMIN] ${req.currentUser.email} a supprime l'evenement #${req.params.id}`);
    req.flash('success', 'Evenement supprime.');
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
    req.flash('success', 'Utilisateur cree avec succes.');
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
      title: 'Modifier un utilisateur',
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
      title: 'Modifier un utilisateur',
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
      req.flash('error', 'Vous ne pouvez pas retirer votre propre role administrateur.');
      return res.redirect(`/admin/users/${targetUser.id}/edit`);
    }

    if (targetUser.id === req.currentUser.id && req.body.status !== 'active') {
      req.flash('error', 'Vous ne pouvez pas desactiver votre propre compte.');
      return res.redirect(`/admin/users/${targetUser.id}/edit`);
    }

    if (targetUser.role === 'admin' && targetUser.status === 'active') {
      const remainingAdmins = await userStore.countActiveAdmins(targetUser.id);
      if ((req.body.role !== 'admin' || req.body.status !== 'active') && remainingAdmins === 0) {
        req.flash('error', 'Au moins un administrateur actif doit etre conserve.');
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
    req.flash('success', 'Utilisateur mis a jour.');
    return res.redirect('/admin');
  } catch (err) {
    if (err.code === 'EMAIL_ALREADY_EXISTS') {
      const editingUser = await userStore.findPublicById(userId);
      const userEvents = editingUser ? await eventStore.listByOwner(editingUser.id) : [];
      return renderView(res, 'admin/user-form', {
        title: 'Modifier un utilisateur',
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
        req.flash('error', 'Au moins un administrateur actif doit etre conserve.');
        return res.redirect('/admin');
      }
    }

    await userStore.deleteUser(targetUser.id);
    logger.info(`[ADMIN] ${req.currentUser.email} a supprime l'utilisateur ${targetUser.email}`);
    req.flash('success', 'Utilisateur supprime.');
    return res.redirect('/admin');
  } catch (err) {
    return next(err);
  }
});

router.get(
  '/admin/events/:id/photos/:storedName/:variant(original|xl|md|sm)',
  [
    requireAdmin,
    param('id').isInt({ min: 1 }),
    param('storedName').trim().matches(/^[0-9a-f-]{36}\.[a-z0-9]{1,10}$/i),
  ],
  async (req, res, next) => {
    const result = validationResult(req);
    if (!result.isEmpty()) {
      return res.status(404).render('errors/404', {
        title: 'Evenement introuvable',
        pageClass: 'page-error',
      });
    }

    try {
      const eventItem = await eventStore.findById(Number(req.params.id));
      if (!eventItem) {
        return res.status(404).render('errors/404', {
          title: 'Evenement introuvable',
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
