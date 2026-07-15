'use strict';

const { pool } = require('../config/database');

let testFiles = [];
let nextTestFileId = 1;

const MODERATION_STATUSES = new Set(['pending', 'approved', 'rejected']);

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
    uploadedByUserId: row.uploadedByUserId || row.uploaded_by_user_id || null,
    uploaderName: row.uploaderName || row.uploader_name || null,
    originalName: row.originalName || row.original_name,
    storedName: row.storedName || row.stored_name,
    sizeBytes: row.sizeBytes || row.size_bytes,
    storagePath: row.storagePath || row.storage_path,
    checksumSha256: row.checksumSha256 || row.checksum_sha256 || null,
    moderationStatus: row.moderationStatus || row.moderation_status || 'approved',
    createdAt: row.createdAt || row.created_at,
  };
}

async function createFileRecord(payload) {
  const record = {
    eventId: Number(payload.eventId),
    uploadedByUserId: payload.uploadedByUserId ? Number(payload.uploadedByUserId) : null,
    uploaderName: payload.uploaderName || null,
    originalName: payload.originalName,
    storedName: payload.storedName,
    sizeBytes: Number(payload.sizeBytes),
    storagePath: payload.storagePath,
    checksumSha256: payload.checksumSha256 || null,
    moderationStatus: MODERATION_STATUSES.has(payload.moderationStatus) ? payload.moderationStatus : 'approved',
  };

  if (useTestStore()) {
    const item = {
      id: nextTestFileId,
      ...record,
      createdAt: new Date().toISOString(),
    };

    testFiles.push(item);
    nextTestFileId += 1;
    return normalizeRow(item);
  }

  const [result] = await pool.query(`
    INSERT INTO event_files (
      event_id, uploaded_by_user_id, uploader_name, original_name, stored_name,
      size_bytes, storage_path, checksum_sha256, moderation_status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    record.eventId,
    record.uploadedByUserId,
    record.uploaderName,
    record.originalName,
    record.storedName,
    record.sizeBytes,
    record.storagePath,
    record.checksumSha256,
    record.moderationStatus,
  ]);

  const [rows] = await pool.query(`
    SELECT id, event_id AS eventId, uploaded_by_user_id AS uploadedByUserId,
           uploader_name AS uploaderName,
           original_name AS originalName, stored_name AS storedName,
           size_bytes AS sizeBytes, storage_path AS storagePath,
          checksum_sha256 AS checksumSha256, moderation_status AS moderationStatus,
          created_at AS createdAt
    FROM event_files
    WHERE id = ?
    LIMIT 1
  `, [result.insertId]);

  return normalizeRow(rows[0]);
}

async function listByEvent(eventId) {
  if (useTestStore()) {
    return testFiles
      .filter((item) => item.eventId === Number(eventId))
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      .map(normalizeRow);
  }

  const [rows] = await pool.query(`
    SELECT id, event_id AS eventId, uploaded_by_user_id AS uploadedByUserId,
           uploader_name AS uploaderName,
           original_name AS originalName, stored_name AS storedName,
           size_bytes AS sizeBytes, storage_path AS storagePath,
           checksum_sha256 AS checksumSha256, moderation_status AS moderationStatus,
           created_at AS createdAt
    FROM event_files
    WHERE event_id = ?
    ORDER BY created_at DESC, id DESC
  `, [eventId]);

  return rows.map(normalizeRow);
}

async function listByEventAndStatus(eventId, moderationStatus) {
  if (!MODERATION_STATUSES.has(moderationStatus)) {
    return [];
  }

  if (useTestStore()) {
    return testFiles
      .filter((item) => item.eventId === Number(eventId) && item.moderationStatus === moderationStatus)
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      .map(normalizeRow);
  }

  const [rows] = await pool.query(`
    SELECT id, event_id AS eventId, uploaded_by_user_id AS uploadedByUserId,
           uploader_name AS uploaderName,
           original_name AS originalName, stored_name AS storedName,
           size_bytes AS sizeBytes, storage_path AS storagePath,
           checksum_sha256 AS checksumSha256, moderation_status AS moderationStatus,
           created_at AS createdAt
    FROM event_files
    WHERE event_id = ? AND moderation_status = ?
    ORDER BY created_at DESC, id DESC
  `, [eventId, moderationStatus]);

  return rows.map(normalizeRow);
}

async function findByEventAndStoredName(eventId, storedName) {
  if (useTestStore()) {
    const found = testFiles.find((item) => item.eventId === Number(eventId) && item.storedName === storedName);
    return normalizeRow(found || null);
  }

  const [rows] = await pool.query(`
    SELECT id, event_id AS eventId, uploaded_by_user_id AS uploadedByUserId,
           uploader_name AS uploaderName,
           original_name AS originalName, stored_name AS storedName,
           size_bytes AS sizeBytes, storage_path AS storagePath,
           checksum_sha256 AS checksumSha256, moderation_status AS moderationStatus,
           created_at AS createdAt
    FROM event_files
    WHERE event_id = ? AND stored_name = ?
    LIMIT 1
  `, [eventId, storedName]);

  return normalizeRow(rows[0]);
}

async function updateModerationStatus(fileId, moderationStatus) {
  if (!MODERATION_STATUSES.has(moderationStatus)) {
    throw new Error('INVALID_MODERATION_STATUS');
  }

  if (useTestStore()) {
    let updatedRecord = null;
    testFiles = testFiles.map((item) => {
      if (item.id !== Number(fileId)) {
        return item;
      }

      updatedRecord = {
        ...item,
        moderationStatus,
      };

      return updatedRecord;
    });

    return normalizeRow(updatedRecord);
  }

  await pool.query('UPDATE event_files SET moderation_status = ? WHERE id = ?', [moderationStatus, fileId]);

  const [rows] = await pool.query(`
    SELECT id, event_id AS eventId, uploaded_by_user_id AS uploadedByUserId,
           uploader_name AS uploaderName,
           original_name AS originalName, stored_name AS storedName,
           size_bytes AS sizeBytes, storage_path AS storagePath,
           checksum_sha256 AS checksumSha256, moderation_status AS moderationStatus,
           created_at AS createdAt
    FROM event_files
    WHERE id = ?
    LIMIT 1
  `, [fileId]);

  return normalizeRow(rows[0]);
}

async function approvePendingByEvent(eventId) {
  const pendingFiles = await listByEventAndStatus(eventId, 'pending');
  if (pendingFiles.length === 0) {
    return [];
  }

  const approvedFiles = await Promise.all(
    pendingFiles.map((fileItem) => updateModerationStatus(fileItem.id, 'approved')),
  );

  return approvedFiles.filter(Boolean);
}

function resetTestState() {
  testFiles = [];
  nextTestFileId = 1;
}

module.exports = {
  createFileRecord,
  findByEventAndStoredName,
  listByEvent,
  listByEventAndStatus,
  MODERATION_STATUSES,
  approvePendingByEvent,
  resetTestState,
  updateModerationStatus,
};
