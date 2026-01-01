-- Add column to track the current agent ID for each user
-- This allows us to delete old agents while keeping the latest one
ALTER TABLE users ADD COLUMN current_agent_id TEXT;
