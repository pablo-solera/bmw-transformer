# BMW Transformer

API Bun/TypeScript que replica en memoria la transformación BMW de Acciona VB6 y genera el Excel **DDA contra BMW** a partir de los JSON de BMW ya extraídos por `bmw-reader` y un listado maestro Audatex `.LST`.

## Flujo

1. `POST /reports` recibe multipart `file` (`.LST` o ZIP con exactamente un `.LST`) y `metadata` JSON.
2. El worker busca, por typekey, el marcador `{typekey}_completed.json` más reciente en S3 bajo `BMW/{manufacturer}/labour/{series}/{family}/{YYYYMMDD}/{typekey}/` (o la fecha indicada).
3. Reproduce las etapas Acciona `Importar Datos`, `Comparar Types` y `Generar Excel`, sin escribir a SQL Server.
4. Sube el XLSX, `pivot.json`, `summary.json` y el LST fuente a `BMW/reports/{AxCode}/{Edicion}/{requestId}/`.
5. Polling con `GET /reports/:requestId`; descarga con `GET /reports/:requestId/download` (307 a URL firmada S3).

La request usa `baseType` opcional. Acciona leía el catálogo de la carpeta `{baseType}` pero los HG de la carpeta `{typekey}`; si difieren, el catálogo puede no enlazar flatrates. Es un comportamiento legacy preservado.

## Inicio local

Requisitos: Bun 1.3+, Redis 7+ y acceso al bucket S3 usado por el reader.

```powershell
Copy-Item .env.example .env
bun install
docker compose up -d redis
bun run typecheck
bun test
```

En terminales separadas:

```powershell
bun run start
bun run worker
```

La API escucha en `http://127.0.0.1:3005`. Para validar con los ficheros de referencia:

```powershell
$env:BMW_DDA_SAMPLE_LST="C:\Users\Pablo.Avila\OneDrive - Solera Holdings, Inc\Desktop\WTCO015-LISTE.LST"
$env:BMW_DDA_REFERENCE_XLSX="C:\Users\Pablo.Avila\OneDrive - Solera Holdings, Inc\Desktop\1IX_04.xlsx"
bun test
```

## API

`POST /reports` requiere `multipart/form-data`:

- `file`: el `.LST` fuente, o un `.zip` que contenga solo un `.LST`.
- `metadata`: JSON, por ejemplo:

```json
{
  "axCode": "1IX",
  "edition": "04/0",
  "manufacturer": "BMW",
  "series": "5",
  "family": "G60",
  "typekeys": [
    { "typekey": "11CF" },
    { "typekey": "12CF", "baseType": "12CF" }
  ]
}
```

La respuesta es `202 { requestId, status, statusUrl }`. Endpoints adicionales: `GET /reports/:requestId`, `GET /reports/:requestId/download`, `GET /health`, `GET /openapi.json`, `GET /docs`.

## Compatibilidad legacy

El parser `RegistrosQ` sigue literalmente `feat/acciona-refactor-dotnet:infrastructure/Verbund/LstVerbundListingParser.cs`: bloque Q, Latin-1/Windows-1252, Tiempo offset 10/5 y Operacion offset 16/10. El filtro del Excel excluye `KN` y omite operaciones cuya frecuencia sea distinta de 1.

El port conserva errores y defectos observados: conversión `CDec` es-ES, lecturas `Line Input` sobre CR/CRLF, pérdida de `catalogPaths` salvo última ruta, `displayType` vacío, estado de comparación arrastrado entre entradas, `LIKE` con comodines, filas semilla, `Resume Next` modelado como errores ignorados dentro del pivote, extracción SA a offset fijo y coerción de cabeceras Excel. Las referencias de implementación están en `docs/legacy-mapping.md`.

La ordenación SQL collation `Latin1_General_CI_AS` se aproxima en JavaScript con `Intl.Collator`; los planes de ordenación/empates de SQL Server no son deterministas si el `ORDER BY` no desambigua las filas.

## S3 y secretos

Configura `S3_ENDPOINT`, `S3_BUCKET`, credenciales, `S3_PREFIX`, `REDIS_URL` en `.env`. No se guardan credenciales en los jobs ni en sus logs. Para Docker Compose se usa Redis local y los parámetros S3 del `.env`.
