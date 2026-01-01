/**
 * Letta API utilities for agent import/export and message handling
 */

import { decryptFromB64 } from "./crypto";

export type LettaEnv = {
  LETTA_BASE_URL: string;
  ENCRYPTION_KEY_B64: string;
  CANONICAL_AF_KEY: string;
};

export type UserRow = {
  did: string;
  handle: string;
  letta_base_url: string;
  letta_key_enc_b64: string;
};

/**
 * Extract assistant text from Letta response
 */
function pickAssistantText(lettaResp: any): string {
  // Letta returns messages array with various formats
  const msgs = lettaResp?.messages ?? lettaResp?.data?.messages ?? [];
  
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    
    // Direct string content
    if (m?.role === "assistant" && typeof m?.content === "string") {
      return m.content.trim();
    }
    
    // Array of content blocks
    if (m?.role === "assistant" && Array.isArray(m?.content)) {
      const joined = m.content
        .map((c: any) => c?.text ?? "")
        .join("")
        .trim();
      if (joined) return joined;
    }
    
    // Tool use response format
    if (m?.message_type === "assistant_message" && m?.assistant_message) {
      return String(m.assistant_message).trim();
    }
  }
  
  // Fallback
  return String(lettaResp?.output ?? lettaResp?.text ?? "").trim();
}

/**
 * Make authenticated request to Letta API
 */
async function lettaFetch(
  user: UserRow,
  env: LettaEnv,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const base = user.letta_base_url || env.LETTA_BASE_URL;
  const key = await decryptFromB64(user.letta_key_enc_b64, env.ENCRYPTION_KEY_B64);
  const url = new URL(path, base).toString();

  const r = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      Authorization: `Bearer ${key}`,
    },
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Letta ${r.status}: ${text.slice(0, 500)}`);
  }

  return r;
}

/**
 * Import agent from canonical .af file stored in R2
 * Returns the new agent ID
 */
export async function importAgentFromCanonicalAf(params: {
  user: UserRow;
  env: LettaEnv;
  stateBucket: R2Bucket;
}): Promise<string> {
  const obj = await params.stateBucket.get(params.env.CANONICAL_AF_KEY);
  if (!obj) {
    throw new Error(`Missing canonical.af in R2 at key: ${params.env.CANONICAL_AF_KEY}`);
  }

  const afBytes = await obj.arrayBuffer();
  
  // FormData for multipart file upload
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([afBytes], { type: "application/octet-stream" }),
    "canonical.af"
  );

  const r = await lettaFetch(params.user, params.env, "/v1/agents/import", {
    method: "POST",
    body: fd,
  });

  const j = (await r.json()) as any;

  // Letta API returns different formats:
  // - Single import: { id: "..." } or { agent_id: "..." }
  // - Batch import: { agent_ids: ["..."] }
  const agentId = j?.id ?? j?.agent_id ?? j?.agent?.id ?? j?.agent_ids?.[0];

  if (!agentId) {
    throw new Error(`Letta import did not return agent id: ${JSON.stringify(j)}`);
  }

  console.log("Imported Letta agent:", agentId);
  return agentId;
}

/**
 * Run a DM turn using the player's Letta credentials
 */
export async function runDmTurn(params: {
  user: UserRow;
  env: LettaEnv;
  stateBucket: R2Bucket;
  moveText: string;
  canonicalStateHash: string;
  playerHandle: string;
}): Promise<string> {
  // Import the shared canonical agent
  const agentId = await importAgentFromCanonicalAf(params);

  // Build the DM prompt
  const prompt = `You are the Dungeon Master for a collaborative public Bluesky campaign.

CURRENT STATE HASH: ${params.canonicalStateHash}

PLAYER MOVE (@${params.playerHandle}):
${params.moveText}

---

Write the next DM narration. Be vivid but concise. Describe what happens in response to the player's action, then end with a question or prompt for the next action like "What do you do?"

Keep your response under 2000 characters for Bluesky posting.`;

  const r = await lettaFetch(params.user, params.env, `/v1/agents/${agentId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
  });

  const j = await r.json();
  const text = pickAssistantText(j);
  
  if (!text) {
    console.error("Empty Letta response:", JSON.stringify(j).slice(0, 500));
    return "The DM ponders silently... (No response generated. Try again?)";
  }
  
  return text;
}

/**
 * Export agent state (for updating canonical after a turn)
 * Note: This exports core memory but NOT archival passages
 */
export async function exportAgentState(
  user: UserRow,
  env: LettaEnv,
  agentId: string
): Promise<any> {
  const r = await lettaFetch(user, env, `/v1/agents/${agentId}/export`, {
    method: "GET",
  });
  return await r.json();
}

/**
 * List archival passages for an agent
 */
export async function listArchivalPassages(
  user: UserRow,
  env: LettaEnv,
  agentId: string
): Promise<any[]> {
  const passages: any[] = [];
  let after: string | undefined;

  while (true) {
    const qs = new URLSearchParams({ limit: "100" });
    if (after) qs.set("after", after);

    const r = await lettaFetch(
      user,
      env,
      `/v1/agents/${agentId}/archival-memory?${qs.toString()}`,
      { method: "GET" }
    );

    const page = (await r.json()) as any[];
    if (!Array.isArray(page) || page.length === 0) break;

    passages.push(...page);
    after = page[page.length - 1]?.id;
    if (!after) break;
  }

  return passages;
}

/**
 * Delete a temporary agent (cleanup after turn)
 */
export async function deleteAgent(
  user: UserRow,
  env: LettaEnv,
  agentId: string
): Promise<void> {
  try {
    await lettaFetch(user, env, `/v1/agents/${agentId}`, {
      method: "DELETE",
    });
  } catch (e) {
    // Non-fatal: agent cleanup failure shouldn't break the flow
    console.error("Failed to delete temp agent:", e);
  }
}
