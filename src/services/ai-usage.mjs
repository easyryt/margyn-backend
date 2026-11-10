import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { getDb, transaction } from "./db.mjs";
import { AppError } from "./errors.mjs";
import { ensureTokenAccount, assertAiAccess } from "./subscriptions.mjs";

const context = new AsyncLocalStorage();
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
// Provider totals already include cached input and reasoning; never add those details twice.
export function providerUsage(provider, payload) {
  if (provider === "openai") {
    const usage = payload?.usage;
    const inputTokens = count(usage?.input_tokens);
    const outputTokens = count(usage?.output_tokens);
    const totalTokens = count(usage?.total_tokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
    return inputTokens !== null && outputTokens !== null && totalTokens !== null && totalTokens >= inputTokens + outputTokens
      ? { inputTokens, outputTokens, totalTokens } : null;
  }
  const usage = payload?.usageMetadata;
  const prompt = count(usage?.promptTokenCount);
  const candidates = count(usage?.candidatesTokenCount) ?? 0;
  const thoughts = count(usage?.thoughtsTokenCount) ?? 0;
  const toolInput = count(usage?.toolUsePromptTokenCount) ?? 0;
  const totalTokens = count(usage?.totalTokenCount);
  if (prompt === null || totalTokens === null || totalTokens < prompt + candidates + thoughts + toolInput) return null;
  return { inputTokens: prompt + toolInput, outputTokens: totalTokens - prompt - toolInput, totalTokens };
}
export async function withAiUsage(userId, source, work) {
  const state = { userId, source, failure: null, tail: Promise.resolve() };
  return context.run(state, async () => {
    assertAiAccess(await ensureTokenAccount(userId));
    try {
      const result = await work();
      await state.tail;
      if (state.failure) throw state.failure;
      return result;
    } catch (error) {
      await state.tail;
      throw state.failure || error;
    }
  });
}
async function recordUsage(state, leaseId, provider, model, usage, uncertain) {
  await transaction(async (db, session) => {
    const account = await db.collection("token_accounts").findOne({ _id: state.userId, leaseId }, { session });
    if (!account) throw new AppError("AI usage could not be saved. Contact your administrator.", 503);
    await db.collection("token_events").insertOne({ _id: randomUUID(), type: "provider-usage", userId: state.userId,
      periodId: account.periodId, source: state.source, provider, model, createdAt: Date.now(),
      ...(usage || { inputTokens: null, outputTokens: null, totalTokens: null }), uncertain }, { session });
    await db.collection("token_accounts").updateOne({ _id: state.userId, leaseId }, { $inc: {
      inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0,
      usedTokens: usage?.totalTokens ?? 0, unreportedCalls: uncertain ? 1 : 0, revision: 1,
    } }, { session });
  });
}
async function callProvider(state, input, options, provider, fetcher) {
  if (state.failure) throw state.failure;
  const db = await getDb();
  const account = await ensureTokenAccount(state.userId);
  assertAiAccess(account);
  const leaseId = randomUUID();
  const now = Date.now();
  const locked = await db.collection("token_accounts").findOneAndUpdate({ _id: state.userId, revision: account.revision,
    $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }] },
    { $set: { leaseId, leaseUntil: now + 360_000, ...(account.imageLeaseId ? { imageLeaseUntil: now + 360_000 } : {}) } }, { returnDocument: "after" });
  if (!locked) throw new AppError("Another AI request is running or this subscription changed. Please try again shortly.", 429, 5);
  let recorded = false;
  let sent = false;
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  let model = url.pathname.match(/models\/([^/:]+)/)?.[1] || "";
  try {
    if (options?.body instanceof FormData) model = String(options.body.get("model") || "");
    else if (typeof options?.body === "string") {
      try { model = JSON.parse(options.body).model || model; } catch { /* Upstream validates request bodies. */ }
    }
    sent = true;
    const response = await fetcher(input, options);
    const payload = await response.clone().json().catch(() => null);
    const usage = providerUsage(provider, payload);
    // A rejected request without usage is not charged. A successful response without usage
    // or an ambiguous timeout puts the account on hold rather than inventing a token count.
    const uncertain = response.ok && !usage;
    if (usage || uncertain) {
      await recordUsage(state, leaseId, provider, model, usage, uncertain);
    }
    recorded = true;
    return response;
  } catch (error) {
    if (sent && !recorded) {
      await recordUsage(state, leaseId, provider, model, null, true);
      recorded = true;
    }
    throw error;
  } finally {
    // If persistence fails entirely, retain the lease so recovery places the account on hold.
    if (!sent || recorded) await db.collection("token_accounts").updateOne({ _id: state.userId, leaseId }, { $unset: { leaseId: "", leaseUntil: "" } });
  }
}
// This adapter is used only by provider callers; it never replaces global fetch.
export async function meteredFetch(input, options, fetcher = globalThis.fetch) {
  const state = context.getStore();
  if (!state) return fetcher(input, options);
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const provider = url.hostname === "api.openai.com" ? "openai"
    : url.hostname === "generativelanguage.googleapis.com" ? "gemini" : null;
  if (!provider) return fetcher(input, options);
  const pending = state.tail.then(() => callProvider(state, input, options, provider, fetcher));
  state.tail = pending.then(() => {}, error => { state.failure ||= error; });
  return pending;
}
