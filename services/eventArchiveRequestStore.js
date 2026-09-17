'use strict';

const { pool } = require('../config/database');

let testRequests = [];
let nextTestRequestId = 1;

function useTestStore() {
  return process.env.NODE_ENV === 'test';
}

function normalizeRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    eventId: row.eventId || row.event_id,
    email: row.email,
    createdAt: row.createdAt || row.created_at,
  };
}

async function upsertRequest(eventId, email) {
  const normalizedEmail = String(email).trim().toLowerCase();

  if (useTestStore()) {
    const existing = testRequests.find(
      (item) => item.eventId === Number(eventId) && item.email === normalizedEmail,
    );

    if (existing) {
      return normalizeRow(existing);
    }

    const record = {
      id: nextTestRequestId,
      eventId: Number(eventId),
      email: normalizedEmail,
      createdAt: new Date().toISOString(),
    };

    testRequests.push(record);
    nextTestRequestId += 1;
    return normalizeRow(record);
  }

  await pool.query(`
    INSERT INTO event_archive_requests (event_id, email)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE email = VALUES(email)
  `, [eventId, normalizedEmail]);

  const [rows] = await pool.query(`
    SELECT id, event_id AS eventId, email, created_at AS createdAt
    FROM event_archive_requests
    WHERE event_id = ? AND email = ?
    LIMIT 1
  `, [eventId, normalizedEmail]);

  return normalizeRow(rows[0]);
}

async function removeRequest(eventId, email) {
  const normalizedEmail = String(email).trim().toLowerCase();

  if (useTestStore()) {
    const before = testRequests.length;
    testRequests = testRequests.filter(
      (item) => !(item.eventId === Number(eventId) && item.email === normalizedEmail),
    );
    return testRequests.length < before;
  }

  const [result] = await pool.query(
    'DELETE FROM event_archive_requests WHERE event_id = ? AND email = ?',
    [eventId, normalizedEmail],
  );

  return result.affectedRows > 0;
}

async function listByEvent(eventId) {
  if (useTestStore()) {
    return testRequests
      .filter((item) => item.eventId === Number(eventId))
      .map(normalizeRow);
  }

  const [rows] = await pool.query(`
    SELECT id, event_id AS eventId, email, created_at AS createdAt
    FROM event_archive_requests
    WHERE event_id = ?
    ORDER BY created_at ASC, id ASC
  `, [eventId]);

  return rows.map(normalizeRow);
}

function resetTestState() {
  testRequests = [];
  nextTestRequestId = 1;
}

module.exports = {
  listByEvent,
  removeRequest,
  resetTestState,
  upsertRequest,
};
