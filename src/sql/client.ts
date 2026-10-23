import sql from "mssql";
import { config } from "../config.js";

let poolPromise: Promise<sql.ConnectionPool> | undefined;

export async function getSqlPool(): Promise<sql.ConnectionPool> {
  if (!config.sqlEnabled) throw new Error("SQL persistence is disabled; set SQL_ENABLED=true to create BMW labour tables");
  if (!config.SQL_SERVER.trim() || !config.SQL_USER.trim() || !config.SQL_PASSWORD) {
    throw new Error("SQL_SERVER, SQL_USER and SQL_PASSWORD are required when SQL_ENABLED=true");
  }

  if (!poolPromise) {
    const poolConfig: sql.config = {
      server: config.SQL_SERVER.trim(),
      port: config.SQL_INSTANCE.trim() ? undefined : config.SQL_PORT,
      user: config.SQL_USER.trim(),
      password: config.SQL_PASSWORD,
      database: config.SQL_DATABASE,
      connectionTimeout: config.SQL_CONNECTION_TIMEOUT_MS,
      requestTimeout: config.SQL_REQUEST_TIMEOUT_MS,
      pool: { max: config.SQL_POOL_MAX, min: 0, idleTimeoutMillis: 30000 },
      options: {
        encrypt: config.sqlEncrypt,
        trustServerCertificate: config.sqlTrustServerCertificate,
        ...(config.SQL_TLS_SERVER_NAME.trim() ? { serverName: config.SQL_TLS_SERVER_NAME.trim() } : {}),
        ...(config.SQL_INSTANCE.trim() ? { instanceName: config.SQL_INSTANCE.trim() } : {}),
      },
    };
    poolPromise = new sql.ConnectionPool(poolConfig).connect().catch(error => {
      poolPromise = undefined;
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
      throw new Error(`Unable to connect to the configured SQL Server${code ? ` (${code})` : ""}`, { cause: error });
    });
  }
  return poolPromise;
}

export async function closeSqlPool(): Promise<void> {
  const pending = poolPromise;
  poolPromise = undefined;
  if (!pending) return;
  try { await (await pending).close(); }
  catch { /* Shutdown must not log connection configuration or mask the original worker exit. */ }
}
