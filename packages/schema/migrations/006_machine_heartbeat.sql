-- 006_machine_heartbeat: per-machine liveness from POST /ingest/heartbeat.
-- heartbeat_at is the HUB's receive time (ISO-8601 UTC); liveness never reads the sender's clock.
-- machines.last_seen_at stays what it was: the time of the latest ingested session event.

ALTER TABLE machines ADD COLUMN heartbeat_at TEXT;
ALTER TABLE machines ADD COLUMN heartbeat_boot TEXT;
ALTER TABLE machines ADD COLUMN heartbeat_seq INTEGER;
ALTER TABLE machines ADD COLUMN heartbeat_interval_s INTEGER;
