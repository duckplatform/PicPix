(function initProfileEventClose() {
  'use strict';

  // ── Popup de confirmation de cloture definitive ─────────────────────────────

  const modal = document.getElementById('close-event-modal');
  const form = document.getElementById('close-event-form');
  const nameEl = document.getElementById('close-event-modal-name');
  const confirmInput = document.getElementById('close-event-confirm-input');
  const submitBtn = document.getElementById('close-event-submit');
  const cancelBtn = document.getElementById('close-event-cancel');

  // Etat "bloque" : des photos attendent encore la moderation.
  const blockedEl = document.getElementById('close-event-blocked');
  const pendingCountEl = document.getElementById('close-event-pending-count');
  const moderationLink = document.getElementById('close-event-moderation-link');
  const consequencesEl = document.getElementById('close-event-consequences');
  const irreversibleNote = document.getElementById('close-event-irreversible-note');

  // Mot-cle attendu : doit correspondre a la verification serveur.
  const CONFIRM_KEYWORD = 'CLOTURER';

  let lastTrigger = null;

  /**
   * Bascule la popup entre le formulaire de confirmation et l'ecran de blocage.
   * Le serveur refuse de toute facon une cloture avec des photos en attente :
   * cet ecran evite simplement a l'organisateur un aller-retour inutile.
   */
  function applyBlockedState(pendingCount) {
    const isBlocked = pendingCount > 0;

    blockedEl.toggleAttribute('hidden', !isBlocked);
    form.toggleAttribute('hidden', isBlocked);
    consequencesEl.toggleAttribute('hidden', isBlocked);
    irreversibleNote.toggleAttribute('hidden', isBlocked);

    if (isBlocked) {
      pendingCountEl.textContent = pendingCount + ' photo' + (pendingCount > 1 ? 's' : '');
    }

    return isBlocked;
  }

  function closeModal() {
    if (!modal) {
      return;
    }

    modal.setAttribute('hidden', '');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    confirmInput.value = '';
    submitBtn.disabled = true;

    if (lastTrigger) {
      lastTrigger.focus();
      lastTrigger = null;
    }
  }

  function openModal(trigger) {
    if (!modal) {
      return;
    }

    const eventId = trigger.dataset.eventId;
    const pendingCount = Number(trigger.dataset.pendingCount || 0);

    lastTrigger = trigger;
    form.action = '/profile/events/' + eventId + '/close';
    moderationLink.href = '/profile/event/' + eventId + '/moderation';
    nameEl.textContent = trigger.dataset.eventName || 'cet evenement';
    confirmInput.value = '';
    submitBtn.disabled = true;

    const isBlocked = applyBlockedState(pendingCount);

    modal.removeAttribute('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    if (!isBlocked) {
      confirmInput.focus();
    }
  }

  if (modal && form && confirmInput && submitBtn && blockedEl && consequencesEl && irreversibleNote) {
    document.querySelectorAll('[data-close-event-trigger]').forEach(function bind(trigger) {
      trigger.addEventListener('click', function onClick() {
        openModal(trigger);
      });
    });

    // Le bouton ne s'active que lorsque le mot-cle est saisi exactement.
    confirmInput.addEventListener('input', function onInput() {
      submitBtn.disabled = confirmInput.value.trim() !== CONFIRM_KEYWORD;
    });

    form.addEventListener('submit', function onSubmit(e) {
      if (confirmInput.value.trim() !== CONFIRM_KEYWORD) {
        e.preventDefault();
        return;
      }

      // Evite un double envoi si l'utilisateur clique deux fois.
      submitBtn.disabled = true;
      submitBtn.textContent = 'Cloture en cours…';
    });

    cancelBtn.addEventListener('click', closeModal);

    document.querySelectorAll('[data-close-event-dismiss]').forEach(function bindDismiss(btn) {
      btn.addEventListener('click', closeModal);
    });

    modal.addEventListener('click', function onBackdropClick(e) {
      if (e.target === modal) {
        closeModal();
      }
    });

    document.addEventListener('keydown', function onKeyDown(e) {
      if (e.key === 'Escape' && !modal.hasAttribute('hidden')) {
        closeModal();
      }
    });
  }

  // ── Suivi de la generation de l'archive ZIP ─────────────────────────────────
  //
  // Tant que le ZIP n'est pas ecrit, le dashboard affiche un message d'attente.
  // On interroge l'API jusqu'a ce que l'archive soit prete (ou en echec), puis
  // on remplace le message par le lien de telechargement, sans rechargement.

  const POLL_INTERVAL_MS = 5000;
  const MAX_POLL_ATTEMPTS = 360; // ~30 minutes, largement suffisant

  function formatSize(sizeBytes) {
    if (!sizeBytes) {
      return null;
    }

    return (sizeBytes / (1024 * 1024)).toFixed(1) + ' Mo';
  }

  function renderReady(cell, payload) {
    const link = document.createElement('a');
    link.className = 'btn btn-small';
    link.href = payload.downloadUrl;
    link.textContent = 'Telecharger le ZIP';

    const meta = document.createElement('small');
    meta.className = 'muted-note';
    const size = formatSize(payload.sizeBytes);
    meta.textContent = (payload.photoCount || 0) + ' photo(s)' + (size ? ' · ' + size : '');

    cell.textContent = '';
    cell.appendChild(link);
    cell.appendChild(meta);
    cell.dataset.archiveStatus = 'ready';
  }

  function renderFailed(cell) {
    const message = document.createElement('span');
    message.className = 'archive-failed';
    message.textContent = 'La generation de l\'archive a echoue. Contactez un administrateur.';

    cell.textContent = '';
    cell.appendChild(message);
    cell.dataset.archiveStatus = 'failed';
  }

  function watchArchive(cell) {
    const eventId = cell.dataset.eventId;
    let attempts = 0;

    const timer = setInterval(async function poll() {
      attempts += 1;
      if (attempts > MAX_POLL_ATTEMPTS) {
        clearInterval(timer);
        return;
      }

      try {
        const response = await fetch('/profile/events/' + eventId + '/archive/status', {
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        });

        if (!response.ok) {
          return;
        }

        const payload = await response.json();

        if (payload.status === 'ready' && payload.downloadUrl) {
          clearInterval(timer);
          renderReady(cell, payload);
          return;
        }

        if (payload.status === 'failed') {
          clearInterval(timer);
          renderFailed(cell);
        }
      } catch (err) {
        // Perte reseau passagere : on retentera au prochain tick.
      }
    }, POLL_INTERVAL_MS);
  }

  document.querySelectorAll('[data-archive-cell]').forEach(function bindCell(cell) {
    if (cell.dataset.archiveStatus === 'pending') {
      watchArchive(cell);
    }
  });
}());
