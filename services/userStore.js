'use strict';

const bcrypt = require('bcryptjs');

const { pool } = require('../config/database');

const DEFAULT_ADMIN_EMAIL = 'admin@example.com';
const DEFAULT_ADMIN_PASSWORD_HASH = '$2a$12$/7YSCPHVP47Yr0Si/xDAoO2GEKG08iXxm6X4OzO/gYLymjEICIkly';

function sanitizeUser(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastLoginAt: row.lastLoginAt,
  };
}

function normalizeRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash || row.password_hash,
    fullName: row.fullName || row.full_name,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt || row.created_at,
    updatedAt: row.updatedAt || row.updated_at,
    lastLoginAt: row.lastLoginAt || row.last_login_at,
  };
}

function createInitialTestUsers() {
  const now = new Date().toISOString();

  return [
    {
      id: 1,
      email: DEFAULT_ADMIN_EMAIL,
      passwordHash: DEFAULT_ADMIN_PASSWORD_HASH,
      fullName: 'Administrateur PicPix',
      role: 'admin',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    },
  ];
}

let testUsers = createInitialTestUsers();
let nextTestUserId = 2;

function useTestStore() {
  return process.env.NODE_ENV === 'test';
}

function cloneTestUser(user) {
  return { ...user };
}

function ensureUniqueEmail(email, excludeUserId = null) {
  const normalizedEmail = email.toLowerCase();
  return !testUsers.some((user) => user.email.toLowerCase() === normalizedEmail && user.id !== excludeUserId);
}

async function listUsers() {
  if (useTestStore()) {
    return testUsers
      .slice()
      .sort((left, right) => right.id - left.id)
      .map((user) => sanitizeUser(cloneTestUser(user)));
  }

  const [rows] = await pool.query(`
    SELECT id, email, full_name AS fullName, role, status,
           created_at AS createdAt, updated_at AS updatedAt, last_login_at AS lastLoginAt
    FROM users
    ORDER BY created_at DESC, id DESC
  `);

  return rows.map(sanitizeUser);
}

async function findByEmail(email) {
  if (useTestStore()) {
    const user = testUsers.find((entry) => entry.email.toLowerCase() === String(email).toLowerCase());
    return normalizeRow(user ? cloneTestUser(user) : null);
  }

  const [rows] = await pool.query(`
    SELECT id, email, password_hash AS passwordHash, full_name AS fullName, role, status,
           created_at AS createdAt, updated_at AS updatedAt, last_login_at AS lastLoginAt
    FROM users
    WHERE email = ?
    LIMIT 1
  `, [email]);

  return normalizeRow(rows[0]);
}

async function findPublicById(userId) {
  if (useTestStore()) {
    const user = testUsers.find((entry) => entry.id === Number(userId));
    return sanitizeUser(user ? cloneTestUser(user) : null);
  }

  const [rows] = await pool.query(`
    SELECT id, email, full_name AS fullName, role, status,
           created_at AS createdAt, updated_at AS updatedAt, last_login_at AS lastLoginAt
    FROM users
    WHERE id = ?
    LIMIT 1
  `, [userId]);

  return sanitizeUser(rows[0]);
}

async function findById(userId) {
  if (useTestStore()) {
    const user = testUsers.find((entry) => entry.id === Number(userId));
    return normalizeRow(user ? cloneTestUser(user) : null);
  }

  const [rows] = await pool.query(`
    SELECT id, email, password_hash AS passwordHash, full_name AS fullName, role, status,
           created_at AS createdAt, updated_at AS updatedAt, last_login_at AS lastLoginAt
    FROM users
    WHERE id = ?
    LIMIT 1
  `, [userId]);

  return normalizeRow(rows[0]);
}

async function createUser({ email, password, fullName, role = 'user', status = 'active' }) {
  const normalizedEmail = String(email).trim().toLowerCase();
  const passwordHash = await bcrypt.hash(password, 12);

  if (useTestStore()) {
    if (!ensureUniqueEmail(normalizedEmail)) {
      const err = new Error('EMAIL_ALREADY_EXISTS');
      err.code = 'EMAIL_ALREADY_EXISTS';
      throw err;
    }

    const now = new Date().toISOString();
    const user = {
      id: nextTestUserId,
      email: normalizedEmail,
      passwordHash,
      fullName,
      role,
      status,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    };

    testUsers.push(user);
    nextTestUserId += 1;
    return sanitizeUser(cloneTestUser(user));
  }

  try {
    const [result] = await pool.query(`
      INSERT INTO users (email, password_hash, full_name, role, status)
      VALUES (?, ?, ?, ?, ?)
    `, [normalizedEmail, passwordHash, fullName, role, status]);

    return findPublicById(result.insertId);
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      const duplicateError = new Error('EMAIL_ALREADY_EXISTS');
      duplicateError.code = 'EMAIL_ALREADY_EXISTS';
      throw duplicateError;
    }

    throw err;
  }
}

async function updateUser(userId, payload) {
  const currentUser = await findById(userId);
  if (!currentUser) {
    return null;
  }

  const nextEmail = payload.email ? String(payload.email).trim().toLowerCase() : currentUser.email;
  const nextFullName = payload.fullName || currentUser.fullName;
  const nextRole = payload.role || currentUser.role;
  const nextStatus = payload.status || currentUser.status;
  const nextPasswordHash = payload.password ? await bcrypt.hash(payload.password, 12) : currentUser.passwordHash;

  if (useTestStore()) {
    if (!ensureUniqueEmail(nextEmail, currentUser.id)) {
      const err = new Error('EMAIL_ALREADY_EXISTS');
      err.code = 'EMAIL_ALREADY_EXISTS';
      throw err;
    }

    testUsers = testUsers.map((user) => {
      if (user.id !== currentUser.id) {
        return user;
      }

      return {
        ...user,
        email: nextEmail,
        fullName: nextFullName,
        role: nextRole,
        status: nextStatus,
        passwordHash: nextPasswordHash,
        updatedAt: new Date().toISOString(),
      };
    });

    return findPublicById(currentUser.id);
  }

  try {
    await pool.query(`
      UPDATE users
      SET email = ?, full_name = ?, role = ?, status = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [nextEmail, nextFullName, nextRole, nextStatus, nextPasswordHash, currentUser.id]);

    return findPublicById(currentUser.id);
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      const duplicateError = new Error('EMAIL_ALREADY_EXISTS');
      duplicateError.code = 'EMAIL_ALREADY_EXISTS';
      throw duplicateError;
    }

    throw err;
  }
}

async function updateLastLogin(userId) {
  if (useTestStore()) {
    const now = new Date().toISOString();
    testUsers = testUsers.map((user) => (
      user.id === Number(userId)
        ? { ...user, lastLoginAt: now, updatedAt: now }
        : user
    ));
    return;
  }

  await pool.query(`
    UPDATE users
    SET last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [userId]);
}

async function deleteUser(userId) {
  if (useTestStore()) {
    const beforeCount = testUsers.length;
    testUsers = testUsers.filter((user) => user.id !== Number(userId));
    return testUsers.length < beforeCount;
  }

  const [result] = await pool.query('DELETE FROM users WHERE id = ?', [userId]);
  return result.affectedRows > 0;
}

async function countActiveAdmins(excludeUserId = null) {
  if (useTestStore()) {
    return testUsers.filter((user) => user.role === 'admin' && user.status === 'active' && user.id !== excludeUserId).length;
  }

  const conditions = ['role = ?', 'status = ?'];
  const values = ['admin', 'active'];

  if (excludeUserId) {
    conditions.push('id <> ?');
    values.push(excludeUserId);
  }

  const [rows] = await pool.query(`
    SELECT COUNT(*) AS total
    FROM users
    WHERE ${conditions.join(' AND ')}
  `, values);

  return rows[0].total;
}

function resetTestState() {
  testUsers = createInitialTestUsers();
  nextTestUserId = 2;
}

module.exports = {
  DEFAULT_ADMIN_EMAIL,
  createUser,
  countActiveAdmins,
  deleteUser,
  findByEmail,
  findById,
  findPublicById,
  listUsers,
  resetTestState,
  updateLastLogin,
  updateUser,
};