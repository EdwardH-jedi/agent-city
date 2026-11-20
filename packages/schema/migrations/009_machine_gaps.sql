-- 009_machine_gaps: completed heartbeat gaps per machine (N12), so a reloaded screen or a restarted hub still
-- knows when a machine was quiet. One row = one gap that has ended: the hub receive time of the last accepted
-- beat before it (from_at) and of the accepted beat that ended it (until_at), both ISO-8601 UTC, at least
-- HEARTBEAT_ONLINE_BELOW_MS apart. A gap still open is not stored (machines.heartbeat_at and now tell it).
-- The sender's clock is never read (006). Rows whose until_at is older than 30 days are pruned, a bounded
-- batch at a time, only when a new gap is written.

CREATE TABLE machine_gaps (
  machine_id   TEXT NOT NULL REFERENCES machines(id),
  from_at      TEXT NOT NULL,
  until_at     TEXT NOT NULL,
  boot_changed INTEGER NOT NULL CHECK (boot_changed IN (0, 1)),
  PRIMARY KEY (machine_id, from_at)
);
CREATE INDEX machine_gaps_machine_until ON machine_gaps(machine_id, until_at);
CREATE INDEX machine_gaps_until ON machine_gaps(until_at);
