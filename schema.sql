-- NeonLink: схема PostgreSQL (Neon). Идемпотентна — сервер выполняет её при старте.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(32)  NOT NULL,
  password_hash TEXT         NOT NULL,
  display_name  VARCHAR(64)  NOT NULL,
  avatar_url    TEXT         NOT NULL DEFAULT '',
  role          VARCHAR(8)   NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin','owner')),
  is_blocked    BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_login    TIMESTAMPTZ
);
-- username уникален без учёта регистра
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uq ON users (LOWER(username));

CREATE TABLE IF NOT EXISTS messages (            -- общая лента
  id              BIGSERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text            TEXT    NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at       TIMESTAMPTZ,
  edited_by_admin BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS messages_created_idx ON messages (id DESC);

CREATE TABLE IF NOT EXISTS dm_messages (         -- личные сообщения
  id              BIGSERIAL PRIMARY KEY,
  sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text            TEXT    NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at       TIMESTAMPTZ,
  edited_by_admin BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS dm_pair_idx ON dm_messages (LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id), id DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INTEGER,                -- без FK: логи переживают удаление пользователя
  username   VARCHAR(64),
  action     VARCHAR(64) NOT NULL,   -- login, register, message_send, message_edit, admin_user_update ...
  details    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ip         VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_logs (id DESC);
CREATE INDEX IF NOT EXISTS audit_action_idx  ON audit_logs (action);

CREATE TABLE IF NOT EXISTS blocks (              -- пользователь блокирует другого пользователя в DM
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS settings (            -- глобальные настройки (maintenance mode)
  key   VARCHAR(64) PRIMARY KEY,
  value JSONB NOT NULL
);
INSERT INTO settings (key, value) VALUES ('maintenance', 'false'::jsonb) ON CONFLICT DO NOTHING;
