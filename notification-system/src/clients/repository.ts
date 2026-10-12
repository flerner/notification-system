import type pg from "pg";

export interface ClientRecord {
  appKey: string;
  name: string;
  secretHash: string;
  revokedAt: Date | null;
}

export interface ClientRepository {
  findByKey(appKey: string): Promise<ClientRecord | null>;
  create(client: { appKey: string; name: string; secretHash: string }): Promise<void>;
}

export class PgClientRepository implements ClientRepository {
  constructor(private readonly db: pg.Pool) {}

  async findByKey(appKey: string): Promise<ClientRecord | null> {
    const { rows } = await this.db.query(
      `SELECT app_key AS "appKey", name, secret_hash AS "secretHash", revoked_at AS "revokedAt"
       FROM clients WHERE app_key = $1`,
      [appKey],
    );
    return rows[0] ?? null;
  }

  async create(client: { appKey: string; name: string; secretHash: string }): Promise<void> {
    await this.db.query("INSERT INTO clients (app_key, name, secret_hash) VALUES ($1, $2, $3)", [
      client.appKey,
      client.name,
      client.secretHash,
    ]);
  }
}
