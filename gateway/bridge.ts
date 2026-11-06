/**
 * How the voice runtime acts in the application: every read and write is a call to one of the
 * application's functions, made through its FeltKit component context as the declared principal
 * ("voice-runtime", role "voice"), in the business the event belongs to. FeltKit resolves that business
 * from the principal's *live* membership on every call: a business that removes the runtime is closed to
 * it on the next call. Roles, `authorize`, validation, transactions and Activity apply as for any caller.
 */
import { FeltKitError } from "@feltdb/feltkit";
import type { ComponentContext } from "@feltdb/feltkit/server";

export const VOICE_RUNTIME = { id: "voice-runtime", type: "agent" as const, displayName: "Voice runtime", roles: ["voice"] };

export class Bridge {
  constructor(readonly context: ComponentContext) {}

  /** Call a function ("module:function") as the voice runtime, optionally inside a business. */
  async call<T = any>(name: string, args: object = {}, businessId?: string): Promise<T> {
    try {
      return await this.context.call<T>(name, args, businessId ? { tenant: businessId } : {});
    } catch (error: any) {
      if (businessId && error?.code === "FORBIDDEN" && /not a member/.test(String(error?.message))) {
        throw new FeltKitError("FORBIDDEN", "The voice runtime is not a member of this business.", { hint: "An admin connects it on the Setup page." });
      }
      throw error;
    }
  }

  /** A declared credential's value from FeltKit's custody. Never logged or returned to a browser or model. */
  secret(id: string): Promise<string | null> {
    return this.context.credential(id);
  }
}
