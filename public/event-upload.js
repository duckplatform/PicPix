(function initEventUploadPage() {
  const dropzoneHost = document.getElementById('dropzone-uploader');
  if (!dropzoneHost || typeof window.Dropzone === 'undefined') {
    return;
  }

  window.Dropzone.autoDiscover = false;

  const csrfInput = document.getElementById('upload-csrf');
  const endpointInput = document.getElementById('upload-endpoint');
  const sourceModeInput = document.getElementById('upload-source-mode');
  const allowMultipleInput = document.getElementById('upload-allow-multiple');
  const feedback = document.getElementById('upload-feedback');
  const sourceMode = sourceModeInput ? sourceModeInput.value : 'default';
  const allowMultiple = !allowMultipleInput || allowMultipleInput.value === '1';
  const isCameraOnly = sourceMode === 'camera_only';
  const isLibraryOnly = sourceMode === 'library_only';

  let dashboardNote = 'Images uniquement, 10 Mo max par fichier.';
  if (isCameraOnly) {
    dashboardNote += ' Mode caméra uniquement.';
  } else if (isLibraryOnly) {
    dashboardNote += ' Mode photothèque uniquement.';
  }

  dashboardNote += allowMultiple
    ? ' Plusieurs photos à la suite autorisées.'
    : ' Une seule photo à la fois.';

  const dropzoneMessage = '<strong class="dz-title">Touchez pour choisir des photos</strong>'
    + '<small class="dz-note">' + dashboardNote + '</small>';

  function renderMessage(message, type) {
    feedback.innerHTML = `<div class="alert alert-${type}">${message}</div>`;
  }

  // Dropzone n'insere son message par defaut que sur un element de classe
  // "dropzone" : on l'ajoute nous-memes (masque via .dz-started des le 1er ajout).
  if (!dropzoneHost.querySelector('.dz-message')) {
    const messageEl = document.createElement('div');
    messageEl.className = 'dz-message';
    messageEl.innerHTML = '<span class="dz-button">' + dropzoneMessage + '</span>';
    dropzoneHost.prepend(messageEl);
  }

  const dropzone = new window.Dropzone(dropzoneHost, {
    url: endpointInput.value,
    autoProcessQueue: true,
    uploadMultiple: allowMultiple,
    parallelUploads: allowMultiple ? 10 : 1,
    maxFiles: allowMultiple ? 10 : 1,
    maxFilesize: 10,
    acceptedFiles: 'image/*',
    paramName: 'photos',
    clickable: true,
    addRemoveLinks: true,
    dictDefaultMessage: dropzoneMessage,
    dictRemoveFile: 'Retirer',
    headers: {
      'x-csrf-token': csrfInput.value,
    },
    init: function initDropzone() {
      const hiddenInput = this.hiddenFileInput;
      if (!hiddenInput) {
        return;
      }

      hiddenInput.setAttribute('accept', 'image/*');

      if (allowMultiple) {
        hiddenInput.setAttribute('multiple', 'multiple');
      } else {
        hiddenInput.removeAttribute('multiple');
      }

      if (isCameraOnly) {
        hiddenInput.setAttribute('capture', 'environment');
      } else {
        hiddenInput.removeAttribute('capture');
      }
    },
  });

  dropzone.on('error', function onError(file, message) {
    const text = typeof message === 'string' ? message : (message && message.message) || `Échec de l'envoi de ${file.name}.`;
    renderMessage(text, 'error');
  });

  dropzone.on('success', function onSuccess(file, response) {
    renderMessage((response && response.message) || `Photo envoyée : ${file.name}`, 'success');
  });

  dropzone.on('successmultiple', function onSuccessMultiple(files, response) {
    if (!response || !Array.isArray(response.files)) {
      return;
    }

    renderMessage((response && response.message) || `${files.length} photo(s) envoyée(s).`, 'success');
  });

  dropzone.on('maxfilesexceeded', function onMaxExceeded(file) {
    dropzone.removeFile(file);
    renderMessage('Trop de fichiers sélectionnés pour cet événement.', 'error');
  });

  // Expose l'instance pour camera.js
  window.dropzoneInstance = dropzone;
}());
