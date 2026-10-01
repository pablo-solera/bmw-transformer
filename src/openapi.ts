const errorResponse = {
  description: "Error de la petición",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};
const requestIdParameter = { in: "path", name: "requestId", required: true, schema: { type: "string", format: "uuid" } };

export const openApiDocument = {
  openapi: "3.0.3",
  info: { title: "BMW Transformer API", version: "1.0.0", description: "Transforma datos BMW extraídos y un listado DDA .LST en un Excel legacy." },
  servers: [{ url: "/", description: "Mismo origen desde el que se sirve Swagger UI" }],
  paths: {
    "/health": {
      get: {
        operationId: "health",
        responses: {
          "200": {
            description: "Servicio disponible",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { status: { type: "string", example: "ok" } },
                  required: ["status"],
                },
              },
            },
          },
        },
      },
    },
    "/openapi.json": { get: { operationId: "getOpenApi", responses: { "200": { description: "Documento OpenAPI 3.0.3" } } } },
    "/docs": { get: { operationId: "getDocs", responses: { "200": { description: "Interfaz Swagger UI" } } } },
    "/reports": {
      post: {
        operationId: "createReport",
        summary: "Encola un reporte BMW DDA",
        description: "Sube el listado maestro `.LST` (o ZIP con un único `.LST`) y los metadatos como JSON serializado en el campo `metadata`.",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["file", "metadata"],
                properties: {
                  file: { type: "string", format: "binary", description: "Fichero .LST o ZIP con exactamente un .LST" },
                  metadata: {
                    type: "string",
                    description: "JSON serializado con los metadatos de la transformación. Copia y edita el ejemplo JSON.",
                    example: JSON.stringify({
                      axCode: "11I", edition: "05_0", manufacturer: "BMW", series: "4", family: "G26", date: "20260928", group: "BMW",
                      typekeys: [{ typekey: "11HC" }, { typekey: "21HC" }, { typekey: "23FB" }, { typekey: "33FB" }, { typekey: "41FR" }, { typekey: "53FB" }, { typekey: "61FR" }, { typekey: "61HC" }],
                    }),
                  },
                },
              },
              encoding: { metadata: { contentType: "text/plain" } },
            },
          },
        },
        responses: {
          "202": { description: "Reporte encolado; consulta statusUrl para seguir el progreso", content: { "application/json": { schema: { $ref: "#/components/schemas/EnqueuedReport" } } } },
          "400": errorResponse,
          "413": { description: "El fichero supera el límite de subida", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "500": errorResponse,
        },
      },
    },
    "/reports/{requestId}": {
      get: {
        operationId: "getReportStatus", summary: "Consulta el estado del reporte", parameters: [requestIdParameter],
        responses: {
          "200": { description: "Estado del reporte", content: { "application/json": { schema: { $ref: "#/components/schemas/ReportState" } } } },
          "404": errorResponse, "500": errorResponse,
        },
      },
    },
    "/reports/{requestId}/download": {
      get: {
        operationId: "downloadReport", summary: "Descarga el Excel de reporte",
        description: "Responde con 307 a una URL firmada de S3. Swagger Try it out puede estar limitado por CORS del bucket; para descargar, abre esta URL en una pestaña del navegador una vez el reporte esté completado.",
        parameters: [requestIdParameter],
        responses: {
          "307": { description: "Redirección al XLSX firmado", headers: { Location: { schema: { type: "string", format: "uri" } } } },
          "404": errorResponse,
          "409": { description: "El reporte aún no está listo", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "500": errorResponse,
        },
      },
    },
    "/reports/{requestId}/source": {
      get: {
        operationId: "downloadSourceListing", summary: "Descarga el LST original",
        description: "Responde con 307 a una URL firmada de S3. Swagger Try it out puede estar limitado por CORS del bucket; para descargar, abre esta URL en una pestaña del navegador.",
        parameters: [requestIdParameter],
        responses: {
          "307": { description: "Redirección al LST firmado", headers: { Location: { schema: { type: "string", format: "uri" } } } },
          "404": errorResponse, "500": errorResponse,
        },
      },
    },
  },
  components: {
    schemas: {
      Error: { type: "object", properties: { error: { type: "string" } }, required: ["error"] },
      EnqueuedReport: {
        type: "object",
        properties: { requestId: { type: "string", format: "uuid" }, status: { type: "string", enum: ["queued"] }, statusUrl: { type: "string", example: "/reports/09f62888-079a-4797-b028-8d5d002ce3f3" } },
        required: ["requestId", "status", "statusUrl"],
      },
      TypekeyInput: {
        type: "object", properties: { typekey: { type: "string", pattern: "^[A-Z0-9]{4}$", example: "11HC" }, baseType: { type: "string", maxLength: 10, description: "Opcional; por defecto el typekey" } }, required: ["typekey"],
      },
      ReportMetadata: {
        type: "object",
        properties: {
          axCode: { type: "string", maxLength: 10, example: "11I" }, edition: { type: "string", maxLength: 10, example: "05_0" },
          manufacturer: { type: "string", maxLength: 10, default: "BMW" }, series: { type: "string", maxLength: 10, example: "4" },
          family: { type: "string", maxLength: 10, example: "G26" }, date: { type: "string", pattern: "^\\d{8}$", example: "20260928" },
          group: { type: "string", default: "BMW" }, typekeys: { type: "array", minItems: 1, items: { $ref: "#/components/schemas/TypekeyInput" } },
        },
        required: ["axCode", "edition", "series", "family", "typekeys"],
      },
      ReportState: {
        type: "object",
        properties: {
          requestId: { type: "string", format: "uuid" }, status: { type: "string", enum: ["queued", "resolving", "importing", "pivoting", "parsing-dda", "reporting", "completed", "failed"] },
          stage: { type: "string" }, progress: { type: "integer", minimum: 0, maximum: 100 }, input: { $ref: "#/components/schemas/ReportMetadata" },
          reportKey: { type: "string" }, summary: { type: "object", additionalProperties: true }, error: { type: "string" },
          createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
        },
        required: ["requestId", "status", "stage", "progress", "input", "createdAt", "updatedAt"],
      },
    },
  },
} as const;
