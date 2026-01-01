-- Add columns to store player messages and DM responses for display
ALTER TABLE dm_turns ADD COLUMN player_message TEXT;
ALTER TABLE dm_turns ADD COLUMN dm_response TEXT;
