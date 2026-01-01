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
  current_agent_id?: string | null;
};

/**
 * Extract assistant text from Letta response
 */
function pickAssistantText(lettaResp: any): string {
  console.log("pickAssistantText: Checking response for assistant text...");

  // Try multiple paths to find the messages array
  const msgs =
    lettaResp?.messages ??
    lettaResp?.data?.messages ??
    lettaResp?.data ??
    (Array.isArray(lettaResp) ? lettaResp : []);

  console.log("pickAssistantText: Found", Array.isArray(msgs) ? msgs.length : 0, "messages");

  if (Array.isArray(msgs)) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];

      // Direct string content
      if (m?.role === "assistant" && typeof m?.content === "string") {
        console.log("pickAssistantText: Found assistant message (string content)");
        return m.content.trim();
      }

      // Array of content blocks
      if (m?.role === "assistant" && Array.isArray(m?.content)) {
        const joined = m.content
          .map((c: any) => c?.text ?? "")
          .join("")
          .trim();
        if (joined) {
          console.log("pickAssistantText: Found assistant message (array content)");
          return joined;
        }
      }

      // Letta API format: message_type === "assistant_message" with content field
      if (m?.message_type === "assistant_message" && m?.content) {
        console.log("pickAssistantText: Found assistant_message with content");
        return String(m.content).trim();
      }

      // NEW: Check for internal_monologue or assistant_message text
      if (m?.role === "assistant" && m?.text) {
        console.log("pickAssistantText: Found assistant message with text field");
        return String(m.text).trim();
      }
    }
  }

  // Fallback paths
  if (lettaResp?.output) {
    console.log("pickAssistantText: Using fallback output field");
    return String(lettaResp.output).trim();
  }
  if (lettaResp?.text) {
    console.log("pickAssistantText: Using fallback text field");
    return String(lettaResp.text).trim();
  }

  console.warn("pickAssistantText: No text found in response");
  return "";
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
 * Returns both the DM text and the new agent ID
 */
export async function runDmTurn(params: {
  user: UserRow;
  env: LettaEnv;
  stateBucket: R2Bucket;
  moveText: string;
  canonicalStateHash: string;
  playerHandle: string;
}): Promise<{ text: string; agentId: string }> {
  // Import the shared canonical agent (creates a NEW agent)
  const agentId = await importAgentFromCanonicalAf(params);

  // Clean up ALL old bisky_copy agents except this new one
  // This runs AFTER import so we don't delete the new agent
  await cleanupOldAgents(params.user, params.env, agentId);

  // Build the DM prompt - emphasize brevity for Bluesky
  const prompt = `You are the Dungeon Master for a collaborative public Bluesky campaign.

CURRENT STATE HASH: ${params.canonicalStateHash}

PLAYER MOVE (@${params.playerHandle}):
${params.moveText}

---

CRITICAL: Write a SHORT DM narration (250 characters MAX). Be vivid but extremely concise. Describe what happens in response to the player's action, then end with a brief question like "What do you do?"

This will be posted on Bluesky which has strict character limits. Keep it punchy!`;

  const r = await lettaFetch(params.user, params.env, `/v1/agents/${agentId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
  });

  const j = await r.json();

  // Debug logging to see the actual response structure
  console.log("Letta API response keys:", Object.keys(j));
  console.log("Letta API response sample:", JSON.stringify(j).slice(0, 1000));

  const text = pickAssistantText(j);

  if (!text) {
    console.error("Empty Letta response - full response:", JSON.stringify(j, null, 2));
    console.error("Failed to extract text from response");
    return {
      text: "The DM ponders silently... (No response generated. Try again?)",
      agentId,
    };
  }

  console.log("Extracted DM text:", text.slice(0, 200));

  // Return both the text and the NEW agent ID (caller will save it)
  return { text, agentId };
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
 * List all agents for a user
 */
export async function listAgents(
  user: UserRow,
  env: LettaEnv
): Promise<any[]> {
  try {
    const r = await lettaFetch(user, env, "/v1/agents?limit=100", {
      method: "GET",
    });
    const data = (await r.json()) as any;
    return Array.isArray(data) ? data : data?.agents ?? [];
  } catch (e) {
    console.error("Failed to list agents:", e);
    return [];
  }
}

/**
 * Clean up old bisky_copy agents, keeping only the current one
 */
export async function cleanupOldAgents(
  user: UserRow,
  env: LettaEnv,
  currentAgentId: string
): Promise<void> {
  try {
    console.log("Cleaning up old bisky_copy agents...");
    const allAgents = await listAgents(user, env);

    // Filter for agents that look like imported copies
    // The canonical agent is named "bisky_copy" or similar when imported
    const importedAgents = allAgents.filter((a: any) => {
      const name = String(a.name ?? "").toLowerCase();
      return name.includes("bisky") || name.includes("copy");
    });

    console.log(`Found ${importedAgents.length} bisky_copy agents total`);

    // Delete all except the current one
    let deletedCount = 0;
    for (const agent of importedAgents) {
      if (agent.id !== currentAgentId) {
        console.log(`Deleting old agent: ${agent.id} (${agent.name})`);
        await deleteAgent(user, env, agent.id);
        deletedCount++;
      }
    }

    console.log(`Cleaned up ${deletedCount} old agents, kept ${currentAgentId}`);
  } catch (e) {
    console.error("Failed to cleanup old agents (non-fatal):", e);
  }
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
