-- Add thread tracking and model metadata
ALTER TABLE dm_turns ADD COLUMN thread_root_uri TEXT;
ALTER TABLE dm_turns ADD COLUMN model_used TEXT;

-- Index for faster thread grouping
CREATE INDEX IF NOT EXISTS idx_dm_turns_thread ON dm_turns(thread_root_uri);
