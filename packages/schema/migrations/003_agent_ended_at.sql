-- 003_agent_ended_at: SubagentStop ends the subagent's agent row while the session stays active.

ALTER TABLE agents ADD COLUMN ended_at TEXT;
