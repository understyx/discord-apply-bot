import mysql from 'mysql2/promise';

let pool;

function escapeMysqlIdentifier(identifier) {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

function getPool() {
  if (!pool) {
    throw new Error('Database has not been initialized.');
  }

  return pool;
}

export function normalizeApplicationKey(applicationName) {
  return applicationName.trim().toLowerCase();
}

export async function initDatabase({
  host,
  port,
  user,
  password,
  database,
}) {
  const normalizedDatabaseName = database.trim();
  const bootstrapConnection = await mysql.createConnection({
    host,
    port,
    user,
    password,
  });

  try {
    await bootstrapConnection.query(
      `CREATE DATABASE IF NOT EXISTS ${escapeMysqlIdentifier(normalizedDatabaseName)}`,
    );
  } finally {
    await bootstrapConnection.end();
  }

  pool = mysql.createPool({
    host,
    port,
    user,
    password,
    database: normalizedDatabaseName,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id VARCHAR(32) PRIMARY KEY,
      officer_role_id VARCHAR(32) NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS applications (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      guild_id VARCHAR(32) NOT NULL,
      application_key VARCHAR(80) NOT NULL,
      display_name VARCHAR(80) NOT NULL,
      questions_text TEXT NOT NULL,
      approve_role_id VARCHAR(32) NULL,
      deny_role_id VARCHAR(32) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_applications_guild_key (guild_id, application_key),
      KEY idx_applications_guild_id (guild_id)
    )
  `);

  await pool.query(`
    ALTER TABLE applications
      ADD COLUMN IF NOT EXISTS approve_role_id VARCHAR(32) NULL,
      ADD COLUMN IF NOT EXISTS deny_role_id VARCHAR(32) NULL
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_officer_roles (
      guild_id VARCHAR(32) NOT NULL,
      role_id VARCHAR(32) NOT NULL,
      PRIMARY KEY (guild_id, role_id)
    )
  `);

  await pool.query(`
    INSERT IGNORE INTO guild_officer_roles (guild_id, role_id)
    SELECT guild_id, officer_role_id FROM guild_settings WHERE officer_role_id IS NOT NULL
  `);
}

export async function getGuildSettings(guildId) {
  const [rows] = await getPool().query(
    'SELECT role_id FROM guild_officer_roles WHERE guild_id = ?',
    [guildId],
  );

  return { officerRoleIds: rows.map((r) => r.role_id) };
}

export async function setGuildOfficerRoles(guildId, roleIds) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM guild_officer_roles WHERE guild_id = ?', [guildId]);
    if (roleIds.length > 0) {
      const values = roleIds.map((id) => [guildId, id]);
      await conn.query('INSERT INTO guild_officer_roles (guild_id, role_id) VALUES ?', [values]);
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export async function upsertApplication({
  guildId,
  applicationName,
  questionsText,
  approveRoleId,
  denyRoleId,
}) {
  const key = normalizeApplicationKey(applicationName);
  await getPool().query(
    `
      INSERT INTO applications (guild_id, application_key, display_name, questions_text, approve_role_id, deny_role_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        display_name = VALUES(display_name),
        questions_text = VALUES(questions_text),
        approve_role_id = VALUES(approve_role_id),
        deny_role_id = VALUES(deny_role_id)
    `,
    [guildId, key, applicationName.trim(), questionsText.trim(), approveRoleId ?? null, denyRoleId ?? null],
  );

  const [rows] = await getPool().query(
    `
      SELECT id, guild_id, application_key, display_name, questions_text, approve_role_id, deny_role_id
      FROM applications
      WHERE guild_id = ? AND application_key = ?
      LIMIT 1
    `,
    [guildId, key],
  );

  return rows[0] || null;
}

export async function getApplicationByName(guildId, applicationName) {
  const [rows] = await getPool().query(
    `
      SELECT id, guild_id, application_key, display_name, questions_text, approve_role_id, deny_role_id
      FROM applications
      WHERE guild_id = ? AND application_key = ?
      LIMIT 1
    `,
    [guildId, normalizeApplicationKey(applicationName)],
  );

  return rows[0] || null;
}

export async function getApplicationById(guildId, applicationId) {
  const [rows] = await getPool().query(
    `
      SELECT id, guild_id, application_key, display_name, questions_text, approve_role_id, deny_role_id
      FROM applications
      WHERE guild_id = ? AND id = ?
      LIMIT 1
    `,
    [guildId, applicationId],
  );

  return rows[0] || null;
}

export async function listGuildApplications(guildId) {
  const [rows] = await getPool().query(
    `
      SELECT id, guild_id, application_key, display_name, questions_text, approve_role_id, deny_role_id
      FROM applications
      WHERE guild_id = ?
      ORDER BY display_name ASC
    `,
    [guildId],
  );

  return rows;
}
