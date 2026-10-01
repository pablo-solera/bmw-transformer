import { S3Client, HeadBucketCommand, CreateBucketCommand, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import { config } from "./config.js";

const client = new S3Client({
  region: config.S3_REGION,
  endpoint: config.S3_ENDPOINT,
  forcePathStyle: config.s3ForcePathStyle,
  credentials: config.S3_ACCESS_KEY && config.S3_SECRET_ACCESS_KEY ? { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_ACCESS_KEY } : undefined,
  maxAttempts: 5,
  requestHandler: new FetchHttpHandler({ requestTimeout: config.S3_REQUEST_TIMEOUT_MS }),
});

export function objectKey(...parts: string[]) {
  return [config.S3_PREFIX, ...parts].map(part => part.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}

export async function ensureBucket() {
  try { await client.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET })); }
  catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (!config.s3AutoCreateBucket || status !== 404) throw error;
    await client.send(new CreateBucketCommand({ Bucket: config.S3_BUCKET }));
  }
}

export async function putBytes(key: string, body: Uint8Array, contentType: string) {
  await client.send(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
}
export async function deleteObject(key: string) {
  const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  await client.send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
}
export async function putJson(key: string, value: unknown) {
  await putBytes(key, new TextEncoder().encode(JSON.stringify(value, null, 2)), "application/json; charset=utf-8");
}
export async function getBytes(key: string): Promise<Uint8Array> {
  const result = await client.send(new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }));
  if (!result.Body) throw new Error(`S3 object has no body: ${key}`);
  return new Uint8Array(await result.Body.transformToByteArray());
}
export async function getJson<T>(key: string): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await getBytes(key))) as T;
}
export async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: config.S3_BUCKET, Prefix: prefix, ContinuationToken: token }));
    for (const item of page.Contents ?? []) if (item.Key) keys.push(item.Key);
    token = page.NextContinuationToken;
  } while (token);
  return keys;
}
export async function signedDownload(key: string, filename: string) {
  return getSignedUrl(client, new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key, ResponseContentDisposition: `attachment; filename="${filename.replace(/["\\]/g, "_")}"` }), { expiresIn: 900 });
}
