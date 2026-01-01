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
      `INSERT INTO users(did, handle, letta_base_url, letta_key_enc_b64, created_at)
       VALUES(?, ?, ?, ?, datetime('now'))
       ON CONFLICT(did) DO UPDATE SET
         handle = excluded.handle,
         letta_base_url = excluded.letta_base_url,
         letta_key_enc_b64 = excluded.letta_key_enc_b64`
    )
    .bind(row.did, row.handle, row.letta_base_url, row.letta_key_enc_b64)
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

    return new Response("ok");
  }

  async alarm(): Promise<void> {
    if (!this.running) return;
    
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
    // Re-arm alarm with shorter interval (20s)
    await this.state.storage.setAlarm(Date.now() + 20_000);
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

    // Method 4: Check if this is a quote post of the bot
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

    // Mark as processing immediately
    await dbMarkProcessed(this.env.DB, uri);

    // Look up user
    const user = await dbGetUser(this.env.DB, authorDid);
    if (!user) {
      console.log("Unregistered player:", authorDid);
      // Optionally: post a reply telling them to register
      return;
    }

    console.log("Processing turn for:", user.handle);

    try {
      // Get current canonical state
      const meta = await getCanonicalMeta(this.env);

      // Run DM inference using player's Letta key
      const dmText = await runDmTurn({
        user,
        env: this.env,
        stateBucket: this.env.STATE,
        moveText: text,
        canonicalStateHash: meta.hash,
        playerHandle: user.handle,
      });

      // Compute new state hash
      const nextHash = await sha256Hex(`${meta.hash}\n${uri}\n${dmText}`);
      const shortHash = nextHash.slice(0, 12);

      // Build the reply text
      const tag = this.env.DM_TAG || "#DM";
      const replyText = `${dmText}\n\n${tag} state:${shortHash}`;

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
      console.error("Turn processing failed:", e?.message ?? e);
      // Don't un-mark as processed to avoid retry loops
    }
  }
}
