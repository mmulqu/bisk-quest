/**
 * Bluesky Letta DM - Cloudflare Worker
 * 
 * Architecture:
 * - Worker: handles /api routes + static assets
 * - Durable Object (JetstreamListener): maintains WebSocket to Bluesky firehose
 */

import { encryptToB64 } from "./crypto";
import { resolveHandleToDid, postReply, type BskyEnv } from "./bsky";
import { runDmTurn, deleteAgent, type LettaEnv, type UserRow } from "./letta";

// Combined environment type
export type Env = BskyEnv &
  LettaEnv & {
    DB: D1Database;
    STATE: R2Bucket;
    JET: DurableObjectNamespace;
    ASSETS: Fetcher;

    DM_MENTION: string;
    DM_TAG: string;
    JETSTREAM_URL: string;
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
  stateHash: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO dm_turns(trigger_uri, player_did, player_handle, state_hash, created_at)
       VALUES(?, ?, ?, ?, datetime('now'))`
    )
    .bind(triggerUri, playerDid, playerHandle, stateHash)
    .run();
}

async function dbUpdateUserAgentId(db: D1Database, did: string, agentId: string): Promise<void> {
  await db
    .prepare("UPDATE users SET current_agent_id = ? WHERE did = ?")
    .bind(agentId, did)
    .run();
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
// Worker Fetch Handler
// ============================================================================

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // API: Start the Jetstream listener
    if (url.pathname === "/api/start") {
      const id = env.JET.idFromName("singleton");
      const stub = env.JET.get(id);
      ctx.waitUntil(stub.fetch("https://do/start"));
      return Response.json({ ok: true, message: "Listener started" });
    }

    // API: Stop the listener
    if (url.pathname === "/api/stop") {
      const id = env.JET.idFromName("singleton");
      const stub = env.JET.get(id);
      ctx.waitUntil(stub.fetch("https://do/stop"));
      return Response.json({ ok: true, message: "Listener stopped" });
    }

    // API: Get status
    if (url.pathname === "/api/status") {
      const meta = await getCanonicalMeta(env);
      const users = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
      const turns = await env.DB.prepare("SELECT COUNT(*) AS n FROM dm_turns").first<{ n: number }>();

      return Response.json({
        ok: true,
        canonical_hash: meta.hash,
        turn_count: meta.turn_count ?? 0,
        last_update: meta.updated_at,
        last_player: meta.last_player,
        users: users?.n ?? 0,
        processed_turns: turns?.n ?? 0,
        dm_mention: env.DM_MENTION,
        jetstream: env.JETSTREAM_URL,
      });
    }

    // API: Get listener status (Durable Object)
    if (url.pathname === "/api/listener-status") {
      const id = env.JET.idFromName("singleton");
      const stub = env.JET.get(id);
      const doResponse = await stub.fetch("https://do/status");
      const doStatus = await doResponse.json();
      return Response.json({ ok: true, listener: doStatus });
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
        return Response.json({ error: e?.message || "Registration failed" }, { status: 500 });
      }
    }

    // API: List recent turns
    if (url.pathname === "/api/turns") {
      const turns = await env.DB
        .prepare(
          `SELECT trigger_uri, player_handle, state_hash, created_at 
           FROM dm_turns ORDER BY id DESC LIMIT 20`
        )
        .all();
      return Response.json({ ok: true, turns: turns.results });
    }

    // API: Get canonical state file info
    if (url.pathname === "/api/canonical") {
      const meta = await getCanonicalMeta(env);
      const afObj = await env.STATE.head(env.CANONICAL_AF_KEY);
      
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
  // This is more reliable than WebSocket-only approach
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log("Cron trigger: Checking for missed mentions...");

    try {
      // Get the JetstreamListener Durable Object
      const id = env.JET.idFromName("singleton");
      const stub = env.JET.get(id);

      // Trigger the catchup process
      ctx.waitUntil(stub.fetch("https://do/catchup"));

      console.log("Cron trigger: Catchup initiated");
    } catch (e) {
      console.error("Cron trigger error:", e);
    }
  },
};

// ============================================================================
// Durable Object: Jetstream Listener
// ============================================================================

export class JetstreamListener {
  private ws: WebSocket | null = null;
  private running = false;
  private botDid: string | null = null;
  private reconnectAttempts = 0;

  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/start") {
      this.running = true;
      // Resolve bot DID if not cached
      if (!this.botDid) {
        try {
          const r = await fetch(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${this.env.DM_HANDLE}`);
          const j = await r.json() as { did: string };
          this.botDid = j.did;
          console.log("Bot DID resolved:", this.botDid);
        } catch (e) {
          console.error("Failed to resolve bot DID:", e);
        }
      }

      // Process any missed mentions before starting the live stream
      this.state.waitUntil(this.catchUpOnMissedMentions());

      this.state.waitUntil(this.ensureConnected());
      // Shorter alarm interval for better keepalive (20s)
      await this.state.storage.setAlarm(Date.now() + 20_000);
      return new Response("started");
    }

    if (url.pathname === "/stop") {
      this.running = false;
      await this.state.storage.deleteAlarm();
      if (this.ws) {
        try {
          this.ws.close();
        } catch {}
        this.ws = null;
      }
      return new Response("stopped");
    }

    if (url.pathname === "/status") {
      return Response.json({
        running: this.running,
        connected: this.ws?.readyState === WebSocket.OPEN,
      });
    }

    if (url.pathname === "/catchup") {
      // Triggered by cron to check for missed mentions
      console.log("Catchup route triggered");
      this.state.waitUntil(this.catchUpOnMissedMentions());
      return new Response("catchup started");
    }

    return new Response("ok");
  }

  async alarm(): Promise<void> {
    if (!this.running) return;

    try {
      // Send ping to keep connection alive if connected
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ op: "ping" }));
        } catch (e) {
          console.error("Ping failed, reconnecting:", e);
          this.ws = null;
        }
      }

      // Ensure connection is active
      this.state.waitUntil(this.ensureConnected());
    } catch (e) {
      console.error("Alarm error (non-fatal):", e);
    } finally {
      // ALWAYS re-arm the alarm, even if there was an error
      try {
        await this.state.storage.setAlarm(Date.now() + 20_000);
      } catch (e) {
        console.error("Failed to re-arm alarm:", e);
      }
    }
  }

  private async ensureConnected(): Promise<void> {
    // Already connected or connecting
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    // Close existing connection if any
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }

    this.reconnectAttempts++;
    console.log(`Connecting to Jetstream (attempt ${this.reconnectAttempts}):`, this.env.JETSTREAM_URL);

    const ws = new WebSocket(this.env.JETSTREAM_URL);
    this.ws = ws;

    ws.addEventListener("open", () => {
      console.log("Jetstream connected");
      this.reconnectAttempts = 0; // Reset on successful connection
    });

    ws.addEventListener("close", (evt) => {
      console.log("Jetstream closed:", evt.code, evt.reason);
      this.ws = null;
      // Auto-reconnect if still running
      if (this.running) {
        setTimeout(() => this.ensureConnected(), 5000);
      }
    });

    ws.addEventListener("error", (evt) => {
      console.error("Jetstream error:", evt);
      this.ws = null;
    });

    ws.addEventListener("message", (evt) => {
      this.state.waitUntil(this.handleMessage(String(evt.data)));
    });
  }

  private async hasBotParticipatedInThread(rootUri: string): Promise<boolean> {
    try {
      // Check if any turn in this thread has been recorded
      const result = await this.env.DB
        .prepare("SELECT COUNT(*) as count FROM dm_turns WHERE trigger_uri LIKE ?")
        .bind(`%${rootUri}%`)
        .first<{ count: number }>();

      return (result?.count ?? 0) > 0;
    } catch (e) {
      console.error("Error checking thread participation:", e);
      return false;
    }
  }

  private async catchUpOnMissedMentions(): Promise<void> {
    try {
      console.log("Catching up on missed mentions...");

      // Get last processed timestamp from Durable Object storage
      const lastChecked = await this.state.storage.get<string>("last_notification_check");
      const since = lastChecked || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // Default: last 24h

      console.log("Checking notifications since:", since);

      // Create session to fetch notifications
      const { createSession } = await import("./bsky");
      const session = await createSession(this.env);

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
          const mentionLower = this.env.DM_MENTION.toLowerCase();
          return text.includes(mentionLower);
        }

        return false;
      });

      console.log(`Found ${relevantNotifs.length} missed notifications to process`);

      // Process each missed mention
      for (const notif of relevantNotifs) {
        const authorDid = notif.author?.did;
        const uri = notif.uri;
        const record = notif.record ?? {};
        const text = String(record.text ?? "");

        if (!authorDid || !uri) continue;

        // Check if already processed
        if (await dbWasProcessed(this.env.DB, uri)) {
          continue;
        }

        console.log("Processing missed mention:", uri);

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
          const rkey = uri.split('/').pop();

          // Process using the same logic as real-time mentions
          const user = await dbGetUser(this.env.DB, authorDid);
          if (!user) {
            console.log("Unregistered player:", authorDid);
            continue;
          }

          await dbMarkProcessed(this.env.DB, uri);

          // Queue the processing (don't await to avoid blocking catchup)
          this.state.waitUntil(this.processMention({
            uri,
            authorDid,
            cid,
            rkey: rkey || "",
            record,
            text,
            user
          }));

        } catch (e) {
          console.error("Error processing missed mention:", uri, e);
        }
      }

      // Update last checked timestamp
      const now = new Date().toISOString();
      await this.state.storage.put("last_notification_check", now);
      console.log("Catchup complete. Updated last check to:", now);

    } catch (e) {
      console.error("Error catching up on missed mentions:", e);
    }
  }

  private async processMention(params: {
    uri: string;
    authorDid: string;
    cid: string;
    rkey: string;
    record: any;
    text: string;
    user: UserRow;
  }): Promise<void> {
    try {
      console.log("Processing mention for:", params.user.handle);

      const meta = await getCanonicalMeta(this.env);

      const { text: dmText, agentId } = await runDmTurn({
        user: params.user,
        env: this.env,
        stateBucket: this.env.STATE,
        moveText: params.text,
        canonicalStateHash: meta.hash,
        playerHandle: params.user.handle,
      });

      await dbUpdateUserAgentId(this.env.DB, params.user.did, agentId);

      const nextHash = await sha256Hex(`${meta.hash}\n${params.uri}\n${dmText}`);
      const shortHash = nextHash.slice(0, 12);

      const tag = this.env.DM_TAG || "#DM";
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
        env: this.env,
        text: replyText,
        parentUri: params.uri,
        parentCid: params.cid,
        rootUri,
        rootCid,
      });

      console.log("Posted DM reply:", posted.uri);

      await setCanonicalMeta(this.env, {
        hash: nextHash,
        updated_at: new Date().toISOString(),
        last_trigger_uri: params.uri,
        last_player: params.user.handle,
        turn_count: (meta.turn_count ?? 0) + 1,
      });

      await dbRecordTurn(this.env.DB, params.uri, params.user.did, params.user.handle, nextHash);

      console.log("Turn complete. New state:", shortHash);
    } catch (e: any) {
      console.error("Mention processing failed:", e?.message ?? e);
    }
  }

  private async handleMessage(raw: string): Promise<void> {
    let evt: any;
    try {
      evt = JSON.parse(raw);
    } catch {
      return;
    }

    // Only process posts
    if (evt?.commit?.collection !== "app.bsky.feed.post") return;

    const authorDid = String(evt?.did ?? "");
    const rkey = String(evt?.commit?.rkey ?? "");
    const cid = String(evt?.commit?.cid ?? "");
    const record = evt?.commit?.record ?? {};
    const text = String(record?.text ?? "");

    if (!authorDid || !rkey || !cid) return;

    // Early filtering: Check if post is relevant to the bot
    const mentionLower = this.env.DM_MENTION.toLowerCase();
    const textLower = text.toLowerCase();
    let isRelevant = false;

    // Method 1: Check text for mention string
    if (textLower.includes(mentionLower)) {
      isRelevant = true;
      console.log("Detected text mention:", uri);
    }

    // Method 2: Check facets for @mention (more reliable)
    if (!isRelevant && this.botDid && record?.facets) {
      const facets = Array.isArray(record.facets) ? record.facets : [];
      isRelevant = facets.some((f: any) => {
        if (f?.features) {
          return f.features.some((feat: any) =>
            feat?.$type === "app.bsky.richtext.facet#mention" &&
            feat?.did === this.botDid
          );
        }
        return false;
      });
      if (isRelevant) {
        console.log("Detected facet mention:", uri);
      }
    }

    // Method 3: Check if this is a reply to the bot
    if (!isRelevant && this.botDid && record?.reply?.parent?.uri) {
      const parentUri = String(record.reply.parent.uri);
      // Check if parent URI belongs to the bot
      if (parentUri.includes(this.botDid)) {
        isRelevant = true;
        console.log("Detected reply to bot post:", uri);
      }
    }

    // Method 4: Check if this is in a thread the bot has participated in
    if (!isRelevant && record?.reply?.root?.uri) {
      const rootUri = String(record.reply.root.uri);
      // Check if bot has replied to this thread before
      const botParticipatedInThread = await this.hasBotParticipatedInThread(rootUri);
      if (botParticipatedInThread) {
        isRelevant = true;
        console.log("Detected post in thread with bot participation:", uri);
      }
    }

    // Method 5: Check if this is a quote post of the bot
    if (!isRelevant && this.botDid && record?.embed) {
      const embed = record.embed;
      // Check for direct quote (app.bsky.embed.record)
      if (embed?.$type === "app.bsky.embed.record" && embed?.record?.uri) {
        const quotedUri = String(embed.record.uri);
        if (quotedUri.includes(this.botDid)) {
          isRelevant = true;
          console.log("Detected quote post of bot:", uri);
        }
      }
      // Check for quote with media (app.bsky.embed.recordWithMedia)
      if (embed?.$type === "app.bsky.embed.recordWithMedia" && embed?.record?.record?.uri) {
        const quotedUri = String(embed.record.record.uri);
        if (quotedUri.includes(this.botDid)) {
          isRelevant = true;
          console.log("Detected quote+media post of bot:", uri);
        }
      }
    }

    // Skip if not relevant (early exit to reduce processing)
    if (!isRelevant) {
      return; // Silent skip - too many posts to log
    }

    const uri = `at://${authorDid}/app.bsky.feed.post/${rkey}`;
    console.log("Detected mention:", uri, "from", authorDid);

    // Dedup check
    if (await dbWasProcessed(this.env.DB, uri)) {
      console.log("Already processed:", uri);
      return;
    }

    // Look up user BEFORE marking as processed
    const user = await dbGetUser(this.env.DB, authorDid);
    if (!user) {
      console.log("Unregistered player:", authorDid, "- ignoring mention");
      // Don't mark as processed - this allows re-processing if they register later
      return;
    }

    // Mark as processing AFTER confirming user is registered
    await dbMarkProcessed(this.env.DB, uri);

    console.log("Processing turn for:", user.handle);

    try {
      // Get current canonical state
      const meta = await getCanonicalMeta(this.env);

      // Run DM inference using player's Letta key
      const { text: dmText, agentId } = await runDmTurn({
        user,
        env: this.env,
        stateBucket: this.env.STATE,
        moveText: text,
        canonicalStateHash: meta.hash,
        playerHandle: user.handle,
      });

      // Save the new agent ID for this user (so we can inspect it in Letta ADE)
      await dbUpdateUserAgentId(this.env.DB, user.did, agentId);
      console.log("Saved current agent ID for user:", agentId);

      // Compute new state hash
      const nextHash = await sha256Hex(`${meta.hash}\n${uri}\n${dmText}`);
      const shortHash = nextHash.slice(0, 12);

      // Build the reply text
      const tag = this.env.DM_TAG || "#DM";
      const footer = `\n\n${tag} state:${shortHash}`;
      const footerLength = footer.length;

      // Ensure the DM text + footer fits in Bluesky's 300 char limit
      let trimmedDmText = dmText;
      const MAX_TOTAL_LENGTH = 280;

      if (dmText.length + footerLength > MAX_TOTAL_LENGTH) {
        const maxDmLength = MAX_TOTAL_LENGTH - footerLength - 3; // -3 for "..."
        const lastSpace = dmText.slice(0, maxDmLength).lastIndexOf(' ');
        trimmedDmText = dmText.slice(0, lastSpace > 0 ? lastSpace : maxDmLength) + '...';
        console.log(`DM response truncated from ${dmText.length} to ${trimmedDmText.length} chars`);
      }

      const replyText = `${trimmedDmText}${footer}`;

      // Determine reply threading
      // If the post has a parent (is a reply), use that for threading
      // Otherwise, reply directly to this post as root
      let rootUri = uri;
      let rootCid = cid;

      if (record?.reply?.root?.uri && record?.reply?.root?.cid) {
        rootUri = record.reply.root.uri;
        rootCid = record.reply.root.cid;
      }

      // Post the DM reply
      const posted = await postReply({
        env: this.env,
        text: replyText,
        parentUri: uri,
        parentCid: cid,
        rootUri,
        rootCid,
      });

      console.log("Posted DM reply:", posted.uri);

      // Update canonical state
      await setCanonicalMeta(this.env, {
        hash: nextHash,
        updated_at: new Date().toISOString(),
        last_trigger_uri: uri,
        last_player: user.handle,
        turn_count: (meta.turn_count ?? 0) + 1,
      });

      // Record the turn
      await dbRecordTurn(this.env.DB, uri, user.did, user.handle, nextHash);

      console.log("Turn complete. New state:", shortHash);
    } catch (e: any) {
      console.error("Turn processing failed for", user.handle, ":", e?.message ?? e);
      console.error("Full error:", e);
      // Don't un-mark as processed to avoid retry loops
      // Consider posting an error reply to the user
      try {
        await postReply({
          env: this.env,
          text: "Sorry, I encountered an error processing your request. Please try again later or check your Letta configuration.",
          parentUri: uri,
          parentCid: cid,
          rootUri: uri,
          rootCid: cid,
        });
      } catch (replyErr) {
        console.error("Failed to post error reply:", replyErr);
      }
    }
  }
}
