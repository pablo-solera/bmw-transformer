import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import sql from "mssql";

const composeFile = "docker-compose.sql-test.yml";
const project = "bmw-transformer-sql-test";
const password = `Aa1!${randomBytes(24).toString("hex")}z`;
const baseEnvironment = { ...process.env };
for (const name of Object.keys(baseEnvironment)) if (/^(SQL_|S3_|BMW_|AWS_)/i.test(name)) delete baseEnvironment[name];
const environment = { ...baseEnvironment, SQL_TEST_SA_PASSWORD: password };

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit", shell: process.platform === "win32" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited with status ${code ?? "signal"}`)));
  });
}

async function waitForSqlServer() {
  const deadline = Date.now() + 30000;
  let lastError: string | undefined;
  while (Date.now() < deadline) {
    const pool = new sql.ConnectionPool({
      server: "127.0.0.1",
      port: 11433,
      user: "sa",
      password,
      database: "master",
      connectionTimeout: 2500,
      requestTimeout: 5000,
      options: { encrypt: true, trustServerCertificate: true, serverName: "localhost" },
    });
    try {
      await pool.connect();
      const database = await pool.request().query<{ databaseId: number | null }>("SELECT DB_ID(N'BMW_Labour') AS databaseId;");
      if (database.recordset[0]?.databaseId == null) await pool.request().batch("CREATE DATABASE [BMW_Labour] COLLATE Latin1_General_CI_AS;");
      await pool.close();
      return;
    } catch (error) {
      const record = error as { name?: string; code?: string; message?: string; originalError?: { code?: string; message?: string } };
      const message = record.originalError?.message ?? record.message ?? "";
      lastError = `${record.name ?? "Error"}${record.code ? `/${record.code}` : ""}${record.originalError?.code ? `/${record.originalError.code}` : ""}${message ? `: ${message.replaceAll(password, "<redacted>")}` : ""}`;
      await pool.close().catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
  await run("docker", ["compose", "-p", project, "-f", composeFile, "ps", "--all"], environment).catch(() => undefined);
  await run("docker", ["compose", "-p", project, "-f", composeFile, "logs", "--no-color", "--tail=80", "sqlserver"], environment).catch(() => undefined);
  throw new Error(`Timed out waiting for the disposable SQL Server test container${lastError ? ` (${lastError})` : ""}`);
}

let composeStarted = false;
try {
  composeStarted = true;
  await run("docker", ["compose", "-p", project, "-f", composeFile, "up", "-d"], environment);
  await waitForSqlServer();
  await run("bun", ["test", "tests/sql-persistence.integration.test.ts"], {
    ...environment,
    SQL_INTEGRATION: "true",
    SQL_ENABLED: "true",
    SQL_SERVER: "127.0.0.1",
    SQL_PORT: "11433",
    SQL_DATABASE: "BMW_Labour",
    SQL_TLS_SERVER_NAME: "localhost",
    SQL_USER: "sa",
    SQL_PASSWORD: password,
    SQL_ENCRYPT: "true",
    SQL_TRUST_SERVER_CERTIFICATE: "true",
  });
} finally {
  if (composeStarted) await run("docker", ["compose", "-p", project, "-f", composeFile, "down", "--remove-orphans"], environment).catch(error => {
    console.error("Could not stop the disposable SQL Server test container:", error instanceof Error ? error.message : String(error));
  });
}
