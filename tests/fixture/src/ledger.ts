import { DurableObject } from "cloudflare:workers";

// A raw Durable Object: wired up by `actors generate` (binding LEDGER + migration), called via durable(Ledger).
export class Ledger extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS lines (id INTEGER PRIMARY KEY AUTOINCREMENT, amount INTEGER NOT NULL)");
  }
  async add(amount: number): Promise<number> {
    this.ctx.storage.sql.exec("INSERT INTO lines (amount) VALUES (?)", amount);
    return this.total();
  }
  total(): number {
    return Number(this.ctx.storage.sql.exec("SELECT COALESCE(SUM(amount), 0) AS t FROM lines").one().t);
  }
}
