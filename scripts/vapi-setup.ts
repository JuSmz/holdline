/**
 * Creates or updates Holdline's saved Vapi configuration (SPEC §14.1) — idempotent by name, free.
 *   1. the Bearer credential Vapi sends to our webhooks (VAPI_WEBHOOK_SECRET; never printed)
 *   2. the function tools (stage 4: the one dummy tool `get_services`)
 *   3. the assistant, then reads it back to verify what Vapi actually stored
 * Usage: pnpm vapi:setup https://holdline-web.onrender.com [--model gemini-3.5-flash]
 * Prints VAPI_ASSISTANT_ID (an ID, not a secret) for .env and the Render dashboard.
 */
import { readSecret, readVar } from "../src/server/config/env";
import {
  ASSISTANT_NAME,
  assistantBody,
  CREDENTIAL_NAME,
  SILENCE_TIMEOUT_SECONDS,
  TOOL_DEFINITIONS,
  toolBody,
  type SetupInput,
} from "../src/server/vapi/assistant-config";
import { getVapiClient, VapiApiError, type VapiClient } from "../src/server/vapi/client";

type Named = { id: string; name?: string };
type Tool = { id: string; type?: string; function?: { name?: string } };
type Assistant = Record<string, unknown> & {
  id: string;
  name?: string;
  model?: { provider?: string; model?: string; toolIds?: string[] };
  hooks?: { on?: string; options?: { timeoutSeconds?: number } }[];
  server?: { url?: string; credentialId?: string };
};

const DASHBOARD_STEPS = `Create the credential in the Vapi dashboard instead:
  Integrations → Server Configuration → Add Custom Credential → Bearer Token,
  name "${CREDENTIAL_NAME}", token = your VAPI_WEBHOOK_SECRET, header Authorization, Bearer prefix on.
Then put its ID into .env as VAPI_CREDENTIAL_ID=... and run this script again.`;

function numberVar(name: string, fallback: number): number {
  const raw = readVar(process.env, name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

/** The credential is not in Vapi's published API, so the script tries it and falls back to the dashboard. */
async function ensureCredential(client: VapiClient, token: string): Promise<string> {
  const fromEnv = readVar(process.env, "VAPI_CREDENTIAL_ID");
  if (fromEnv) {
    console.log(`credential: using VAPI_CREDENTIAL_ID (make sure its token equals VAPI_WEBHOOK_SECRET)`);
    return fromEnv;
  }
  const authenticationPlan = { type: "bearer", token, headerName: "Authorization", bearerPrefixEnabled: true };
  try {
    const existing = (await client.get<Named[]>("/credential?limit=100")).find((c) => c.name === CREDENTIAL_NAME);
    if (existing) {
      await client.patch(`/credential/${existing.id}`, { authenticationPlan });
      console.log(`credential: updated ${existing.id}`);
      return existing.id;
    }
    const created = await client.post<Named>("/credential", {
      provider: "custom-credential",
      name: CREDENTIAL_NAME,
      authenticationPlan,
    });
    console.log(`credential: created ${created.id}`);
    return created.id;
  } catch (error) {
    const detail = error instanceof VapiApiError ? `${error.status} ${error.detail}` : String(error);
    throw new Error(`could not create the credential through the API (${detail}).\n${DASHBOARD_STEPS}`);
  }
}

async function ensureTools(client: VapiClient, input: SetupInput): Promise<string[]> {
  const tools = await client.get<Tool[]>("/tool?limit=100");
  const ids: string[] = [];
  for (const def of TOOL_DEFINITIONS) {
    const body = toolBody(def, input);
    const existing = tools.find((t) => t.type === "function" && t.function?.name === def.name);
    if (existing) {
      // The tool type can't change on update.
      const update: Partial<typeof body> = { ...body };
      delete update.type;
      await client.patch(`/tool/${existing.id}`, update);
      console.log(`tool ${def.name}: updated ${existing.id}`);
      ids.push(existing.id);
    } else {
      const created = await client.post<Tool>("/tool", body);
      console.log(`tool ${def.name}: created ${created.id}`);
      ids.push(created.id);
    }
  }
  return ids;
}

/**
 * Saves the assistant. `silenceTimeoutSeconds` is not in the published schema; if Vapi rejects
 * it, the assistant is saved without it and the read-back below shows what stuck (R14).
 */
async function ensureAssistant(client: VapiClient, input: SetupInput, toolIds: string[]): Promise<string> {
  const base = assistantBody(input, toolIds);
  const withExtras = { ...base, silenceTimeoutSeconds: SILENCE_TIMEOUT_SECONDS };
  const existing = (await client.get<Named[]>("/assistant?limit=100")).find((a) => a.name === ASSISTANT_NAME);
  const save = (body: object) =>
    existing ? client.patch<Named>(`/assistant/${existing.id}`, body) : client.post<Named>("/assistant", body);
  try {
    const saved = await save(withExtras);
    console.log(`assistant: ${existing ? "updated" : "created"} ${saved.id}`);
    return saved.id;
  } catch (error) {
    if (!(error instanceof VapiApiError) || error.status !== 400) throw error;
    console.warn(`assistant: Vapi rejected the body with silenceTimeoutSeconds (${error.detail}); retrying without it`);
    const saved = await save(base);
    console.log(`assistant: ${existing ? "updated" : "created"} ${saved.id} (without silenceTimeoutSeconds)`);
    return saved.id;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const modelFlag = args.indexOf("--model");
  const model = modelFlag >= 0 ? args[modelFlag + 1] : readVar(process.env, "VAPI_LLM_MODEL");
  const appArg = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--model");
  if (!appArg) throw new Error("usage: pnpm vapi:setup https://<your-app-host> [--model <vapi model id>]");
  const appUrl = appArg.replace(/\/+$/, "");
  if (!appUrl.startsWith("https://")) throw new Error(`Vapi needs a public https URL (got ${appUrl})`);
  if (!model) throw new Error("set VAPI_LLM_MODEL in .env or pass --model <vapi model id>");
  const secret = readSecret(process.env, "VAPI_WEBHOOK_SECRET");
  if (!secret) throw new Error("VAPI_WEBHOOK_SECRET must be set in .env (at least 32 characters)");

  const client = getVapiClient();
  const credentialId = await ensureCredential(client, secret);
  const input: SetupInput = {
    appUrl,
    credentialId,
    provider: readVar(process.env, "VAPI_LLM_PROVIDER") ?? "google",
    model,
    maxTokens: numberVar("VAPI_LLM_MAX_TOKENS", 1000),
    temperature: numberVar("VAPI_LLM_TEMPERATURE", 1.0),
    maxCallSeconds: numberVar("VAPI_MAX_CALL_SECONDS", 480),
    instanceId: readVar(process.env, "APP_INSTANCE_ID") ?? "local",
  };
  const toolIds = await ensureTools(client, input);
  const assistantId = await ensureAssistant(client, input, toolIds);

  // Read back: what Vapi stored is what calls will use.
  const a = await client.get<Assistant>(`/assistant/${assistantId}`);
  const check = {
    model: `${a.model?.provider}/${a.model?.model}`,
    toolIds: a.model?.toolIds ?? [],
    maxDurationSeconds: a.maxDurationSeconds ?? "(default)",
    silenceTimeoutSeconds: a.silenceTimeoutSeconds ?? "(not stored)",
    hooks: (a.hooks ?? []).map((h) => `${h.on}@${h.options?.timeoutSeconds ?? "?"}s`),
    monitorPlan: a.monitorPlan ?? "(default)",
    artifactPlan: a.artifactPlan ?? "(default)",
    serverUrl: a.server?.url,
    serverCredentialSet: Boolean(a.server?.credentialId),
    serverMessages: a.serverMessages,
  };
  console.log(`\nstored assistant config:\n${JSON.stringify(check, null, 2)}`);
  console.log(`\nVAPI_ASSISTANT_ID=${assistantId}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
