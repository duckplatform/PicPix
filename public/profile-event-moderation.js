(function initProfileEventModeration() {
  'use strict';

  const shell = document.getElementById('moderation-shell');
  if (!shell) {
    return;
  }

  const eventId = Number.parseInt(shell.dataset.eventId || '', 10);
  if (!Number.isInteger(eventId) || eventId <= 0) {
    return;
  }

  const grid = document.getElementById('moderation-pending-grid');
  const emptyState = document.getElementById('moderation-empty');

  if (!grid || !emptyState) {
    return;
  }

  // 🔑 Stocker le token CSRF initial en variable globale (pas juste dans le DOM)
  let currentCsrfToken = '';
  
  // Extraire le token du premier formulaire au démarrage
  const initialForm = grid.querySelector('.js-moderation-action-form');
  if (initialForm) {
    const csrfInput = initialForm.querySelector('input[name="_csrf"]');
    if (csrfInput && csrfInput.value) {
      currentCsrfToken = csrfInput.value;
    }
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDate(dateStr) {
    if (!dateStr) {
      return '';
    }

    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) {
      return '';
    }

    return date.toLocaleString('fr-FR');
  }

  function syncEmptyState() {
    const hasCards = Boolean(grid.querySelector('[data-file-id]'));
    grid.hidden = !hasCards;
    emptyState.hidden = hasCards;
  }

  function findCardByPayload(payload) {
    if (!payload) {
      return null;
    }

    if (payload.fileId) {
      const byId = grid.querySelector('[data-file-id="' + String(payload.fileId) + '"]');
      if (byId) {
        return byId;
      }
    }

    if (payload.storedName) {
      return grid.querySelector('[data-stored-name="' + String(payload.storedName) + '"]');
    }

    return null;
  }

  function removeCard(payload) {
    const card = findCardByPayload(payload);
    if (!card) {
      return;
    }

    card.remove();
    syncEmptyState();
  }

  function buildActionForm(actionUrl, fileId, csrfToken, moderationStatus) {
    const isReject = moderationStatus === 'rejected';
    const iconPath = isReject
      ? 'm18.3 7.11-1.41-1.41L12 10.59 7.11 5.7 5.7 7.11 10.59 12 5.7 16.89l1.41 1.41L12 13.41l4.89 4.89 1.41-1.41L13.41 12z'
      : 'M9.55 18.2 3.9 12.56l1.42-1.42 4.23 4.24 9.13-9.14 1.42 1.42z';
    const label = isReject ? 'Rejeter la photo' : 'Approuver la photo';
    const buttonClass = isReject ? 'moderation-icon-btn moderation-icon-btn-reject' : 'moderation-icon-btn moderation-icon-btn-approve';

    return ''
      + '<form method="post" action="' + escapeHtml(actionUrl) + '" class="inline-form js-moderation-action-form" data-file-id="' + String(fileId) + '">'
      + '<input type="hidden" name="_csrf" value="' + escapeHtml(csrfToken) + '" />'
      + '<input type="hidden" name="moderationStatus" value="' + escapeHtml(moderationStatus) + '" />'
      + '<button class="' + buttonClass + '" type="submit" title="' + escapeHtml(label) + '" aria-label="' + escapeHtml(label) + '">'
      + '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="' + iconPath + '" /></svg>'
      + '</button>'
      + '</form>';
  }

  function createCard(payload) {
    const actionUrlBase = '/profile/event/' + String(eventId) + '/moderation/' + String(payload.fileId);
    const imageUrl = (payload.urls && (payload.urls.sm || payload.urls.md || payload.urls.original))
      || ('/profile/events/' + String(eventId) + '/photos/' + String(payload.storedName) + '/sm');
    const originalUrl = (payload.urls && payload.urls.original)
      || ('/profile/events/' + String(eventId) + '/photos/' + String(payload.storedName) + '/original');

    // 🔑 Utiliser le token GLOBAL persistant, pas un token cherché dans le DOM
    const csrfToken = currentCsrfToken;

    const article = document.createElement('article');
    article.className = 'event-gallery-card';
    article.setAttribute('data-file-id', String(payload.fileId));
    article.setAttribute('data-stored-name', String(payload.storedName));

    const uploaderName = payload.uploaderName || 'Visiteur';

    article.innerHTML = ''
      + '<a href="' + escapeHtml(originalUrl) + '" target="_blank" rel="noopener noreferrer">'
      + '<img src="' + escapeHtml(imageUrl) + '" alt="' + escapeHtml(payload.originalName || payload.storedName) + '" loading="lazy" />'
      + '</a>'
      + '<div class="event-gallery-meta">'
      + '<strong>' + escapeHtml(payload.originalName || payload.storedName) + '</strong>'
      + '<small>En attente d\'approbation</small>'
      + '<small>Par ' + escapeHtml(uploaderName) + ' · ' + escapeHtml(formatDate(payload.uploadedAt)) + '</small>'
      + '</div>'
      + '<div class="table-actions moderation-actions">'
      + buildActionForm(actionUrlBase, payload.fileId, csrfToken, 'approved')
      + buildActionForm(actionUrlBase, payload.fileId, csrfToken, 'rejected')
      + '</div>';

    const imageEl = article.querySelector('img');
    if (imageEl) {
      imageEl.onerror = function onImageError() {
        imageEl.onerror = null;
        imageEl.src = originalUrl;
      };
    }

    return article;
  }

  function upsertPendingCard(payload) {
    if (!payload || Number(payload.eventId) !== eventId) {
      return;
    }

    if (payload.moderationStatus && payload.moderationStatus !== 'pending') {
      removeCard(payload);
      return;
    }

    const existing = findCardByPayload(payload);
    if (existing) {
      return;
    }

    const card = createCard(payload);
    grid.prepend(card);
    syncEmptyState();
  }

  function submitActionForm(form) {
    // 1️⃣ Récupérer un token CSRF FRAIS avant de soumettre
    return fetch('/profile/event/' + String(eventId) + '/moderation/csrf-token', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    }).then(function onTokenResponse(response) {
      if (!response.ok) {
        // Fallback: utiliser le token courant même s'il pourrait être expiré
        console.warn('[Moderation] Impossible de rafraîchir le token CSRF, utilisation du token courant');
        return { csrfToken: currentCsrfToken };
      }

      return response.json();
    }).then(function onTokenData(tokenData) {
      // 2️⃣ Mettre à jour le token GLOBAL ET dans le formulaire
      if (tokenData.csrfToken) {
        currentCsrfToken = tokenData.csrfToken;
        const csrfInput = form.querySelector('input[name="_csrf"]');
        if (csrfInput) {
          csrfInput.value = tokenData.csrfToken;
        }
      }

      // 3️⃣ Soumettre le formulaire avec le token frais
      const formData = new FormData(form);

      return fetch(form.action, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: formData,
      });
    }).then(function onResponse(response) {
      if (!response.ok) {
        throw new Error('La moderation a echoue.');
      }

      return response.json();
    }).then(function onJson(payload) {
      removeCard({ fileId: form.getAttribute('data-file-id') });
      return payload;
    }).catch(function onError(error) {
      // Fallback robuste: submit HTML classique si la requête AJAX échoue.
      console.warn('[Moderation] AJAX fallback:', error.message);
      form.submit();
    });
  }

  document.addEventListener('submit', function onSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.classList.contains('js-moderation-action-form')) {
      return;
    }

    event.preventDefault();
    void submitActionForm(form);
  });

  if (typeof window.io === 'function') {
    const socket = window.io({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
    });

    socket.emit('moderation:join', { eventId: eventId });

    socket.on('moderation:pending-photo', function onPendingPhoto(payload) {
      upsertPendingCard(payload);
    });

    socket.on('moderation:photo-reviewed', function onReviewed(payload) {
      if (!payload || Number(payload.eventId) !== eventId) {
        return;
      }

      removeCard(payload);
    });
  }

  syncEmptyState();
}());
