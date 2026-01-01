/**
 * Bluesky Letta DM - Cloudflare Worker
 *
 * Architecture:
 * - Cron trigger polls Bluesky notifications every minute
 * - Simple, reliable notification-based mention detection
 * - No WebSockets, no Durable Objects - just straightforward polling
 */

import { encryptToB64 } from "./crypto";
import { resolveHandleToDid, postReply, createSession, type BskyEnv } from "./bsky";
import { runDmTurn, exportAgentState, type LettaEnv, type UserRow } from "./letta";

// Combined environment type
export type Env = BskyEnv &
  LettaEnv & {
    DB: D1Database;
    STATE: R2Bucket;
    ASSETS: Fetcher;

    DM_MENTION: string;
    DM_TAG: string;
    CANONICAL_META_KEY: string;
    CANONICAL_PASSAGES_KEY: string;
  };

// ============================================================================
// Database Helpers
// ============================================================================

async function dbGetUser(db: D1Database, did: string): Promise<UserRow | null> {
  const r = await db.prepare("SELECT * FROM users WHERE did = ?").bind(did).first<UserRow>();
  return r ?? null;
}

async function dbUpsertUser(db: D1Database, row: UserRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users(did, handle, letta_base_url, letta_key_enc_b64, created_at, current_agent_id)
       VALUES(?, ?, ?, ?, datetime('now'), ?)
       ON CONFLICT(did) DO UPDATE SET
         handle = excluded.handle,
         letta_base_url = excluded.letta_base_url,
         letta_key_enc_b64 = excluded.letta_key_enc_b64,
         current_agent_id = excluded.current_agent_id`
    )
    .bind(row.did, row.handle, row.letta_base_url, row.letta_key_enc_b64, row.current_agent_id ?? null)
    .run();
}

async function dbWasProcessed(db: D1Database, uri: string): Promise<boolean> {
  const r = await db.prepare("SELECT uri FROM processed_posts WHERE uri = ?").bind(uri).first();
  return !!r;
}

async function dbMarkProcessed(db: D1Database, uri: string): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO processed_posts(uri, created_at) VALUES(?, datetime('now'))")
    .bind(uri)
    .run();
}

async function dbRecordTurn(
  db: D1Database,
  triggerUri: string,
  playerDid: string,
  playerHandle: string,
  stateHash: string,
  playerMessage: string,
  dmResponse: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO dm_turns(trigger_uri, player_did, player_handle, state_hash, player_message, dm_response, created_at)
       VALUES(?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .bind(triggerUri, playerDid, playerHandle, stateHash, playerMessage, dmResponse)
    .run();
}

async function dbUpdateUserAgentId(db: D1Database, did: string, agentId: string): Promise<void> {
  await db
    .prepare("UPDATE users SET current_agent_id = ? WHERE did = ?")
    .bind(agentId, did)
    .run();
}

async function dbGetBotState(db: D1Database, key: string): Promise<string | null> {
  const r = await db
    .prepare("SELECT value FROM bot_state WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return r?.value ?? null;
}

async function dbSetBotState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bot_state(key, value, updated_at) VALUES(?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, value)
    .run();
}

async function dbHasBotParticipatedInThread(db: D1Database, rootUri: string): Promise<boolean> {
  // Check if the bot has responded to this exact post, or any post in this thread
  // Use exact match instead of LIKE to avoid "pattern too complex" errors with AT URIs
  const r = await db
    .prepare("SELECT COUNT(*) as count FROM dm_turns WHERE trigger_uri = ?")
    .bind(rootUri)
    .first<{ count: number }>();
  return (r?.count ?? 0) > 0;
}

// ============================================================================
// Canonical State Helpers
// ============================================================================

type CanonicalMeta = {
  hash: string;
  updated_at: string;
  last_trigger_uri?: string;
  last_player?: string;
  turn_count?: number;
};

async function getCanonicalMeta(env: Env): Promise<CanonicalMeta> {
  const obj = await env.STATE.get(env.CANONICAL_META_KEY);
  if (!obj) {
    return { hash: "GENESIS", updated_at: new Date().toISOString(), turn_count: 0 };
  }
  try {
    return (await obj.json()) as CanonicalMeta;
  } catch {
    return { hash: "GENESIS", updated_at: new Date().toISOString(), turn_count: 0 };
  }
}

async function setCanonicalMeta(env: Env, meta: CanonicalMeta): Promise<void> {
  await env.STATE.put(env.CANONICAL_META_KEY, JSON.stringify(meta), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function sha256Hex(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ============================================================================
// Notification Polling Logic
// ============================================================================

async function pollAndProcessNotifications(env: Env): Promise<void> {
  try {
    console.log("Polling Bluesky notifications...");

    // Get last checked timestamp from database
    const lastChecked = await dbGetBotState(env.DB, "last_notification_check");
    const since = lastChecked || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    console.log("Checking notifications since:", since);

    // Create session to fetch notifications
    const session = await createSession(env);

    // Fetch notifications
    const notifUrl = `https://bsky.social/xrpc/app.bsky.notification.listNotifications?limit=50`;
    const notifRes = await fetch(notifUrl, {
      headers: { Authorization: `Bearer ${session.accessJwt}` }
    });

    if (!notifRes.ok) {
      console.error("Failed to fetch notifications:", notifRes.status);
      return;
    }

    const notifData = await notifRes.json() as any;
    const notifications = notifData?.notifications || [];

    // Filter for relevant mentions/replies after the last check
    const relevantNotifs = notifications.filter((n: any) => {
      // Skip if too old
      if (n.indexedAt < since) return false;

      // Skip reposts
      if (n.reason === 'repost') return false;

      // Include mentions and replies
      if (n.reason === 'mention' || n.reason === 'reply') return true;

      // Include quotes that mention the bot
      if (n.reason === 'quote') {
        const rec = n.record ?? {};
        const text = String(rec.text || "").toLowerCase();
        const mentionLower = env.DM_MENTION.toLowerCase();
        return text.includes(mentionLower);
      }

      return false;
    });

    console.log(`Found ${relevantNotifs.length} relevant notifications to process`);

    // Process each notification
    for (const notif of relevantNotifs) {
      const authorDid = notif.author?.did;
      const uri = notif.uri;
      const record = notif.record ?? {};
      const text = String(record.text ?? "");

      if (!authorDid || !uri) continue;

      // Check if already processed
      if (await dbWasProcessed(env.DB, uri)) {
        console.log("Already processed:", uri);
        continue;
      }

      console.log("Processing notification:", uri);

      // Get the post details to extract cid
      try {
        const postRes = await fetch(
          `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}`,
          { headers: { Authorization: `Bearer ${session.accessJwt}` } }
        );

        if (!postRes.ok) continue;

        const postData = await postRes.json() as any;
        const post = postData?.thread?.post;
        if (!post) continue;

        const cid = post.cid;

        // Check if this is a reply in a thread the bot participated in
        // If so, process even if no explicit mention
        const isThreadParticipation = record?.reply?.root?.uri
          ? await dbHasBotParticipatedInThread(env.DB, record.reply.root.uri)
          : false;

        // Skip if it's just a thread participation but not a direct mention/reply to us
        // (This prevents processing every message in a thread)
        if (isThreadParticipation && notif.reason !== 'mention' && notif.reason !== 'reply') {
          console.log("Skipping thread message (not direct mention/reply):", uri);
          continue;
        }

        // Look up user
        const user = await dbGetUser(env.DB, authorDid);
        if (!user) {
          console.log("Unregistered player:", authorDid);
          continue;
        }

        // Mark as processed
        await dbMarkProcessed(env.DB, uri);

        // Process the mention
        await processMention(env, {
          uri,
          authorDid,
          cid,
          record,
          text,
          user
        });

      } catch (e) {
        console.error("Error processing notification:", uri, e);
      }
    }

    // Update last checked timestamp
    const now = new Date().toISOString();
    await dbSetBotState(env.DB, "last_notification_check", now);
    console.log("Polling complete. Updated last check to:", now);

  } catch (e) {
    console.error("Error polling notifications:", e);
  }
}

async function processMention(env: Env, params: {
  uri: string;
  authorDid: string;
  cid: string;
  record: any;
  text: string;
  user: UserRow;
}): Promise<void> {
  try {
    console.log("Processing mention for:", params.user.handle);

    const meta = await getCanonicalMeta(env);

    const { text: dmText, agentId } = await runDmTurn({
      user: params.user,
      env,
      stateBucket: env.STATE,
      moveText: params.text,
      canonicalStateHash: meta.hash,
      playerHandle: params.user.handle,
    });

    await dbUpdateUserAgentId(env.DB, params.user.did, agentId);

    // CRITICAL: Export the agent state AFTER the response (preserves memory block edits)
    console.log("Exporting updated agent state...");
    const updatedAgentState = await exportAgentState(params.user, env, agentId);

    // Save the updated .af file back to R2 as the new canonical state
    await env.STATE.put(
      env.CANONICAL_AF_KEY,
      JSON.stringify(updatedAgentState),
      { httpMetadata: { contentType: "application/json" } }
    );
    console.log("Saved updated agent state to R2");

    const nextHash = await sha256Hex(`${meta.hash}\n${params.uri}\n${dmText}`);
    const shortHash = nextHash.slice(0, 12);

    const tag = env.DM_TAG || "#DM";
    const footer = `\n\n${tag} state:${shortHash}`;
    const footerLength = footer.length;

    let trimmedDmText = dmText;
    const MAX_TOTAL_LENGTH = 280;

    if (dmText.length + footerLength > MAX_TOTAL_LENGTH) {
      const maxDmLength = MAX_TOTAL_LENGTH - footerLength - 3;
      const lastSpace = dmText.slice(0, maxDmLength).lastIndexOf(' ');
      trimmedDmText = dmText.slice(0, lastSpace > 0 ? lastSpace : maxDmLength) + '...';
    }

    const replyText = `${trimmedDmText}${footer}`;

    let rootUri = params.uri;
    let rootCid = params.cid;

    if (params.record?.reply?.root?.uri && params.record?.reply?.root?.cid) {
      rootUri = params.record.reply.root.uri;
      rootCid = params.record.reply.root.cid;
    }

    const posted = await postReply({
      env,
      text: replyText,
      parentUri: params.uri,
      parentCid: params.cid,
      rootUri,
      rootCid,
    });

    console.log("Posted DM reply:", posted.uri);

    await setCanonicalMeta(env, {
      hash: nextHash,
      updated_at: new Date().toISOString(),
      last_trigger_uri: params.uri,
      last_player: params.user.handle,
      turn_count: (meta.turn_count ?? 0) + 1,
    });

    // Record turn with player message and DM response for story display
    await dbRecordTurn(
      env.DB,
      params.uri,
      params.user.did,
      params.user.handle,
      nextHash,
      params.text, // Player's original message
      dmText // DM's full response (before truncation)
    );

    console.log("Turn complete. New state:", shortHash);
  } catch (e: any) {
    console.error("Mention processing failed:", e?.message ?? e);

    // Try to post error message to user
    try {
      await postReply({
        env,
        text: "Sorry, I encountered an error processing your request. Please try again later or check your Letta configuration.",
        parentUri: params.uri,
        parentCid: params.cid,
        rootUri: params.uri,
        rootCid: params.cid,
      });
    } catch (replyErr) {
      console.error("Failed to post error reply:", replyErr);
    }
  }
}

// ============================================================================
// Worker Fetch Handler
// ============================================================================

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // API: Get status
    if (url.pathname === "/api/status") {
      const meta = await getCanonicalMeta(env);
      const users = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
      const turns = await env.DB.prepare("SELECT COUNT(*) AS n FROM dm_turns").first<{ n: number }>();
      const lastCheck = await dbGetBotState(env.DB, "last_notification_check");

      return Response.json({
        ok: true,
        canonical_hash: meta.hash,
        turn_count: meta.turn_count ?? 0,
        last_update: meta.updated_at,
        last_player: meta.last_player,
        users: users?.n ?? 0,
        processed_turns: turns?.n ?? 0,
        last_notification_check: lastCheck,
        dm_mention: env.DM_MENTION,
        polling_enabled: true, // Cron-based polling is always active
      });
    }

    // API: Get recent turns
    if (url.pathname === "/api/turns") {
      const turns = await env.DB
        .prepare("SELECT * FROM dm_turns ORDER BY created_at DESC LIMIT 20")
        .all();

      return Response.json({
        ok: true,
        turns: turns.results ?? [],
      });
    }

    // API: Register a player
    if (url.pathname === "/api/register" && req.method === "POST") {
      try {
        const body = (await req.json()) as {
          handle?: string;
          lettaKey?: string;
          lettaBaseUrl?: string;
        };

        const handle = String(body?.handle ?? "").trim();
        const lettaKey = String(body?.lettaKey ?? "").trim();
        const lettaBaseUrl = String(body?.lettaBaseUrl || env.LETTA_BASE_URL).trim();

        if (!handle || !lettaKey) {
          return Response.json({ error: "handle and lettaKey are required" }, { status: 400 });
        }

        // Resolve handle to DID
        const did = await resolveHandleToDid(handle);

        // Encrypt the Letta key
        const enc = await encryptToB64(lettaKey, env.ENCRYPTION_KEY_B64);

        // Store in D1
        await dbUpsertUser(env.DB, {
          did,
          handle,
          letta_base_url: lettaBaseUrl,
          letta_key_enc_b64: enc,
        });

        return Response.json({ ok: true, did, handle });
      } catch (e: any) {
        console.error("Registration error:", e);
        return Response.json({ error: e?.message ?? "Registration failed" }, { status: 500 });
      }
    }

    // API: Get canonical state info
    if (url.pathname === "/api/canonical") {
      const meta = await getCanonicalMeta(env);
      const afObj = await env.STATE.get(env.CANONICAL_AF_KEY);

      return Response.json({
        ok: true,
        meta,
        af_exists: !!afObj,
        af_size: afObj?.size ?? 0,
        af_uploaded: afObj?.uploaded?.toISOString() ?? null,
      });
    }

    // Serve static assets (public/)
    return env.ASSETS.fetch(req);
  },

  // Cron-based polling for mentions (runs every minute)
  // Simple, reliable notification polling
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log("Cron trigger: Starting notification poll...");

    try {
      await pollAndProcessNotifications(env);
      console.log("Cron trigger: Poll complete");
    } catch (e) {
      console.error("Cron trigger error:", e);
    }
  },
};
