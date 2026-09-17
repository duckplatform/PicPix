-- Migration : demandes d'archive par email + reglages applicatifs
--
-- A jouer une seule fois sur une base existante.
-- Les nouvelles installations sont couvertes par database/install.sql.

USE picpix;

CREATE TABLE IF NOT EXISTS event_archive_requests (
	id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	event_id BIGINT UNSIGNED NOT NULL,
	email VARCHAR(190) NOT NULL,
	created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (id),
	UNIQUE KEY uk_event_archive_requests_event_email (event_id, email),
	KEY idx_event_archive_requests_event (event_id),
	CONSTRAINT fk_event_archive_requests_event
		FOREIGN KEY (event_id) REFERENCES events(id)
		ON DELETE CASCADE
		ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_settings (
	setting_key VARCHAR(100) NOT NULL,
	setting_value VARCHAR(255) NULL,
	updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO app_settings (setting_key, setting_value)
VALUES ('mail_archive_notifications_enabled', '0')
ON DUPLICATE KEY UPDATE setting_key = setting_key;
