-- Migration : cloture definitive d'un evenement + archive ZIP des photos
--
-- A jouer une seule fois sur une base existante.
-- Les nouvelles installations sont couvertes par database/install.sql.

USE picpix;

-- 1. Nouvel etat terminal 'closed' (irreversible cote applicatif)
ALTER TABLE events
	MODIFY status ENUM('active', 'inactive', 'closed') NOT NULL DEFAULT 'inactive';

-- 2. Metadonnees de cloture et d'archive
ALTER TABLE events
	ADD COLUMN closed_at DATETIME NULL AFTER token,
	ADD COLUMN archive_status ENUM('none', 'pending', 'ready', 'failed') NOT NULL DEFAULT 'none' AFTER closed_at,
	ADD COLUMN archive_file VARCHAR(255) NULL AFTER archive_status,
	ADD COLUMN archive_size_bytes BIGINT UNSIGNED NULL AFTER archive_file,
	ADD COLUMN archive_photo_count INT UNSIGNED NULL AFTER archive_size_bytes,
	ADD COLUMN archive_error VARCHAR(255) NULL AFTER archive_photo_count,
	ADD COLUMN archive_generated_at DATETIME NULL AFTER archive_error;
