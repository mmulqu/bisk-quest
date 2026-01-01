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

# 8. Start the listener
curl https://your-worker.workers.dev/api/start
```

## How It Works

1. **Players register once** on the companion site (Bluesky handle + Letta API key)
2. **Players mention the DM bot** on Bluesky with their actions
3. **System runs inference** using the player's Letta credentials
4. **DM bot posts the response** publicly in the thread
5. **State hash chain** keeps the story consistent

## API Endpoints

- `GET /api/status` - System status
- `POST /api/register` - Register player
- `GET /api/start` - Start Jetstream listener
- `GET /api/stop` - Stop listener
- `GET /api/turns` - Recent turns
- `GET /api/canonical` - Canonical state info

## Configuration

See `wrangler.toml` for environment variables.

## Files

```
src/
├── index.ts    # Worker + Durable Object
├── crypto.ts   # AES-256-GCM encryption
├── bsky.ts     # Bluesky API
└── letta.ts    # Letta API
public/
├── index.html  # Registration UI
└── styles.css  # Dark theme
```
