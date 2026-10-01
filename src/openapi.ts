export const openApiDocument = {
  openapi: "3.0.3",
  info: { title: "BMW Transformer API", version: "1.0.0", description: "Transforma datos BMW extraídos y un listado DDA .LST en un Excel legacy." },
  servers: [{ url: "http://localhost:3005" }],
  paths: {
    "/health": { get: { responses: { "200": { description: "Servicio disponible" } } } },
    "/reports": { post: { summary: "Encola un reporte", responses: { "202": { description: "Reporte encolado" }, "400": { description: "Petición inválida" } } } },
    "/reports/{requestId}": { get: { parameters: [{ in: "path", name: "requestId", required: true, schema: { type: "string" } }], responses: { "200": { description: "Estado del reporte" }, "404": { description: "Reporte no encontrado" } } } },
    "/reports/{requestId}/download": { get: { responses: { "307": { description: "Redirige al XLSX firmado" }, "409": { description: "Reporte aún no completado" } } } },
    "/reports/{requestId}/source": { get: { responses: { "307": { description: "Redirige al LST fuente" }, "404": { description: "Reporte no encontrado" } } } },
  },
} as const;
