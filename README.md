# BMW Transformer

API Bun/TypeScript que replica en memoria la transformación BMW de Acciona VB6 y genera el Excel **DDA contra BMW** a partir de los JSON de BMW ya extraídos por `bmw-reader` y un listado maestro Audatex `.LST`.

## Flujo

1. `POST /reports` recibe multipart `file` (`.LST` o ZIP con exactamente un `.LST`) y `metadata` JSON.
2. El worker busca, por typekey, el marcador `{typekey}_completed.json` más reciente en S3 bajo `BMW/{manufacturer}/labour/{series}/{family}/{YYYYMMDD}/{typekey}/` (o la fecha indicada).
3. Reproduce las etapas Acciona `Importar Datos` y `Comparar Types` en memoria, reemplaza atómicamente `[BMW_Labour].[dbo].[{AxCode}_{Edicion}]` y las filas correspondientes de `nomCamposTabla`, y luego genera `DDA contra BMW`.
4. Sube el XLSX, `pivot.json`, `summary.json` y el LST fuente a `{group}/{manufacturer}/reports/{AxCode}/{Edicion}/{requestId}/`.
5. Polling con `GET /reports/:requestId`; descarga con `GET /reports/:requestId/download` (307 a URL firmada S3).

La request usa `baseType` opcional. Acciona leía el catálogo de la carpeta `{baseType}` pero los HG de la carpeta `{typekey}`; si difieren, el catálogo puede no enlazar flatrates. Es un comportamiento legacy preservado.

## Inicio local

Requisitos: Bun 1.3+, Redis 7+, SQL Server accesible con permisos acotados en `BMW_Labour`, y acceso al bucket S3 usado por el reader.

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

## Pruebas

| Comando | Qué ejecuta | Necesita |
|---|---|---|
| `bun test` | Pruebas unitarias y de API (reglas legacy, parser del `.LST`, pivote, Excel, rutas HTTP con dependencias simuladas). | Nada |
| `bun run test:flow` | El flujo completo carga → pivote → comparación → Excel contra un almacenamiento en memoria, comparado con los resultados de referencia de `tests/fixtures/e2e/`. Corre en su propio proceso para no compartir mocks con el resto. | Nada |
| `bun run test` | Las dos anteriores seguidas. | Nada |
| `bun run test:sql` | Crear, reemplazar y revertir la tabla en un SQL Server desechable. | Docker |
| `bun run test:e2e` | El flujo real por HTTP: API, worker BullMQ, Redis, S3 (RustFS) y SQL Server desechables. Comprueba la tabla creada y sus columnas, `nomCamposTabla`, `pivot.json`, el Excel descargado por la URL firmada, la reutilización de cargas idénticas, el reemplazo de tablas y los fallos. | Docker |

`test:e2e` levanta `docker-compose.e2e.yml` (puertos 21433, 26379 y 29000, contraseña aleatoria) y borra del entorno cualquier variable `SQL_*`, `S3_*`, `REDIS_*` o `BMW_*`: **no usa el SQL corporativo, el Redis compartido ni el S3 real** aunque tengas un `.env`. Al terminar elimina contenedores y volúmenes.

Los datos de prueba son sintéticos (`tests/support/synthetic-extraction.ts`): una extracción con la misma estructura que escribe el reader, con dos typekeys de familias distintas, uno sin marcador `completed` y un `.LST` con un caso por cada regla de comparación. Si cambias a propósito una regla legacy, regenera las referencias con `UPDATE_GOLDEN=1 bun run test:flow` y revisa el diff de `tests/fixtures/e2e/` antes de commitear.

`bunfig.toml` excluye `tests/flow` y `tests/e2e` del `bun test` simple; esos directorios se ejecutan con `bunfig.flow.toml`.

## Carga y comparación por separado

La carga a `BMW_Labour` no necesita el `.LST`, así que puede lanzarse en cuanto una extracción termina:

1. `POST /loads` (JSON, mismos campos que `metadata`) lee los typekeys completados de S3, genera el pivote, escribe `[dbo].[AxCode_Edicion]` y `nomCamposTabla`, y guarda `pivot.json` en `{group}/{manufacturer}/loads/{axCode}/{edition}/{loadId}/`. Cada typekey puede llevar su propia `series` y `family`. Una carga idéntica (mismos typekeys, series, familias y fecha) que siga en cola o en curso se reutiliza y responde 200 con `reused: true`.
2. `GET /loads/{loadId}` devuelve el estado; al completarse incluye `pivotKey` y `summary`.
3. `POST /reports` con `metadata` = `{"loadId":"<uuid>"}` y el `.LST` solo compara contra el pivote de esa carga y genera el Excel (404 si la carga no existe, 409 si no está completada). Con los metadatos completos se mantiene el trabajo único de carga y comparación.

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

La respuesta es `202 { requestId, status, statusUrl }`. Endpoints adicionales: `GET /reports/:requestId`, `GET /reports/:requestId/download`, `GET /reports/:requestId/source`, `GET /health`, `GET /openapi.json`, `GET /docs`.

En `/docs`, abre `POST /reports` → **Try it out**. El formulario multipart muestra `file` como selector de fichero y `metadata` como campo de texto; pega el JSON del ejemplo en ese campo. Para descargar el XLSX una vez completado, abre `GET /reports/{requestId}/download` en una pestaña: el endpoint redirige a S3 y Swagger Try it out puede estar sujeto al CORS del bucket.

## SQL Server local

Para comprobar a mano que se crean las tablas, levanta un SQL Server persistente en Docker (la contraseña solo existe en tu shell):

```bash
export SQL_DEV_SA_PASSWORD='<una contraseña fuerte>'
docker compose -f docker-compose.sql-dev.yml up -d
docker compose -f docker-compose.sql-dev.yml exec sqlserver /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$SQL_DEV_SA_PASSWORD" -Q "IF DB_ID('BMW_Labour') IS NULL CREATE DATABASE [BMW_Labour] COLLATE Latin1_General_CI_AS"
```

En el `.env` del transformer: `SQL_ENABLED=true`, `SQL_SERVER=127.0.0.1`, `SQL_PORT=11434`, `SQL_DATABASE=BMW_Labour`, `SQL_USER=sa`, `SQL_PASSWORD` (la misma), `SQL_TRUST_SERVER_CERTIFICATE=true` y `SQL_TLS_SERVER_NAME=localhost`. Comprueba la conexión con `bun run check:sql`, lanza `bun run start` y `bun run worker`, y tras una carga (`POST /loads`) consulta las tablas:

```bash
docker compose -f docker-compose.sql-dev.yml exec sqlserver /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$SQL_DEV_SA_PASSWORD" -d BMW_Labour -Q "SELECT name FROM sys.tables; SELECT * FROM nomCamposTabla"
```

`bun run test:sql` prueba lo mismo de forma automática contra un SQL Server desechable.

## Compatibilidad legacy

El parser `RegistrosQ` sigue literalmente `feat/acciona-refactor-dotnet:infrastructure/Verbund/LstVerbundListingParser.cs`: bloque Q, Latin-1/Windows-1252, Tiempo offset 10/5 y Operacion offset 16/10. El filtro del Excel excluye `KN` y omite operaciones cuya frecuencia sea distinta de 1.

El port conserva errores y defectos observados: conversión `CDec` es-ES, lecturas `Line Input` sobre CR/CRLF, pérdida de `catalogPaths` salvo última ruta, `displayType` vacío, estado de comparación arrastrado entre entradas, `LIKE` con comodines, filas semilla, `Resume Next` modelado como errores ignorados dentro del pivote, extracción SA a offset fijo y coerción de cabeceras Excel. Las referencias de implementación están en `docs/legacy-mapping.md`.

La ordenación SQL collation `Latin1_General_CI_AS` se aproxima en JavaScript con `Intl.Collator`; los planes de ordenación/empates de SQL Server no son deterministas si el `ORDER BY` no desambigua las filas.

La operación Q se lee con longitud 12 para preservar el sufijo `ZAX` que aparece en el CSV de `RegistrosQ` de la comparación real. El parser C# actualmente versionado en `acciona` usa longitud 10; `docs/legacy-mapping.md` explica la diferencia observada. El pivote emula el `UPDATE` acumulativo, el `DISTINCT *`, los desempates por DDL y el `Trim` VB6. Para comparar con el CSV exportado, configura `BMW_LEGACY_PIVOT_CSV` y ejecuta `bun test --test-name-pattern "legacy-equivalent pivot rows"`; ese test lee S3 y necesita acceso al bucket.

## S3 y secretos

Configura `S3_ENDPOINT`, `S3_BUCKET`, credenciales, `S3_PREFIX`, `REDIS_URL` y la conexión `SQL_*` en `.env` o en el gestor de secretos del despliegue. SQL persistence está habilitada por defecto; sin SQL_SERVER/SQL_USER/SQL_PASSWORD el worker no arranca. No se guardan credenciales en jobs ni en logs. Para Docker Compose se usa Redis local; el SQL Server debe ser accesible desde el contenedor worker.

Comprueba la conexión SQL de solo lectura, incluyendo base, collation y esquema de `nomCamposTabla`, con `bun run check:sql`. El comando no muestra usuario ni contraseña.

La persistencia SQL es deliberadamente limitada al pivote por edición y `nomCamposTabla`, que consume el Visor de Acciona. El transformer no escribe las tablas staging, `LoRaro` ni `RegistrosQ`. Ver [Persistencia SQL legacy](docs/legacy-mapping.md#persistencia-sql-legacy) para columnas, reemplazo atómico, permisos y pruebas. Para probar contra un SQL Server efímero local: `bun run test:sql` (Docker requerido; usa credenciales aleatorias solo en el contenedor desechable).
