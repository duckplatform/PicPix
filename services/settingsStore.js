'use strict';

const { pool } = require('../config/database');

let testSettings = new Map();

function useTestStore() {
  return process.env.NODE_ENV === 'test';
}

async function getSetting(key) {
  if (useTestStore()) {
    return testSettings.has(key) ? testSettings.get(key) : null;
  }

  const [rows] = await pool.query(
    'SELECT setting_value AS settingValue FROM app_settings WHERE setting_key = ? LIMIT 1',
    [key],
  );

  return rows.length > 0 ? rows[0].settingValue : null;
}

async function setSetting(key, value) {
  if (useTestStore()) {
    testSettings.set(key, value);
    return;
  }

  await pool.query(`
    INSERT INTO app_settings (setting_key, setting_value)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)
  `, [key, value]);
}

async function getBoolSetting(key, defaultValue = false) {
  const value = await getSetting(key);
  if (value === null) {
    return defaultValue;
  }

  return value === '1' || value === 'true';
}

async function setBoolSetting(key, value) {
  return setSetting(key, value ? '1' : '0');
}

function resetTestState() {
  testSettings = new Map();
}

module.exports = {
  getBoolSetting,
  resetTestState,
  setBoolSetting,
};
