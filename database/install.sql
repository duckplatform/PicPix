CREATE DATABASE IF NOT EXISTS picpix
	CHARACTER SET utf8mb4
	COLLATE utf8mb4_unicode_ci;

USE picpix;

CREATE TABLE IF NOT EXISTS users (
	id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	email VARCHAR(190) NOT NULL,
	password_hash VARCHAR(255) NOT NULL,
	full_name VARCHAR(120) NOT NULL,
	role ENUM('user', 'admin') NOT NULL DEFAULT 'user',
	status ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
	last_login_at DATETIME NULL,
	created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	PRIMARY KEY (id),
	UNIQUE KEY uk_users_email (email),
	KEY idx_users_role_status (role, status),
	KEY idx_users_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS events (
	id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	uuid CHAR(36) NOT NULL,
	owner_user_id BIGINT UNSIGNED NOT NULL,
	name VARCHAR(180) NOT NULL,
	description TEXT NOT NULL,
	starts_at DATETIME NOT NULL,
	status ENUM('active', 'inactive') NOT NULL DEFAULT 'inactive',
	theme VARCHAR(40) NOT NULL DEFAULT 'classic',
	slideshow_transition VARCHAR(30) NOT NULL DEFAULT 'fade',
	upload_source_mode ENUM('default', 'camera_only', 'library_only') NOT NULL DEFAULT 'default',
	upload_allow_multiple TINYINT(1) NOT NULL DEFAULT 1,
	moderation_enabled TINYINT(1) NOT NULL DEFAULT 0,
	token CHAR(10) NOT NULL,
	created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	PRIMARY KEY (id),
	UNIQUE KEY uk_events_uuid (uuid),
	UNIQUE KEY uk_events_token (token),
	KEY idx_events_owner_status (owner_user_id, status),
	KEY idx_events_starts_at (starts_at),
	CONSTRAINT fk_events_owner_user
		FOREIGN KEY (owner_user_id) REFERENCES users(id)
		ON DELETE CASCADE
		ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS event_files (
	id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
	event_id BIGINT UNSIGNED NOT NULL,
	uploaded_by_user_id BIGINT UNSIGNED NULL,
	uploader_name VARCHAR(255) NULL,
	original_name VARCHAR(255) NOT NULL,
	stored_name VARCHAR(255) NOT NULL,
	size_bytes BIGINT UNSIGNED NOT NULL,
	storage_path VARCHAR(500) NOT NULL,
	checksum_sha256 CHAR(64) NULL,
	moderation_status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'approved',
	created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (id),
	KEY idx_event_files_event_created (event_id, created_at),
	KEY idx_event_files_event_moderation (event_id, moderation_status, created_at),
	KEY idx_event_files_uploaded_by (uploaded_by_user_id),
	CONSTRAINT fk_event_files_event
		FOREIGN KEY (event_id) REFERENCES events(id)
		ON DELETE CASCADE
		ON UPDATE CASCADE,
	CONSTRAINT fk_event_files_uploaded_by_user
		FOREIGN KEY (uploaded_by_user_id) REFERENCES users(id)
		ON DELETE SET NULL
		ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @events_has_moderation_enabled := (
	SELECT COUNT(*)
	FROM information_schema.COLUMNS
	WHERE TABLE_SCHEMA = DATABASE()
	  AND TABLE_NAME = 'events'
	  AND COLUMN_NAME = 'moderation_enabled'
);
SET @events_moderation_sql := IF(
	@events_has_moderation_enabled = 0,
	'ALTER TABLE events ADD COLUMN moderation_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER upload_allow_multiple',
	'SELECT 1'
);
PREPARE stmt FROM @events_moderation_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @event_files_has_moderation_status := (
	SELECT COUNT(*)
	FROM information_schema.COLUMNS
	WHERE TABLE_SCHEMA = DATABASE()
	  AND TABLE_NAME = 'event_files'
	  AND COLUMN_NAME = 'moderation_status'
);
SET @event_files_moderation_sql := IF(
	@event_files_has_moderation_status = 0,
	"ALTER TABLE event_files ADD COLUMN moderation_status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'approved' AFTER checksum_sha256",
	'SELECT 1'
);
PREPARE stmt FROM @event_files_moderation_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

INSERT INTO users (
	email,
	password_hash,
	full_name,
	role,
	status,
	last_login_at
) VALUES (
	'admin@example.com',
	'$2a$12$/7YSCPHVP47Yr0Si/xDAoO2GEKG08iXxm6X4OzO/gYLymjEICIkly',
	'Administrateur PicPix',
	'admin',
	'active',
	NULL
) ON DUPLICATE KEY UPDATE
	password_hash = VALUES(password_hash),
	full_name = VALUES(full_name),
	role = VALUES(role),
	status = VALUES(status);
