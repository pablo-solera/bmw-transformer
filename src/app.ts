import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { enqueueLoad, enqueueReport, getReportState, rollbackQueuedReport } from "./jobs.js";
import { openApiDocument } from "./openapi.js";
import { extractLstUpload } from "./dda/parse-lst.js";
import { objectKey, putBytes, signedDownload } from "./storage.js";
import type { ReportInput, ReportState } from "./types.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1, fields: 1 } });
export const reportInputSchema = z.object({
  axCode: z.string().min(1).max(10).regex(/^[A-Za-z0-9_]+$/),
  edition: z.string().min(1).max(10).regex(/^[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*$/),
  manufacturer: z.string().min(1).max(10).regex(/^[A-Za-z0-9_]+$/).default("BMW"),
  brand: z.string().min(1).max(10).regex(/^[A-Za-z0-9_]+$/).optional(),
  model: z.string().min(1).max(10).optional(),
  series: z.string().min(1).max(10).optional(),
  family: z.string().min(1).max(10).regex(/^[A-Za-z0-9_]+$/).optional(),
  date: z.string().regex(/^\d{8}$/).optional(),
  group: z.string().min(1).default(config.BMW_READER_GROUP),
  typekeys: z.array(z.object({
    typekey: z.string().regex(/^[A-Z0-9]{4}$/),
    baseType: z.string().min(1).max(10).optional(),
    series: z.string().min(1).max(10).optional(),
    family: z.string().min(1).max(10).regex(/^[A-Za-z0-9_]+$/).optional(),
  })).min(1),
}).superRefine((input, context) => {
  input.typekeys.forEach((item, index) => {
    if (!(item.series ?? input.series)) context.addIssue({ code: "custom", path: ["typekeys", index, "series"], message: `El typekey ${item.typekey} no tiene serie` });
    if (!(item.family ?? input.family)) context.addIssue({ code: "custom", path: ["typekeys", index, "family"], message: `El typekey ${item.typekey} no tiene familia` });
  });
});
const compareMetadataSchema = z.object({ loadId: z.string().uuid() });

function withDefaults(input: z.infer<typeof reportInputSchema>): ReportInput {
  const series = input.series ?? input.typekeys[0]?.series ?? "";
  return { ...input, brand: input.brand ?? input.manufacturer, model: input.model ?? series.replace(/'/g, "").trim() };
}
function duplicateTypekeys(input: { typekeys: Array<{ typekey: string }> }) {
  return [...new Set(input.typekeys.map(item => item.typekey).filter((typekey, index, list) => list.indexOf(typekey) !== index))];
}

type AppDependencies = {
  enqueueReport: (input: ReportInput, requestId: string, loadId?: string) => Promise<string>;
  enqueueLoad: (input: ReportInput) => Promise<{ loadId: string; reused: boolean }>;
  getReportState: (requestId: string) => Promise<ReportState | null>;
  rollbackQueuedReport: (requestId: string, input: ReportInput) => Promise<void>;
  objectKey: (...parts: string[]) => string;
  putBytes: (key: string, body: Uint8Array, contentType: string) => Promise<void>;
  signedDownload: (key: string, filename: string) => Promise<string>;
};

const defaults: AppDependencies = {
  enqueueReport: (input, requestId, loadId) => enqueueReport(input, requestId as `${string}-${string}-${string}-${string}-${string}`, loadId),
  enqueueLoad,
  getReportState, rollbackQueuedReport, objectKey, putBytes, signedDownload,
};

export function createApp(dependencies: AppDependencies = defaults) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/openapi.json", (_req, res) => res.json(openApiDocument));
  app.get("/docs", (_req, res) => res.type("html").send('<!doctype html><html><head><title>BMW Transformer API</title><link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script><script>SwaggerUIBundle({url:"/openapi.json",dom_id:"#swagger-ui"})</script></body></html>'));

  app.post("/loads", async (req, res) => {
    try {
      const parsed = reportInputSchema.parse(req.body);
      const duplicates = duplicateTypekeys(parsed);
      if (duplicates.length) return res.status(400).json({ error: `Typekeys duplicados: ${duplicates.join(", ")}` });
      const { loadId, reused } = await dependencies.enqueueLoad(withDefaults(parsed));
      return res.status(reused ? 200 : 202).json({ loadId, requestId: loadId, status: "queued", reused, statusUrl: `/loads/${loadId}` });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(issue => issue.message).join("; ") });
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/loads/:requestId", async (req, res) => {
    try {
      const value = await dependencies.getReportState(req.params.requestId);
      if (!value || value.kind !== "load") return res.status(404).json({ error: "Load not found" });
      return res.json(value);
    } catch (error) { return res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/reports", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Falta el fichero multipart 'file' (.LST o ZIP)" });
    const metadataValue = req.body?.metadata;
    if (typeof metadataValue !== "string") return res.status(400).json({ error: "Falta el campo multipart 'metadata' con el JSON de configuración" });
    const metadata: unknown = JSON.parse(metadataValue);
    const compareOnly = typeof metadata === "object" && metadata !== null && "loadId" in metadata;
    let loadId: string | undefined;
    let baseInput: ReportInput;
    if (compareOnly) {
      loadId = compareMetadataSchema.parse(metadata).loadId;
      const load = await dependencies.getReportState(loadId);
      if (!load || load.kind !== "load") return res.status(404).json({ error: "Load not found" });
      if (load.status !== "completed" || !load.pivotKey) return res.status(409).json({ error: "Load is not completed" });
      baseInput = load.input;
    } else {
      const input = reportInputSchema.parse(metadata);
      const duplicates = duplicateTypekeys(input);
      if (duplicates.length) return res.status(400).json({ error: `Typekeys duplicados: ${duplicates.join(", ")}` });
      baseInput = withDefaults(input);
    }
    const listing = extractLstUpload(new Uint8Array(req.file.buffer), req.file.originalname);
    const reportInput: ReportInput = { ...baseInput, sourceFilename: listing.filename };
    const requestId = randomUUID();
    const sourceKey = dependencies.objectKey(reportInput.group ?? "BMW", reportInput.manufacturer, "reports", reportInput.axCode, reportInput.edition, requestId, "source.lst");
    await dependencies.putBytes(sourceKey, listing.bytes, "application/octet-stream");
    try { await dependencies.enqueueReport(reportInput, requestId, loadId); }
    catch (error) { await dependencies.rollbackQueuedReport(requestId, reportInput); throw error; }
    return res.status(202).json({ requestId, status: "queued", statusUrl: `/reports/${requestId}` });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(issue => issue.message).join("; ") });
    return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
  });

  app.get("/reports/:requestId", async (req, res) => {
  try {
    const value = await dependencies.getReportState(req.params.requestId);
    if (!value) return res.status(404).json({ error: "Report not found" });
    return res.json(value);
  } catch (error) { return res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get("/reports/:requestId/download", async (req, res) => {
  try {
    const value = await dependencies.getReportState(req.params.requestId);
    if (!value) return res.status(404).json({ error: "Report not found" });
    if (value.status !== "completed" || !value.reportKey) return res.status(409).json({ error: "Report is not ready" });
    const url = await dependencies.signedDownload(value.reportKey, `${value.input.axCode}_${value.input.edition.replace(/\//g, "_")}_DDA_contra_BMW.xlsx`);
    return res.redirect(307, url);
  } catch (error) { return res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get("/reports/:requestId/source", async (req, res) => {
  try {
    const value = await dependencies.getReportState(req.params.requestId);
    if (!value) return res.status(404).json({ error: "Report not found" });
    const key = dependencies.objectKey(value.input.group ?? "BMW", value.input.manufacturer, "reports", value.input.axCode, value.input.edition, value.requestId, "source.lst");
    return res.redirect(307, await dependencies.signedDownload(key, "source.lst"));
  } catch (error) { return res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof multer.MulterError) return res.status(413).json({ error: error.message });
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  });
  return app;
}

export const app = createApp();
