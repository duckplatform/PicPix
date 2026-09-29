-- Migration : sessions persistantes en base + heures d'evenement en UTC
--
-- A jouer une seule fois sur une base existante.
-- Les nouvelles installations sont couvertes par database/install.sql.

USE picpix;

-- 1. Store de sessions express-session (config/session.js).
--    Remplace le MemoryStore : sessions conservees aux redemarrages et
--    partagees entre les processus Passenger.
CREATE TABLE IF NOT EXISTS sessions (
	session_id VARCHAR(128) NOT NULL,
	expires_at DATETIME NOT NULL,
	data MEDIUMTEXT NOT NULL,
	PRIMARY KEY (session_id),
	KEY idx_sessions_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. events.starts_at contenait l'heure murale saisie (fuseau de
--    l'organisateur) alors que l'application la relisait comme de l'UTC.
--    Elle est desormais stockee en UTC (cf. config/timezone.js, APP_TIMEZONE).
--    Adapter 'Europe/Paris' si APP_TIMEZONE differe.
--
--    CONVERT_TZ avec un fuseau nomme necessite les tables de fuseaux MySQL
--    (mysql_tzinfo_to_sql). Sans elles, CONVERT_TZ renvoie NULL : la clause
--    WHERE ci-dessous evite alors toute modification. Verifier au prealable :
--      SELECT CONVERT_TZ('2026-01-01 12:00:00', 'Europe/Paris', '+00:00');
UPDATE events
SET starts_at = CONVERT_TZ(starts_at, 'Europe/Paris', '+00:00')
WHERE CONVERT_TZ(starts_at, 'Europe/Paris', '+00:00') IS NOT NULL;
