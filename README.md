# Bluesky Letta DM

A public D&D-style game on Bluesky where players interact via mentions and their own Letta accounts pay for inference.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Create infrastructure
wrangler d1 create dm-bluesky-letta
wrangler r2 bucket create dm-shared-state

# 3. Update wrangler.toml with your D1 database_id

# 4. Initialize database
npm run db:init

# 5. Upload your DM agent file
wrangler r2 object put dm-shared-state/canonical/canonical.af --file ./your-agent.af

# 6. Set secrets
wrangler secret put ENCRYPTION_KEY_B64
wrangler secret put DM_APP_PASSWORD

# 7. Deploy
npm run deploy
```

## Architecture

### Notification Polling System
- **Cron-based polling** runs every minute to check for new mentions
- **FIFO processing** using Bluesky's recommended `sortAt` timestamp logic
- **2-minute delay** between turns prevents race conditions
- **Deduplication** via database tracking (no notification processed twice)

### How It Works

1. **Players register once** on the companion site (Bluesky handle + Letta API key)
2. **Players mention the DM bot** on Bluesky with their actions
3. **Cron job polls** Bluesky notifications every minute
4. **Notifications sorted** by post creation time (oldest first) using `sortAt` logic
5. **One turn per cycle** - processes single mention, then waits 2 minutes
6. **System runs inference** using the player's Letta credentials
7. **DM bot posts the response** publicly in the thread
8. **State persisted** - agent state saved to R2, turn recorded in D1
9. **State hash chain** keeps the story consistent

### Timestamp Handling

Implements Bluesky's official [timestamp guidelines](https://docs.bsky.app/docs/advanced-guides/timestamps):
- Uses `sortAt` = earlier of `createdAt` and `indexedAt`
- Rejects far-future timestamps (uses `indexedAt` instead)
- Prevents client timestamp manipulation
- 2-minute clock skew window for distributed systems

### Race Condition Prevention

- **Sequential processing**: Only ONE mention processed per cron run
- **2-minute delay**: After processing a turn, waits 2 minutes before next
- **Database tracking**: Each notification URI marked as processed
- **FIFO queue**: Unprocessed notifications persist until handled

## API Endpoints

- `GET /api/status` - System status
- `POST /api/register` - Register player (Bluesky handle + Letta API key)
- `GET /api/turns` - Recent turns, grouped by thread
- `GET /api/canonical` - Canonical agent state info

## Database Schema

### `players`
Stores registered player credentials (encrypted Letta API keys)

### `dm_turns`
Records each game turn with:
- `trigger_uri` - Notification URI (for deduplication)
- `player_did` - Player's Bluesky DID
- `player_message` - Player's action text
- `dm_response` - DM's response text
- `thread_root_uri` - Thread grouping
- `model_used` - LLM model from agent config
- `state_hash` - Hash chain for consistency

### `bot_state`
Tracks polling state:
- `last_notification_check` - Last poll timestamp
- `last_process_time` - Last turn processing time (for 2-min delay)

## Configuration

See `wrangler.toml` for environment variables:
- `DM_MENTION` - Bot's Bluesky handle
- `DM_TAG` - Hashtag appended to responses
- `CANONICAL_AF_KEY` - R2 path to canonical agent file

## Files

```
src/
├── index.ts    # Cloudflare Worker with cron trigger
├── crypto.ts   # AES-256-GCM encryption for API keys
├── bsky.ts     # Bluesky ATP API integration
└── letta.ts    # Letta API integration + agent management
migrations/
├── 001_initial_schema.sql
├── 002_add_bot_state_table.sql
├── 003_add_message_columns.sql
└── 004_add_thread_and_model.sql
public/
├── index.html  # Registration UI + Story log viewer
└── styles.css  # Dark theme with thread grouping
```

## Story Log Frontend

The public interface displays:
- **Thread grouping**: Turns grouped by Bluesky thread
- **Expandable threads**: Click to show/hide thread details
- **Turn count**: Number of turns in each thread
- **Model metadata**: Shows which LLM model was used
- **Newest first**: Most recent threads at the top
