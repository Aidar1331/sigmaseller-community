CREATE TABLE IF NOT EXISTS account_recovery_codes (
  user_id bigint PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  code_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
