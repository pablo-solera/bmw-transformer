import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { enqueueReport, getReportState, rollbackQueuedReport } from "./jobs.js";
import { openApiDocument } from "./openapi.js";
import { extractLstUpload } from "./dda/parse-lst.js";
import { objectKey, putBytes, signedDownload } from "./storage.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1, fields: 1 } });
const inputSchema = z.object({
  axCode: z.string().min(1).max(10).regex(/^[A-Za-z0-9_]+$/),
  edition: z.string().min(1).max(10).regex(/^[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*$/),
  manufacturer: z.string().min(1).max(10).regex(/^[A-Za-z0-9_]+$/).default("BMW"),
  series: z.string().min(1).max(10),
  family: z.string().min(1).max(10).regex(/^[A-Za-z0-9_]+$/),
  date: z.string().regex(/^\d{8}$/).optional(),
  group: z.string().min(1).default(config.BMW_READER_GROUP),
  typekeys: z.array(z.object({ typekey: z.string().regex(/^[A-Z0-9]{4}$/), baseType: z.string().min(1).max(10).optional() })).min(1),
});

export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/openapi.json", (_req, res) => res.json(openApiDocument));
app.get("/docs", (_req, res) => res.type("html").send('<!doctype html><html><head><title>BMW Transformer API</title><link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:"/openapi.json",dom_id:"#swagger-ui"})</script></body></html>'));

app.post("/reports", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Falta el fichero multipart 'file' (.LST o ZIP)" });
    const metadataValue = req.body?.metadata;
    if (typeof metadataValue !== "string") return res.status(400).json({ error: "Falta el campo multipart 'metadata' con el JSON de configuración" });
    const input = inputSchema.parse(JSON.parse(metadataValue));
    const duplicates = input.typekeys.map(item => item.typekey).filter((typekey, index, list) => list.indexOf(typekey) !== index);
    if (duplicates.length) return res.status(400).json({ error: `Typekeys duplicados: ${[...new Set(duplicates)].join(", ")}` });
    const listing = extractLstUpload(new Uint8Array(req.file.buffer), req.file.originalname);
    const reportInput = { ...input, sourceFilename: listing.filename };
    const requestId = randomUUID();
    const sourceKey = objectKey(input.group, input.manufacturer, "reports", input.axCode, input.edition, requestId, "source.lst");
    await putBytes(sourceKey, listing.bytes, "application/octet-stream");
    try { await enqueueReport(reportInput, requestId); }
    catch (error) { await rollbackQueuedReport(requestId, reportInput); throw error; }
    return res.status(202).json({ requestId, status: "queued", statusUrl: `/reports/${requestId}` });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(issue => issue.message).join("; ") });
    return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/reports/:requestId", async (req, res) => {
  try {
    const value = await getReportState(req.params.requestId);
    if (!value) return res.status(404).json({ error: "Report not found" });
    return res.json(value);
  } catch (error) { return res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.get("/reports/:requestId/download", async (req, res) => {
  try {
    const value = await getReportState(req.params.requestId);
    if (!value) return res.status(404).json({ error: "Report not found" });
    if (value.status !== "completed" || !value.reportKey) return res.status(409).json({ error: "Report is not ready" });
    const url = await signedDownload(value.reportKey, `${value.input.axCode}_${value.input.edition.replace(/\//g, "_")}_DDA_contra_BMW.xlsx`);
    return res.redirect(307, url);
  } catch (error) { return res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.get("/reports/:requestId/source", async (req, res) => {
  try {
    const value = await getReportState(req.params.requestId);
    if (!value) return res.status(404).json({ error: "Report not found" });
    const key = objectKey(value.input.group ?? "BMW", value.input.manufacturer, "reports", value.input.axCode, value.input.edition, value.requestId, "source.lst");
    return res.redirect(307, await signedDownload(key, "source.lst"));
  } catch (error) { return res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof multer.MulterError) return res.status(413).json({ error: error.message });
  return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
});
