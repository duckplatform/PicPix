(function initProfileEventSlideshow() {
  'use strict';

  const shell = document.getElementById('slideshow-shell');
  if (!shell) {
    return;
  }

  const waitingEl = document.getElementById('slideshow-waiting');
  const figureEl = document.getElementById('slideshow-figure');
  const imageEl = document.getElementById('slideshow-image');
  const captionEl = document.getElementById('slideshow-caption');

  const eventId = Number.parseInt(shell.dataset.eventId || '', 10);
  if (!Number.isInteger(eventId) || eventId <= 0) {
    return;
  }

  const transitionMode = (shell.dataset.transition || 'fade').toLowerCase();

  let initialPhotos = [];
  try {
    initialPhotos = JSON.parse(shell.dataset.initialPhotos || '[]');
  } catch {
    initialPhotos = [];
  }

  const MIN_DISPLAY_MS = 5000;
  const allPhotos = [];
  const knownNames = new Set();
  const pendingNewPhotos = [];
  let currentPhoto = null;
  let loopTimer = null;

  function photoFromStoredName(storedName, originalName, uploaderName, uploadedAt) {
    return {
      storedName,
      originalName: originalName || storedName,
      uploaderName: uploaderName || null,
      uploadedAt: uploadedAt || null,
      url: '/profile/events/' + eventId + '/photos/' + storedName + '/md',
      fallbackUrl: '/profile/events/' + eventId + '/photos/' + storedName + '/original',
    };
  }

  function addPhoto(storedName, originalName, isNew, uploaderName, uploadedAt) {
    if (!storedName || knownNames.has(storedName)) {
      return;
    }

    const photo = photoFromStoredName(storedName, originalName, uploaderName, uploadedAt);
    allPhotos.push(photo);
    knownNames.add(storedName);

    if (isNew) {
      pendingNewPhotos.push(photo);
    }
  }

  /** Formate le temps écoulé depuis une date ISO en français. */
  function formatElapsed(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return 'il y a ' + secs + 's';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return 'il y a ' + mins + 'min';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return 'il y a ' + hours + 'h';
    const days = Math.floor(hours / 24);
    return 'il y a ' + days + 'j';
  }

  function buildCaption(photo) {
    const parts = [];
    if (photo.uploaderName) {
      parts.push(photo.uploaderName);
    }
    if (photo.uploadedAt) {
      parts.push(formatElapsed(photo.uploadedAt));
    }
    return parts.join(' · ');
  }

  function setWaitingState() {
    if (waitingEl) {
      waitingEl.hidden = false;
    }
    if (figureEl) {
      figureEl.hidden = true;
    }
  }

  const TRANSITION_PRESETS = {
    fade: { duration: 700, outClass: 'slideshow-out-fade', inStartClass: 'slideshow-in-fade-start' },
    slide: { duration: 780, outClass: 'slideshow-out-slide', inStartClass: 'slideshow-in-slide-start' },
    zoom: { duration: 820, outClass: 'slideshow-out-zoom', inStartClass: 'slideshow-in-zoom-start' },
    cut: { duration: 0, outClass: '', inStartClass: '' },
  };

  const transitionPreset = TRANSITION_PRESETS[transitionMode] || TRANSITION_PRESETS.fade;

  function clearTransitionClasses() {
    imageEl.classList.remove(
      'slideshow-out-fade',
      'slideshow-out-slide',
      'slideshow-out-zoom',
      'slideshow-in-fade-start',
      'slideshow-in-slide-start',
      'slideshow-in-zoom-start',
    );
  }

  // Evite que des styles inline (opacity/transform) bloquent les classes CSS de transition.
  function clearInlineTransitionStyles() {
    imageEl.style.opacity = '';
    imageEl.style.transform = '';
  }

  /** Précharge une image, tente le fallback en cas d'erreur, appelle cb(srcUtilisé). */
  function preloadImage(url, fallbackUrl, cb) {
    const img = new Image();
    img.onload = function () { cb(img.src); };
    img.onerror = function () {
      const fb = new Image();
      fb.onload = function () { cb(fb.src); };
      fb.onerror = function () { cb(url); }; // afficher quand même (image cassée)
      fb.src = fallbackUrl;
    };
    img.src = url;
  }

  /** Applique la source/légende et déclenche la transition entrante selon le mode. */
  function fadeIn(photo, src) {
    clearTransitionClasses();
    clearInlineTransitionStyles();

    if (transitionPreset.inStartClass) {
      imageEl.classList.add(transitionPreset.inStartClass);
    }

    imageEl.src = src;
    imageEl.alt = photo.originalName || 'Photo evenement';
    imageEl.onerror = null;
    if (captionEl) {
      captionEl.textContent = buildCaption(photo);
    }

    if (transitionPreset.duration === 0) {
      clearTransitionClasses();
      clearInlineTransitionStyles();
      return;
    }

    // Double rAF : s'assure que l'état de départ est peint avant la transition entrante.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        clearTransitionClasses();
      });
    });
  }

  /**
   * Crossfade vers la nouvelle photo.
   * - Si la figure était cachée (display:none) → le navigateur ignore les transitions au
   *   moment du changement display. On laisse un rAF s'écouler avant de charger l'image.
  * - Si une photo était déjà affichée → on attend la fin de la transition sortante
   *   avant de swapper la source, garantissant qu'il n'y a jamais de saut visuel.
   */
  function setDisplayState(photo) {
    if (waitingEl) {
      waitingEl.hidden = true;
    }

    const wasHidden = figureEl ? figureEl.hidden : false;

    if (figureEl) {
      figureEl.hidden = false;
    }

    clearTransitionClasses();
    clearInlineTransitionStyles();

    if (transitionPreset.duration === 0) {
      preloadImage(photo.url, photo.fallbackUrl, function (src) {
        fadeIn(photo, src);
      });
      return;
    }

    if (wasHidden) {
      // La figure vient d'être rendue visible : imposer opacity:0 dans ce même frame
      // puis laisser le navigateur peindre avant de charger l'image et faire l'entrée.
      if (transitionPreset.inStartClass) {
        imageEl.classList.add(transitionPreset.inStartClass);
      }
      requestAnimationFrame(function () {
        preloadImage(photo.url, photo.fallbackUrl, function (src) {
          fadeIn(photo, src);
        });
      });
    } else {
      // Une photo était déjà visible : transition sortante d'abord, swap ensuite.
      if (transitionPreset.outClass) {
        imageEl.classList.add(transitionPreset.outClass);
      }
      setTimeout(function () {
        preloadImage(photo.url, photo.fallbackUrl, function (src) {
          fadeIn(photo, src);
        });
      }, transitionPreset.duration);
    }
  }

  function pickRandomPhoto() {
    if (allPhotos.length === 0) {
      return null;
    }

    if (allPhotos.length === 1) {
      return allPhotos[0];
    }

    let candidate = allPhotos[Math.floor(Math.random() * allPhotos.length)];
    if (currentPhoto && candidate.storedName === currentPhoto.storedName) {
      const fallbackCandidates = allPhotos.filter(function filterItem(item) {
        return item.storedName !== currentPhoto.storedName;
      });
      candidate = fallbackCandidates[Math.floor(Math.random() * fallbackCandidates.length)];
    }

    return candidate;
  }

  function chooseNextPhoto() {
    if (pendingNewPhotos.length > 0) {
      return pendingNewPhotos.shift();
    }

    return pickRandomPhoto();
  }

  function scheduleNextTick() {
    if (loopTimer) {
      clearTimeout(loopTimer);
    }

    loopTimer = setTimeout(function onTick() {
      runLoop();
    }, MIN_DISPLAY_MS);
  }

  function runLoop() {
    const nextPhoto = chooseNextPhoto();
    if (!nextPhoto) {
      currentPhoto = null;
      setWaitingState();
      scheduleNextTick();
      return;
    }

    currentPhoto = nextPhoto;
    setDisplayState(nextPhoto);
    scheduleNextTick();
  }

  // Evenement pas encore ouvert : compte a rebours (ou attente), aucune photo.
  const eventStatus = shell.dataset.status || 'active';
  const startsAtIso = shell.dataset.startsAt || '';
  const isNotStarted = eventStatus === 'inactive';

  function formatRemaining(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const clock = String(hours).padStart(2, '0') + ':'
      + String(minutes).padStart(2, '0') + ':'
      + String(seconds).padStart(2, '0');

    return days > 0 ? days + 'j ' + clock : clock;
  }

  function startCountdown() {
    const countdownEl = document.getElementById('slideshow-countdown-value');
    const startsAt = new Date(startsAtIso);
    // Decalage horloge serveur/ecran : sans lui, un ecran en avance
    // rechargerait la page en boucle alors que le serveur attend encore.
    const clockOffset = new Date(shell.dataset.now).getTime() - Date.now();

    function tick() {
      const diff = startsAt.getTime() - (Date.now() + clockOffset);

      // Heure atteinte : le serveur decide (direct si l'evenement est active,
      // sinon message d'attente jusqu'a l'activation, recue par socket).
      if (diff <= 0) {
        window.location.reload();
        return;
      }

      countdownEl.textContent = formatRemaining(diff);
      setTimeout(tick, 1000);
    }

    tick();
  }

  /** Ajoute en priorite les photos approuvees que le diaporama ne connait pas. */
  function catchUpMissedPhotos() {
    fetch('/profile/events/' + eventId + '/slideshow/photos', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
      .then(function parse(response) {
        return response.ok ? response.json() : null;
      })
      .then(function addMissing(data) {
        if (!data || !Array.isArray(data.photos)) {
          return;
        }

        data.photos.forEach(function addItem(item) {
          addPhoto(item.storedName, item.originalName, true, item.uploaderName, item.uploadedAt);
        });

        if (!currentPhoto) {
          runLoop();
        }
      })
      .catch(function ignore() {
        // Session expiree ou reseau instable : la prochaine reconnexion reessaiera.
      });
  }

  initialPhotos.forEach(function seedPhoto(item) {
    addPhoto(item.storedName, item.originalName, false, item.uploaderName, item.uploadedAt);
  });

  if (typeof window.io === 'function') {
    // Transports par defaut : polling HTTP, puis WebSocket seulement si le
    // serveur l'annonce (cf. config/realtime.js).
    const socket = window.io({ path: '/socket.io' });

    let hasConnectedOnce = false;

    // (Re)joindre la salle a chaque connexion : apres une coupure, la
    // nouvelle socket n'appartient plus a aucune salle.
    socket.on('connect', function onConnect() {
      socket.emit('slideshow:join', { eventId: eventId });

      // Reconnexion : les photos approuvees pendant la coupure n'ont pas
      // ete poussees, on les rattrape.
      if (hasConnectedOnce && !isNotStarted) {
        catchUpMissedPhotos();
      }
      hasConnectedOnce = true;
    });

    socket.on('slideshow:new-photo', function onNewPhoto(payload) {
      if (!payload || Number(payload.eventId) !== eventId || isNotStarted) {
        return;
      }

      addPhoto(payload.storedName, payload.originalName, true, payload.uploaderName, payload.uploadedAt);

      // Si le slideshow est en attente, on démarre immédiatement l'affichage.
      if (!currentPhoto) {
        runLoop();
      }
    });

    // Activation par l'organisateur ou heure de debut modifiee : l'ecran
    // projete bascule sans intervention.
    socket.on('slideshow:event-updated', function onEventUpdated(payload) {
      if (!payload || Number(payload.eventId) !== eventId) {
        return;
      }

      if (payload.status !== eventStatus || (payload.startsAt || '') !== startsAtIso) {
        window.location.reload();
      }
    });
  }

  if (isNotStarted) {
    if (shell.dataset.showCountdown === '1') {
      startCountdown();
    }
    return;
  }

  runLoop();
}());
