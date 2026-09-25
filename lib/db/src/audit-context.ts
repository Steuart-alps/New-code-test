import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";

/** Internal execution context, never populated from submitted actor fields. */
export const auditContext = new AsyncLocalStorage<{ actorId: number | null; active: boolean }>();

function actor() {
  const context = auditContext.getStore();
  return context?.active ? context.actorId : null;
}

/**
 * Drizzle-only adapter. Each implicit statement is a transaction on an exclusive
 * connection; explicit transactions set the actor immediately after BEGIN.
 * SET LOCAL cannot survive commit, rollback, or reuse by a different request.
 * The raw pool remains available to session storage and system maintenance.
 */
export function auditPool(pool: pg.Pool): pg.Pool {
  return new Proxy(pool, {
    get(target, property) {
      if (property === "query") return async (...args: any[]) => {
        const actorId = actor();
        if (actorId == null) return (target.query as any)(...args);
        const client = await target.connect();
        let broken = false;
        try {
          await client.query("BEGIN");
          await client.query("SELECT set_config('app.audit_actor', $1, true)", [String(actorId)]);
          const result = await (client.query as any)(...args);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          try { await client.query("ROLLBACK"); } catch { broken = true; }
          throw error;
        } finally {
          client.release(broken);
        }
      };
      if (property === "connect") return async () => {
        const client = await target.connect();
        const actorId = actor();
        let released = false;
        const releaseOnce = (destroy?: boolean | Error) => {
          if (released) return;
          released = true;
          client.release(destroy);
        };
        return new Proxy(client, {
          get(connection, key) {
            if (key === "release") return releaseOnce;
            if (key === "query") return async (...args: any[]) => {
              if (released) throw new Error("Audit transaction connection has been released");
              const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
              if (!/^\s*begin\b/i.test(text ?? "")) return (connection.query as any)(...args);
              // Drizzle executes BEGIN before entering its transaction
              // try/finally. We own cleanup if BEGIN or actor setup fails.
              try {
                const result = await (connection.query as any)(...args);
                await connection.query("SELECT set_config('app.audit_actor', $1, true)", [actorId == null ? "" : String(actorId)]);
                return result;
              } catch (error) {
                try { await connection.query("ROLLBACK"); } catch { /* Destroy below even if rollback fails. */ }
                finally { releaseOnce(true); }
                throw error;
              }
            };
            const value = Reflect.get(connection, key);
            return typeof value === "function" ? value.bind(connection) : value;
          },
        });
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}