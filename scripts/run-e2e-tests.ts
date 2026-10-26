import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import sql from "mssql";

// Runs tests/e2e against disposable SQL Server, Redis and RustFS containers.
// Nothing from the developer's .env (corporate SQL, shared Redis, real S3) is passed to the tests.
const composeFile = "docker-compose.e2e.yml";
const project = "bmw-transformer-e2e";
const password = `Aa1!${randomBytes(24).toString("hex")}z`;
const baseEnvironment = { ...process.env };
for (const name of Object.keys(baseEnvironment)) if (/^(SQL_|S3_|BMW_|AWS_|REDIS_|E2E_)/i.test(name)) delete baseEnvironment[name];
const composeEnvironment = { ...baseEnvironment, E2E_SA_PASSWORD: password };

const testEnvironment = {
  ...baseEnvironment,
  TRANSFORMER_E2E: "true",
  HOST: "127.0.0.1",
  REDIS_URL: "redis://127.0.0.1:26379",
  S3_ENDPOINT: "http://127.0.0.1:29000",
  S3_REGION: "us-east-1",
  S3_ACCESS_KEY: "e2etestaccess",
  S3_SECRET_ACCESS_KEY: "e2etestsecret-only-for-local-tests",
  S3_BUCKET: "bmw-transformer-e2e",
  S3_PREFIX: "e2e",
  S3_FORCE_PATH_STYLE: "true",
  S3_AUTO_CREATE_BUCKET: "true",
  SQL_ENABLED: "true",
  SQL_SERVER: "127.0.0.1",
  SQL_PORT: "21433",
  SQL_DATABASE: "BMW_Labour",
  SQL_TLS_SERVER_NAME: "localhost",
  SQL_USER: "sa",
  SQL_PASSWORD: password,
  SQL_ENCRYPT: "true",
  SQL_TRUST_SERVER_CERTIFICATE: "true",
};

const redact = (text: string) => text.replaceAll(password, "<redacted>");

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit", shell: process.platform === "win32" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited with status ${code ?? "signal"}`)));
  });
}
const compose = (...args: string[]) => run("docker", ["compose", "-p", project, "-f", composeFile, ...args], composeEnvironment);

async function waitFor(label: string, attempt: () => Promise<void>, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try { await attempt(); return; }
    catch (error) { last = redact(error instanceof Error ? error.message : String(error)); await new Promise(resolve => setTimeout(resolve, 2000)); }
  }
  throw new Error(`Timed out waiting for ${label}${last ? ` (${last})` : ""}`);
}

async function prepareSqlServer() {
  await waitFor("the disposable SQL Server", async () => {
    const pool = new sql.ConnectionPool({ server: "127.0.0.1", port: 21433, user: "sa", password, database: "master", connectionTimeout: 2500, requestTimeout: 8000, options: { encrypt: true, trustServerCertificate: true, serverName: "localhost" } });
    try {
      await pool.connect();
      await pool.request().batch("IF DB_ID(N'BMW_Labour') IS NULL CREATE DATABASE [BMW_Labour] COLLATE Latin1_General_CI_AS;");
    } finally { await pool.close().catch(() => undefined); }
  });
  // nomCamposTabla belongs to the legacy database, so the service expects it to exist.
  const pool = new sql.ConnectionPool({ server: "127.0.0.1", port: 21433, user: "sa", password, database: "BMW_Labour", options: { encrypt: true, trustServerCertificate: true, serverName: "localhost" } });
  await pool.connect();
  try {
    await pool.request().batch(`
      IF OBJECT_ID(N'dbo.nomCamposTabla', N'U') IS NULL
      CREATE TABLE dbo.nomCamposTabla (
        brand nchar(10) COLLATE Latin1_General_CI_AS NULL, Model nchar(10) COLLATE Latin1_General_CI_AS NOT NULL, NomTable nchar(12) COLLATE Latin1_General_CI_AS NULL,
        nomCampo nchar(10) COLLATE Latin1_General_CI_AS NULL, Orden numeric(18,0) NULL, estado char(1) COLLATE Latin1_General_CI_AS DEFAULT '1' NULL,
        visible char(1) COLLATE Latin1_General_CI_AS DEFAULT '1' NULL, nomCampoVisible nchar(10) COLLATE Latin1_General_CI_AS NULL
      );`);
  } finally { await pool.close(); }
}

let started = false;
let failure: unknown;
try {
  started = true;
  await compose("up", "-d", "--wait", "redis", "rustfs");
  await compose("up", "-d", "sqlserver");
  await prepareSqlServer();
  await run("bun", ["test", "--config=bunfig.flow.toml", "tests/e2e"], testEnvironment);
} catch (error) {
  failure = error;
} finally {
  if (started) await compose("down", "--remove-orphans", "--volumes").catch(error => console.error("Could not stop the e2e containers:", redact(error instanceof Error ? error.message : String(error))));
}
if (failure) {
  console.error(redact(failure instanceof Error ? failure.message : String(failure)));
  process.exit(1);
}
