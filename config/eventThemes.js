'use strict';

const DEFAULT_EVENT_THEME = 'classic';

const EVENT_THEMES = {
  classic: {
    key: 'classic',
    label: 'Classique',
    icon: '✦',
  },
  wedding: {
    key: 'wedding',
    label: 'Mariage',
    icon: '❤',
  },
  gaming: {
    key: 'gaming',
    label: 'Jeux vidéo',
    icon: '🎮',
  },
  cinema: {
    key: 'cinema',
    label: 'Cinéma',
    icon: '🎬',
  },
  halloween: {
    key: 'halloween',
    label: 'Halloween',
    icon: '🎃',
  },
  christmas: {
    key: 'christmas',
    label: 'Noël',
    icon: '🎄',
  },
  tropical: {
    key: 'tropical',
    label: 'Tropical',
    icon: '🌴',
  },
  corporate: {
    key: 'corporate',
    label: 'Corporate',
    icon: '📊',
  },
  neonparty: {
    key: 'neonparty',
    label: 'Néon party',
    icon: '⚡',
  },
};

function listThemes() {
  return Object.values(EVENT_THEMES);
}

function normalizeThemeKey(value) {
  if (!value || typeof value !== 'string') {
    return DEFAULT_EVENT_THEME;
  }

  const trimmed = value.trim().toLowerCase();
  return EVENT_THEMES[trimmed] ? trimmed : DEFAULT_EVENT_THEME;
}

function getTheme(value) {
  return EVENT_THEMES[normalizeThemeKey(value)];
}

module.exports = {
  DEFAULT_EVENT_THEME,
  EVENT_THEMES,
  listThemes,
  normalizeThemeKey,
  getTheme,
};
