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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_applications_guild_key (guild_id, application_key),
      KEY idx_applications_guild_id (guild_id)
    )
  `);
}

export async function getGuildSettings(guildId) {
  const [rows] = await getPool().query(
    'SELECT officer_role_id FROM guild_settings WHERE guild_id = ? LIMIT 1',
    [guildId],
  );

  if (!rows.length) {
    return { officerRoleId: null };
  }

  return { officerRoleId: rows[0].officer_role_id };
}

export async function setGuildOfficerRole(guildId, officerRoleId) {
  await getPool().query(
    `
      INSERT INTO guild_settings (guild_id, officer_role_id)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE officer_role_id = VALUES(officer_role_id)
    `,
    [guildId, officerRoleId],
  );
}

export async function upsertApplication({
  guildId,
  applicationName,
  questionsText,
}) {
  const key = normalizeApplicationKey(applicationName);
  await getPool().query(
    `
      INSERT INTO applications (guild_id, application_key, display_name, questions_text)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        display_name = VALUES(display_name),
        questions_text = VALUES(questions_text)
    `,
    [guildId, key, applicationName.trim(), questionsText.trim()],
  );

  const [rows] = await getPool().query(
    `
      SELECT id, guild_id, application_key, display_name, questions_text
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
      SELECT id, guild_id, application_key, display_name, questions_text
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
      SELECT id, guild_id, application_key, display_name, questions_text
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
      SELECT id, guild_id, application_key, display_name, questions_text
      FROM applications
      WHERE guild_id = ?
      ORDER BY display_name ASC
    `,
    [guildId],
  );

  return rows;
}
