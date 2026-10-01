import { z } from "zod";

const schema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3005),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  STATE_TTL_SECONDS: z.coerce.number().int().positive().default(604800),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  S3_ENDPOINT: z.preprocess(value => value === "" ? undefined : value, z.string().url().optional()),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().default(""),
  S3_SECRET_ACCESS_KEY: z.string().default(""),
  S3_BUCKET: z.string().default("magnets-reader-dev"),
  S3_PREFIX: z.string().default(""),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("true"),
  S3_AUTO_CREATE_BUCKET: z.enum(["true", "false"]).default("false"),
  S3_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  LEGACY_LOCALE: z.string().default("es-ES"),
  LEGACY_ANSI_ENCODING: z.string().default("windows-1252"),
  BMW_READER_GROUP: z.string().default("BMW"),
});

const raw = schema.parse(process.env);
export const config = {
  ...raw,
  port: raw.PORT,
  s3ForcePathStyle: raw.S3_FORCE_PATH_STYLE === "true",
  s3AutoCreateBucket: raw.S3_AUTO_CREATE_BUCKET === "true",
} as const;
