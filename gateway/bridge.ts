/**
 * How the voice runtime acts in the application: every read and write is a FeltKit function call,
 * made as the runtime's own principal ("voice-runtime", role "voice"), in the business the event
 * belongs to. FeltKit resolves that business from the runtime's *live* membership on every call
 * (`runtime.withTenant`): a business that removes the runtime is closed to it on the next call.
 * Roles, `authorize`, argument validation, transactions and Activity all apply, as for any caller.
 */
import { FeltKitError } from "@feltdb/feltkit";
import type { FeltKitRuntime } from "@feltdb/feltkit/server";

export const VOICE_RUNTIME = { id: "voice-runtime", type: "agent" as const, displayName: "Voice runtime", roles: ["voice"] };

export class Bridge {
  #session: Promise<unknown> | null = null;
  constructor(readonly runtime: FeltKitRuntime) {}

  /** Call a function ("module:function") as the voice runtime, optionally inside a business. */
  async call<T = any>(name: string, args: object = {}, businessId?: string): Promise<T> {
    // A session, as every production caller holds: durable work the runtime starts runs as it, re-authorized.
    this.#session ??= this.runtime.issueSession(VOICE_RUNTIME, { kind: "agent", via: "runtime", label: "voice runtime" } as any).catch((e) => { this.#session = null; throw e; });
    await this.#session;
    const principal: any = businessId ? await this.runtime.withTenant(VOICE_RUNTIME, businessId) : VOICE_RUNTIME;
    if (businessId && !principal.tenant) throw new FeltKitError("FORBIDDEN", "The voice runtime is not a member of this business.", { hint: "An admin connects it on the Setup page." });
    let result = await this.runtime.call(name, args, { principal, via: "integration" });
    // CONFLICT: a record the call read changed before it committed; FeltKit wrote nothing, so it is safe to run again.
    for (let attempt = 1; !result.ok && result.error.code === "CONFLICT" && attempt <= 4; attempt++) {
      await new Promise((r) => setTimeout(r, 10 * attempt + Math.random() * 25));
      result = await this.runtime.call(name, args, { principal, via: "integration" });
    }
    if (!result.ok) throw new FeltKitError(result.error.code, result.error.message, { ...(result.error.details ? { details: result.error.details } : {}), ...(result.error.hint ? { hint: result.error.hint } : {}) });
    return result.value as T;
  }

  /** A credential's value, from FeltKit's custody (env FELTKIT_CREDENTIAL_<ID> or the encrypted vault). Never logged or returned to a browser or model. */
  async secret(id: string): Promise<string | null> {
    try {
      return await this.runtime.credentials.withSecret({ reference: { secretId: id }, context: { purpose: "telephony" } }, (s) => s.value);
    } catch {
      return null;
    }
  }
}
