'use strict';

/**
 * QR code du lien invite et affiche PDF (A4) a imprimer par l'organisateur.
 *
 * L'affiche reprend la palette du theme de l'evenement (memes jetons que
 * public/styles.css) et ajoute quelques motifs decoratifs propres au theme.
 * Le QR code est dessine en vectoriel pour rester net a l'impression, sur un
 * fond clair quel que soit le theme afin de garantir la lecture.
 */

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const eventThemes = require('../config/eventThemes');
const { APP_TIMEZONE } = require('../config/timezone');

const QR_OPTIONS = { errorCorrectionLevel: 'M' };

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const CONTENT_MARGIN = 56;

const POSTER_THEMES = {
  classic: {
    kicker: 'Partagez vos photos',
    bg: '#f4efe7', surface: '#fffdf9', text: '#1c1814', muted: '#6b6158',
    accent: '#d9472b', accent2: '#e0a23a', onAccent: '#ffffff', motif: 'sparkle',
  },
  wedding: {
    kicker: 'Le livre photo des invités',
    bg: '#fbf3f1', surface: '#fffcfb', text: '#2b1a1e', muted: '#74585e',
    accent: '#a3324f', accent2: '#d99a7e', onAccent: '#ffffff', motif: 'heart',
  },
  gaming: {
    kicker: 'Nouvelle quête débloquée',
    bg: '#0a0f18', surface: '#121a27', text: '#e8f1fa', muted: '#9fb2c6',
    accent: '#3cc8e6', accent2: '#e6c83c', onAccent: '#06121c', motif: 'pixel', dark: true,
  },
  cinema: {
    kicker: 'Silence, on partage !',
    bg: '#120e0d', surface: '#1b1614', text: '#f4ece2', muted: '#c4b39f',
    accent: '#d4ad5a', accent2: '#b8443a', onAccent: '#1a1208', motif: 'film', dark: true,
  },
  halloween: {
    kicker: 'Des photos à faire frissonner',
    bg: '#110c0a', surface: '#1c1410', text: '#fbeee2', muted: '#d8b79a',
    accent: '#f07a2c', accent2: '#8a5ad6', onAccent: '#1a0d05', motif: 'bat', dark: true,
  },
  christmas: {
    kicker: 'La magie de Noël en photos',
    bg: '#f2f5ef', surface: '#fdfefb', text: '#16241b', muted: '#53645a',
    accent: '#1f6b43', accent2: '#c4963c', onAccent: '#ffffff', motif: 'snowflake',
  },
  tropical: {
    kicker: 'Des souvenirs au soleil',
    bg: '#eef6f3', surface: '#fbfefd', text: '#0f2622', muted: '#4b6660',
    accent: '#0e7a6a', accent2: '#f0a03c', onAccent: '#ffffff', motif: 'leaf',
  },
  corporate: {
    kicker: 'Partagez vos photos',
    bg: '#f1f3f6', surface: '#ffffff', text: '#141a24', muted: '#535d6c',
    accent: '#2d55b3', accent2: '#8fa6d6', onAccent: '#ffffff', motif: 'grid',
  },
  neonparty: {
    kicker: 'Faites briller la soirée',
    bg: '#120a1c', surface: '#1b1128', text: '#f6eefe', muted: '#cbb6e2',
    accent: '#f0527e', accent2: '#3cc8e6', onAccent: '#ffffff', motif: 'neon', dark: true,
  },
};

// Chemins SVG dessines dans une boite 24x24.
const MOTIF_PATHS = {
  sparkle: 'M12 0 C13 7 17 11 24 12 C17 13 13 17 12 24 C11 17 7 13 0 12 C7 11 11 7 12 0 Z',
  heart: 'M12 21.6 C5 16.4 1 12.3 1 7.9 C1 4.6 3.6 2 6.8 2 C9 2 10.9 3.2 12 5 C13.1 3.2 15 2 17.2 2 C20.4 2 23 4.6 23 7.9 C23 12.3 19 16.4 12 21.6 Z',
  star: 'M12 1.5 L15.1 8.1 L22.3 9 L17 14 L18.4 21.1 L12 17.6 L5.6 21.1 L7 14 L1.7 9 L8.9 8.1 Z',
  bat: 'M12 8.5 L13 6.5 L13.8 8.4 C15.6 6.6 18.6 5.9 23 6.8 C21 8 20.2 9.6 20.6 11.6 C18.6 10.6 16.4 11 15 12.6 C14.4 11.6 13.3 11 12 11 C10.7 11 9.6 11.6 9 12.6 C7.6 11 5.4 10.6 3.4 11.6 C3.8 9.6 3 8 1 6.8 C5.4 5.9 8.4 6.6 10.2 8.4 L11 6.5 Z',
  snowflake: 'M12 1 V23 M2.5 6.5 L21.5 17.5 M2.5 17.5 L21.5 6.5 M9 2.8 L12 5.5 L15 2.8 M9 21.2 L12 18.5 L15 21.2 M2.2 10 L6 10.8 L4.8 6.8 M21.8 14 L18 13.2 L19.2 17.2 M2.2 14 L6 13.2 L4.8 17.2 M21.8 10 L18 10.8 L19.2 6.8',
  leaf: 'M3 22 C4 12 10 4 22 2 C21 13 14 20 3 22 Z M3 22 L15 9',
  bolt: 'M13.5 1 L4 13.5 H11 L9.5 23 L20 9.5 H13 Z',
};

// Invader 11x8 pour le theme jeux video.
const PIXEL_SPRITE = [
  '..X.....X..',
  '...X...X...',
  '..XXXXXXX..',
  '.XX.XXX.XX.',
  'XXXXXXXXXXX',
  'X.XXXXXXX.X',
  'X.X.....X.X',
  '...XX.XX...',
];

// Emplacements des motifs : coins et marges laterales, hors zone de contenu.
const MOTIF_SLOTS = [
  { x: 46, y: 50, size: 30, rotate: -12 },
  { x: 104, y: 30, size: 14, rotate: 10 },
  { x: 26, y: 116, size: 16, rotate: 18 },
  { x: 548, y: 48, size: 26, rotate: 14 },
  { x: 492, y: 28, size: 13, rotate: -8 },
  { x: 569, y: 116, size: 15, rotate: -20 },
  { x: 28, y: 330, size: 20, rotate: 8 },
  { x: 567, y: 410, size: 22, rotate: -10 },
  { x: 30, y: 520, size: 12, rotate: 24 },
  { x: 564, y: 600, size: 13, rotate: 12 },
  { x: 26, y: 690, size: 15, rotate: -16 },
  { x: 570, y: 700, size: 14, rotate: 20 },
  { x: 52, y: 792, size: 28, rotate: 10 },
  { x: 118, y: 816, size: 13, rotate: -14 },
  { x: 544, y: 788, size: 30, rotate: -8 },
  { x: 478, y: 818, size: 12, rotate: 16 },
];

function getPosterTheme(themeKey) {
  return POSTER_THEMES[eventThemes.normalizeThemeKey(themeKey)];
}

/**
 * Les polices standard PDF ne couvrent que le jeu WinAnsi : on retire le
 * reste (emojis, ecritures non latines) plutot que d'imprimer des glyphes vides.
 */
function toPdfText(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[^\u0020-\u007e\u00a0-\u00ff\u2018\u2019\u201c\u201d\u2013\u2014\u2026\u2022\u20ac\u0152\u0153\u0178]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatPosterDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const day = date.toLocaleDateString('fr-FR', {
    timeZone: APP_TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const time = date.toLocaleTimeString('fr-FR', {
    timeZone: APP_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
  }).replace(':', 'h');

  return `${day.charAt(0).toUpperCase()}${day.slice(1)} · ${time}`;
}

function buildUploadStepText(eventItem) {
  if (eventItem.uploadSourceMode === 'camera_only') {
    return 'Prenez vos photos directement depuis la page de l\'événement.';
  }
  if (eventItem.uploadSourceMode === 'library_only') {
    return 'Choisissez vos plus belles photos dans la galerie de votre téléphone.';
  }
  return 'Prenez une photo ou choisissez-la dans la galerie de votre téléphone.';
}

function buildPublicationText(eventItem) {
  return eventItem.moderationEnabled
    ? 'Vos photos sont publiées après validation par l\'organisateur.'
    : 'Vos photos apparaissent aussitôt dans la galerie et sur le diaporama.';
}

/** Suffixe ASCII lisible pour les noms de fichiers (en-tete Content-Disposition). */
function buildFileSlug(eventItem) {
  const slug = String(eventItem.name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return slug || eventItem.token;
}

function buildPosterFileName(eventItem) {
  return `affiche-${buildFileSlug(eventItem)}.pdf`;
}

function buildQrFileName(eventItem) {
  return `qr-code-${buildFileSlug(eventItem)}.png`;
}

/** QR code du lien invite en PNG (affichage dans l'interface et telechargement). */
function renderQrPng(url) {
  return QRCode.toBuffer(url, {
    ...QR_OPTIONS,
    type: 'png',
    width: 1024,
    margin: 2,
    color: { dark: '#1c1814ff', light: '#ffffffff' },
  });
}

function drawBackground(doc, palette) {
  doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill(palette.bg);

  const glows = [
    { x: 40, y: 20, r: 360, color: palette.accent, opacity: palette.dark ? 0.26 : 0.16 },
    { x: PAGE_WIDTH - 20, y: PAGE_HEIGHT - 40, r: 340, color: palette.accent2, opacity: palette.dark ? 0.18 : 0.2 },
  ];

  glows.forEach((glow) => {
    const gradient = doc.radialGradient(glow.x, glow.y, 0, glow.x, glow.y, glow.r);
    gradient.stop(0, glow.color, glow.opacity).stop(1, glow.color, 0);
    doc.circle(glow.x, glow.y, glow.r).fill(gradient);
  });
}

function stampPath(doc, pathData, slot, color, { opacity = 1, stroke = false } = {}) {
  const scale = slot.size / 24;
  doc.save();
  doc.translate(slot.x, slot.y).rotate(slot.rotate || 0).scale(scale).translate(-12, -12);
  if (stroke) {
    doc.path(pathData)
      .lineWidth(1.8)
      .lineCap('round')
      .lineJoin('round')
      .strokeOpacity(opacity)
      .stroke(color);
  } else {
    doc.path(pathData).fillOpacity(opacity).fill(color);
  }
  doc.restore();
}

function stampSprite(doc, slot, color, opacity) {
  const pixel = slot.size / PIXEL_SPRITE[0].length;
  const originX = slot.x - (slot.size / 2);
  const originY = slot.y - ((pixel * PIXEL_SPRITE.length) / 2);

  doc.save();
  PIXEL_SPRITE.forEach((row, rowIndex) => {
    [...row].forEach((cell, colIndex) => {
      if (cell === 'X') {
        doc.rect(originX + (colIndex * pixel), originY + (rowIndex * pixel), pixel, pixel);
      }
    });
  });
  doc.fillOpacity(opacity).fill(color);
  doc.restore();
}

function drawFilmStrip(doc, y, palette) {
  const height = 30;
  doc.save();
  doc.rect(0, y, PAGE_WIDTH, height).fillOpacity(0.9).fill('#050404');
  for (let x = 10; x < PAGE_WIDTH; x += 22) {
    doc.roundedRect(x, y + 9, 12, 12, 2.5).fillOpacity(0.55).fill(palette.accent);
  }
  doc.restore();
}

function drawMotifs(doc, palette) {
  const colors = [palette.accent, palette.accent2];

  if (palette.motif === 'film') {
    drawFilmStrip(doc, 0, palette);
    drawFilmStrip(doc, PAGE_HEIGHT - 30, palette);
  }

  if (palette.motif === 'grid') {
    doc.save();
    doc.rect(0, 0, 8, PAGE_HEIGHT).fill(palette.accent);
    doc.rect(8, 0, 3, PAGE_HEIGHT).fillOpacity(0.4).fill(palette.accent2);
    doc.restore();
  }

  MOTIF_SLOTS.forEach((baseSlot, index) => {
    const color = colors[index % 2];
    // Le film occupe deja le haut et le bas de la page.
    const slot = palette.motif === 'film' ? { ...baseSlot, y: Math.min(Math.max(baseSlot.y, 60), PAGE_HEIGHT - 60) } : baseSlot;

    switch (palette.motif) {
      case 'sparkle':
        stampPath(doc, MOTIF_PATHS.sparkle, slot, color, { opacity: 0.7 });
        break;
      case 'heart':
        stampPath(doc, index % 3 === 2 ? MOTIF_PATHS.sparkle : MOTIF_PATHS.heart, slot, color, { opacity: 0.55 });
        break;
      case 'pixel':
        if (index % 3 === 0) {
          stampSprite(doc, slot, color, 0.75);
        } else {
          const size = Math.max(4, slot.size / 3);
          doc.save();
          doc.rect(slot.x - size, slot.y - size, size, size)
            .rect(slot.x, slot.y, size, size)
            .fillOpacity(0.6)
            .fill(color);
          doc.restore();
        }
        break;
      case 'film':
        stampPath(doc, MOTIF_PATHS.star, slot, palette.accent, { opacity: index % 2 ? 0.35 : 0.7 });
        break;
      case 'bat':
        if (index === 3) {
          break; // emplacement occupe par la lune
        }
        stampPath(doc, MOTIF_PATHS.bat, { ...slot, size: slot.size * 1.3 }, index % 3 === 1 ? palette.accent2 : palette.accent, { opacity: 0.7 });
        break;
      case 'snowflake':
        if (index % 3 === 1) {
          stampPath(doc, MOTIF_PATHS.star, slot, palette.accent2, { opacity: 0.75 });
        } else {
          stampPath(doc, MOTIF_PATHS.snowflake, slot, palette.accent, { opacity: 0.55, stroke: true });
        }
        break;
      case 'leaf':
        stampPath(doc, MOTIF_PATHS.leaf, { ...slot, size: slot.size * 1.2 }, color, { opacity: 0.6 });
        break;
      case 'grid': {
        const step = Math.max(5, slot.size / 3);
        doc.save();
        for (let row = -1; row <= 1; row += 1) {
          for (let col = -1; col <= 1; col += 1) {
            doc.circle(slot.x + (col * step), slot.y + (row * step), 1.3);
          }
        }
        doc.fillOpacity(0.45).fill(palette.accent);
        doc.restore();
        break;
      }
      case 'neon':
        if (index % 3 === 2) {
          stampPath(doc, MOTIF_PATHS.bolt, slot, palette.accent2, { opacity: 0.85 });
        } else {
          const radius = slot.size / 2;
          doc.save();
          [[7, 0.12], [3.5, 0.3], [1.4, 1]].forEach(([width, opacity]) => {
            doc.circle(slot.x, slot.y, radius).lineWidth(width).strokeOpacity(opacity).stroke(color);
          });
          doc.restore();
        }
        break;
      default:
        break;
    }
  });

  if (palette.motif === 'bat') {
    // Pleine lune derriere les chauves-souris.
    doc.save();
    doc.circle(PAGE_WIDTH - 44, 46, 24).fillOpacity(0.9).fill(palette.accent);
    doc.circle(PAGE_WIDTH - 35, 40, 21).fillOpacity(1).fill(palette.bg);
    doc.restore();
  }
}

/** Texte centre sur la largeur utile, retourne la position verticale suivante. */
function centeredText(doc, text, y, { font, size, color, spacing = 0, lineGap = 0, width = PAGE_WIDTH - (CONTENT_MARGIN * 2) }) {
  const x = (PAGE_WIDTH - width) / 2;
  doc.font(font).fontSize(size).fillColor(color);
  doc.text(text, x, y, { width, align: 'center', characterSpacing: spacing, lineGap });
  return y + doc.heightOfString(text, { width, characterSpacing: spacing, lineGap });
}

function fitTitleSize(doc, title, width) {
  let size = 46;
  doc.font('Times-Roman');
  while (size > 24) {
    doc.fontSize(size);
    const lineHeight = doc.currentLineHeight(true);
    if (doc.heightOfString(title, { width }) <= lineHeight * 2.05) {
      break;
    }
    size -= 2;
  }
  return size;
}

function drawQrCard(doc, url, top, cardSize, palette) {
  const padding = Math.round(cardSize * 0.075);
  const cardX = (PAGE_WIDTH - cardSize) / 2;
  const qr = QRCode.create(url, QR_OPTIONS);
  const count = qr.modules.size;
  const moduleSize = (cardSize - (padding * 2)) / count;
  const qrColor = palette.dark ? '#0d0b10' : palette.text;

  doc.save();
  // Halo colore derriere la carte.
  doc.roundedRect(cardX - 10, top - 10, cardSize + 20, cardSize + 20, 30)
    .fillOpacity(palette.dark ? 0.28 : 0.14)
    .fill(palette.accent);
  doc.roundedRect(cardX, top, cardSize, cardSize, 22).fillOpacity(1).fill('#ffffff');
  doc.roundedRect(cardX, top, cardSize, cardSize, 22).lineWidth(1.5).strokeOpacity(0.9).stroke(palette.accent);

  for (let row = 0; row < count; row += 1) {
    let runStart = -1;
    for (let col = 0; col <= count; col += 1) {
      const isDark = col < count && qr.modules.get(row, col);
      if (isDark && runStart < 0) {
        runStart = col;
      } else if (!isDark && runStart >= 0) {
        // Leger debord pour eviter les filets blancs entre modules a l'impression.
        doc.rect(
          cardX + padding + (runStart * moduleSize),
          top + padding + (row * moduleSize),
          ((col - runStart) * moduleSize) + 0.15,
          moduleSize + 0.15,
        );
        runStart = -1;
      }
    }
  }
  doc.fill(qrColor);
  doc.restore();

  return top + cardSize;
}

const STEP_GAP = 18;
const STEP_TITLE_OFFSET = 44;
const STEP_BODY_GAP = 5;

function stepColumnWidth(count) {
  return (PAGE_WIDTH - (CONTENT_MARGIN * 2) - (STEP_GAP * (count - 1))) / count;
}

/** Hauteur du bloc d'etapes, pour l'ancrer en bas de page avant de le dessiner. */
function measureSteps(doc, steps) {
  const width = stepColumnWidth(steps.length);
  return steps.reduce((maxHeight, step) => {
    doc.font('Helvetica-Bold').fontSize(13);
    const titleHeight = doc.heightOfString(step.title, { width });
    doc.font('Helvetica').fontSize(10.5);
    const bodyHeight = doc.heightOfString(step.body, { width, lineGap: 2 });
    return Math.max(maxHeight, STEP_TITLE_OFFSET + titleHeight + STEP_BODY_GAP + bodyHeight);
  }, 0);
}

function drawSteps(doc, steps, top, palette) {
  const columnWidth = stepColumnWidth(steps.length);

  steps.forEach((step, index) => {
    const x = CONTENT_MARGIN + (index * (columnWidth + STEP_GAP));
    const centerX = x + (columnWidth / 2);

    doc.save();
    doc.circle(centerX, top + 17, 17).fill(palette.accent);
    doc.restore();
    doc.font('Helvetica-Bold').fontSize(15).fillColor(palette.onAccent);
    doc.text(String(index + 1), centerX - 17, top + 17 - 7, { width: 34, align: 'center' });

    doc.font('Helvetica-Bold').fontSize(13).fillColor(palette.text);
    doc.text(step.title, x, top + STEP_TITLE_OFFSET, { width: columnWidth, align: 'center' });
    const titleHeight = doc.heightOfString(step.title, { width: columnWidth });

    doc.font('Helvetica').fontSize(10.5).fillColor(palette.muted);
    doc.text(step.body, x, top + STEP_TITLE_OFFSET + titleHeight + STEP_BODY_GAP, {
      width: columnWidth, align: 'center', lineGap: 2,
    });
  });
}

/**
 * Genere l'affiche A4 de l'evenement.
 *
 * Mise en page en deux temps : l'en-tete s'empile depuis le haut, les etapes
 * et le pied de page s'ancrent en bas, et le QR code prend la place restante
 * (un titre sur deux lignes reduit donc le QR plutot que de deborder).
 * @param {object} eventItem
 * @param {string} guestUrl URL absolue du site invite
 * @returns {Promise<Buffer>}
 */
function renderPosterPdf(eventItem, guestUrl) {
  const palette = getPosterTheme(eventItem.theme);
  const title = toPdfText(eventItem.name) || 'Notre événement';
  const steps = [
    { title: 'Scannez', body: 'Visez le QR code avec l\'appareil photo de votre téléphone.' },
    { title: 'Présentez-vous', body: 'Indiquez votre prénom : il accompagnera vos photos.' },
    { title: 'Partagez', body: buildUploadStepText(eventItem) },
  ];

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      info: {
        Title: `Affiche - ${title}`,
        Author: 'PicPix',
        Subject: 'QR code pour partager ses photos',
      },
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      drawBackground(doc, palette);
      drawMotifs(doc, palette);

      // En-tete, depuis le haut
      let y = palette.motif === 'film' ? 66 : 60;
      y = centeredText(doc, palette.kicker.toUpperCase(), y, {
        font: 'Helvetica-Bold', size: 11, color: palette.accent, spacing: 2.6,
      });

      const titleWidth = PAGE_WIDTH - (CONTENT_MARGIN * 2) - 20;
      const titleSize = fitTitleSize(doc, title, titleWidth);
      y = centeredText(doc, title, y + 14, {
        font: 'Times-Roman', size: titleSize, color: palette.text, width: titleWidth,
      });

      const dateText = formatPosterDate(eventItem.startsAt);
      if (dateText) {
        y = centeredText(doc, dateText, y + 8, { font: 'Helvetica', size: 12.5, color: palette.muted });
      }

      // Pied de page et etapes, depuis le bas
      const footerY = palette.motif === 'film' ? PAGE_HEIGHT - 62 : PAGE_HEIGHT - 44;
      centeredText(doc, 'PicPix', footerY - 22, { font: 'Times-Italic', size: 16, color: palette.accent });
      centeredText(doc, 'Aucune application à installer · Aucun compte à créer', footerY, {
        font: 'Helvetica', size: 8.5, color: palette.muted,
      });

      const publicationY = footerY - 54;
      centeredText(doc, buildPublicationText(eventItem), publicationY, {
        font: 'Helvetica-Oblique', size: 10.5, color: palette.muted,
      });

      const stepsTop = publicationY - 20 - measureSteps(doc, steps);
      drawSteps(doc, steps, stepsTop, palette);

      // QR code dans l'espace restant, centre verticalement
      const headingHeight = 18;
      const headingGap = 22;
      const urlBlockHeight = 48;
      const middleTop = y + 30;
      const middleBottom = stepsTop - 26;
      const cardSize = Math.max(180, Math.min(320, middleBottom - middleTop - headingHeight - headingGap - urlBlockHeight));
      const middleHeight = headingHeight + headingGap + cardSize + urlBlockHeight;
      let middleY = middleTop + Math.max(0, (middleBottom - middleTop - middleHeight) / 2);

      middleY = centeredText(doc, 'Scannez pour partager vos photos', middleY, {
        font: 'Helvetica-Bold', size: 15, color: palette.text,
      });
      middleY = drawQrCard(doc, guestUrl, middleY + headingGap, cardSize, palette);
      middleY = centeredText(doc, 'ou rendez-vous sur', middleY + 20, { font: 'Helvetica', size: 9.5, color: palette.muted });
      centeredText(doc, guestUrl.replace(/^https?:\/\//i, ''), middleY + 3, {
        font: 'Courier-Bold', size: 11.5, color: palette.text,
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  POSTER_THEMES,
  buildPosterFileName,
  buildQrFileName,
  formatPosterDate,
  renderPosterPdf,
  renderQrPng,
  toPdfText,
};
