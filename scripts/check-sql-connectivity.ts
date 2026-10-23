import { isIP } from "node:net";
import { closeSqlPool, getSqlPool } from "../src/sql/client.js";
import { config } from "../src/config.js";

async function probeTcp(): Promise<string> {
  const server = config.SQL_SERVER.trim();
  const port = config.SQL_INSTANCE.trim() ? undefined : config.SQL_PORT;
  if (!server || !port) return "not-probed (server or named instance not configured)";
  const { createConnection } = await import("node:net");
  return new Promise(resolve => {
    const socket = createConnection({ host: server, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve("timeout");
    }, 5000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", error => {
      clearTimeout(timeout);
      resolve(`failed (${(error as NodeJS.ErrnoException).code ?? "socket error"})`);
    });
  });
}

function classifySqlFailure(error: unknown): string {
  const outer = error instanceof Error ? error : undefined;
  const cause = outer?.cause instanceof Error ? outer.cause : outer;
  const message = cause?.message ?? "";
  if (/certificate|self.signed|unable to verify|CERT_/i.test(message)) return "TLS certificate validation";
  if (/servername|server name|IP address is not permitted/i.test(message)) return "TLS server-name configuration";
  if (/login failed|ELOGIN/i.test(message)) return "SQL authentication";
  if (/cannot open database|database .* not found/i.test(message)) return "database selection or permissions";
  if (/timeout|ETIMEOUT/i.test(message)) return "connection timeout";
  const code = cause && "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
  return code ? `SQL driver error (${code})` : "SQL connection negotiation";
}

try {
  const pool = await getSqlPool();
  const database = await pool.request().query<{ databaseName: string; collation: string }>(
    "SELECT DB_NAME() AS databaseName, CAST(DATABASEPROPERTYEX(DB_NAME(), N'Collation') AS nvarchar(128)) AS collation;",
  );
  const existence = await pool.request().query<{ objectId: number | null }>(
    "SELECT OBJECT_ID(N'dbo.nomCamposTabla', N'U') AS objectId;",
  );
  const exists = existence.recordset[0]?.objectId != null;
  const columns = exists
    ? await pool.request().query<{ name: string; typeName: string; maxLength: number; nullable: boolean }>(
      "SELECT c.name, TYPE_NAME(c.user_type_id) AS typeName, c.max_length AS maxLength, c.is_nullable AS nullable FROM sys.columns AS c WHERE c.object_id = OBJECT_ID(N'dbo.nomCamposTabla') ORDER BY c.column_id;",
    )
    : undefined;

  console.log(JSON.stringify({
    connected: true,
    database: database.recordset[0]?.databaseName,
    collation: database.recordset[0]?.collation,
    nomCamposTabla: { exists, columns: columns?.recordset ?? [] },
  }));
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown SQL Server connection error";
  console.error(JSON.stringify({
    connected: false,
    error: message,
    failureCategory: classifySqlFailure(error),
    network: {
      serverKind: isIP(config.SQL_SERVER) === 4 ? "IPv4" : isIP(config.SQL_SERVER) === 6 ? "IPv6" : "hostname",
      port: config.SQL_INSTANCE.trim() ? null : config.SQL_PORT,
      tcp: await probeTcp(),
      tlsServerNameConfigured: Boolean(config.SQL_TLS_SERVER_NAME.trim()),
      encrypt: config.sqlEncrypt,
      trustServerCertificate: config.sqlTrustServerCertificate,
    },
  }));
  process.exitCode = 1;
} finally {
  await closeSqlPool();
}
