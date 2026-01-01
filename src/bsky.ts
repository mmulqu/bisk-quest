/**
 * Bluesky/ATProto API utilities
 * Uses XRPC directly (no SDK dependency for Workers compatibility)
 */

export type BskyEnv = {
  DM_HANDLE: string;
  DM_APP_PASSWORD: string;
};

const BSKY_SERVICE = "https://bsky.social";
const BSKY_PUBLIC = "https://public.api.bsky.app";

/**
 * Resolve a Bluesky handle to DID
 */
export async function resolveHandleToDid(handle: string): Promise<string> {
  const url = `${BSKY_PUBLIC}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`;
  
  const r = await fetch(url);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`resolveHandle failed: ${r.status} ${text}`);
  }
  
  const j = (await r.json()) as { did: string };
  return j.did;
}

/**
 * Create authenticated session for DM bot
 */
export async function createSession(env: BskyEnv): Promise<{ accessJwt: string; did: string }> {
  const url = `${BSKY_SERVICE}/xrpc/com.atproto.server.createSession`;
  
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identifier: env.DM_HANDLE,
      password: env.DM_APP_PASSWORD,
    }),
  });
  
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`createSession failed: ${r.status} ${text}`);
  }
  
  const j = (await r.json()) as { accessJwt: string; did: string };
  return { accessJwt: j.accessJwt, did: j.did };
}

/**
 * Fetch a post thread (for getting root/parent info)
 */
export async function fetchThread(uri: string): Promise<any> {
  const url = `${BSKY_PUBLIC}/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=1`;
  
  const r = await fetch(url);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`getPostThread failed: ${r.status} ${text}`);
  }
  
  const j = (await r.json()) as { thread: any };
  return j.thread;
}

/**
 * Post a reply from the DM bot account
 */
export async function postReply(params: {
  env: BskyEnv;
  text: string;
  parentUri: string;
  parentCid: string;
  rootUri: string;
  rootCid: string;
}): Promise<{ uri: string; cid: string }> {
  const sess = await createSession(params.env);
  const url = `${BSKY_SERVICE}/xrpc/com.atproto.repo.createRecord`;

  // Bluesky limit is 300 graphemes (characters)
  // Truncate smartly to ensure we stay under the limit
  let text = params.text;
  const MAX_LENGTH = 280; // Leave some buffer for grapheme counting differences

  if (text.length > MAX_LENGTH) {
    // Find a good break point (last space before limit)
    const truncated = text.slice(0, MAX_LENGTH - 4);
    const lastSpace = truncated.lastIndexOf(' ');
    text = (lastSpace > MAX_LENGTH * 0.7 ? truncated.slice(0, lastSpace) : truncated) + '...';
    console.warn(`Post truncated from ${params.text.length} to ${text.length} characters`);
  }

  const record = {
    $type: "app.bsky.feed.post",
    text,
    createdAt: new Date().toISOString(),
    reply: {
      root: { uri: params.rootUri, cid: params.rootCid },
      parent: { uri: params.parentUri, cid: params.parentCid },
    },
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sess.accessJwt}`,
    },
    body: JSON.stringify({
      repo: sess.did,
      collection: "app.bsky.feed.post",
      record,
    }),
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`createRecord failed: ${r.status} ${text}`);
  }

  return (await r.json()) as { uri: string; cid: string };
}

/**
 * Post a new top-level post from the DM bot (for starting campaigns)
 */
export async function postNew(params: {
  env: BskyEnv;
  text: string;
}): Promise<{ uri: string; cid: string }> {
  const sess = await createSession(params.env);
  const url = `${BSKY_SERVICE}/xrpc/com.atproto.repo.createRecord`;

  const record = {
    $type: "app.bsky.feed.post",
    text: params.text,
    createdAt: new Date().toISOString(),
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sess.accessJwt}`,
    },
    body: JSON.stringify({
      repo: sess.did,
      collection: "app.bsky.feed.post",
      record,
    }),
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`createRecord failed: ${r.status} ${text}`);
  }

  return (await r.json()) as { uri: string; cid: string };
}
