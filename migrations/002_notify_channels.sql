-- Notification channels: per-user SMS opt-in, the household SMTP master
-- switch, and the household's OpenSMS gateway config.
--
-- Columns live on users (household-wide ones on the Dominant's row, the same
-- convention as allow_sub_interaction / immich_key):
--   phone               — the user's own mobile number, E.164 (+1…)
--   sms_notifications   — per-user opt-in for SMS delivery (default off)
--   smtp_notifications  — household master switch for email (default on;
--                         the Dom flips it, and it gates everyone in the pair)
--   sms_gateway_*/      — the OpenSMS endpoint URL + bearer token, entered by
--                         the Dom in Settings; secret, never sent to browsers
--                         (like immich_key — browsers only see a sms_linked flag)
ALTER TABLE users ADD COLUMN phone              TEXT    NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN sms_notifications  SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN smtp_notifications SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN sms_gateway_url    TEXT    NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN sms_gateway_token  TEXT    NOT NULL DEFAULT '';