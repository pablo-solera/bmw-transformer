# Mapeo de Acciona BMW VB6 a bmw-transformer

## Pipeline portado

| Acciona VB6 | Port TypeScript | Comportamiento relevante |
|---|---|---|
| `BMW_API2.frm:1296-1309` `iniciarCargaAutomatica` | `pipeline/run-report.ts` | Solo se importan typekeys COMPLETED; staging en memoria y persistencia del pivote legacy |
| `BMW_API2.frm:2325-2352` `cargaCompleta` | `pipeline/import-data.ts` | Elige marcador completado más reciente por typekey |
| `BMW_API2.frm:1074-1106` `typekeysRead` | `pipeline/import-data.ts` | Catálogo `{baseType}/{baseType}_catalog.json`; al leer CRLF, `aa` duplica la primera línea y omite la última |
| `BMW_API2.frm:1108-1139` `typekeyCatalogRead` | `pipeline/import-data.ts` | HG busca `{typekey}/{hg}/{typekey}_{hg}.json`; usa última línea VB6 para CRLF |
| `API_BMW.bas:260-295` `readComponentCatalogBMW` | `pipeline/import-data.ts` | Una fila por entry; acceso de `entries` obligatorio |
| `API_BMW.bas:296-349` `readComponentFlatrateGroupsMW` | `pipeline/import-data.ts` | Un rate por fila; `catalogPaths` se queda con la última ruta; `displayType` por typo queda vacío |
| `API_BMW.bas:369-378` `BorradoDatos` | Pipeline en memoria | No se conservan staging rows entre ejecuciones; no afecta al Excel |
| `BMW_API2.frm:1349-1401` `generarTabla` | `pipeline/pivot.ts`, `sql/labour-table.ts` | Nombre `<AxCode>_<Edicion>`, metadata `nomCamposTabla`, DDL y columnas de pivote |
| `BMW_API2.frm:1403-1558` `compararModelo` | `pipeline/pivot.ts`, `sql/persist-pivot.ts` | `LIKE '%suffix%'`, `SELECT DISTINCT *` con desempate por DDL, fila semilla, actualización acumulativa y persistencia de la tabla por edición |
| `BMW_API2.frm:1324-1347` `codigoEstrujen` | `pipeline/pivot.ts` | Extracción SA con `Mid(InStr + 19, 4)` literal |
| `BMW_API2.frm:2163-2259` `comparativaBMW_DDA` | `pipeline/pivot.ts`, `report/workbook.ts` | Operación única, búsqueda normalizada, red cells y ExcelJS |
| `LstVerbundListingParser.cs` (rama dotnet) | `dda/parse-lst.ts` | Offsets Q del cargador de `RegistrosQ`; BMW lee operación de 12 caracteres para conservar `ZAX`, según el cargador usado por el Excel comparado |

## Semántica del parser LST (rama dotnet)

El parser usa Encoding.Latin1, busca `ID = Q` que contenga `P A R T`, corta en el próximo `ID = <algo>`, y omite líneas en blanco, banners, cliente y cabeceras `VB S A`, `CO I C`, `P A R T`. Normaliza cadena vacía a null. Campos: WU/tiempo offset 10 length 5, Operacion offset 16 length **12** en el transformer para conservar `ZAX`, KL 29/1, texto 31/41, y demás offsets según `LstVerbundListingParser.cs`.

La versión del parser C# versionada en `feat/acciona-refactor-dotnet` usa `Operacion: Field(l, 16, 10)` y truncaría `41 12 190ZAX` a `41 12 190Z`. El CSV de `BMW_Labour.dbo.[11I_05/0]` exportado para esta comparación contiene la operación completa; por eso el transformer usa 12 caracteres. Este es un cambio deliberado para coincidir con el loader real que produjo `RegistrosQ` de ese Excel.

En la referencia `WTCO015-LISTE.LST` se extraen 2051 filas Q; 509 filas cumplen `Operacion <> KN` y `COUNT(Operacion)=1`, coincidiendo exactamente con operación y tiempo de las filas 4..512 de `1IX_04.xlsx`.

## Reglas y bugs preservados

- `vbTrim` solo elimina espacio ASCII; `vbMid` usa índices VB de base 1; `InStr` devuelve base 1 y 0 cuando no encuentra.
- `vbLineInputLines` reconoce CR y CRLF; LF queda dentro de la línea. Así, el JSON pretty serializado con LF por el fetcher se lee como una sola línea larga; con CRLF, `typekeysRead` duplica primera línea/omite última y `typekeyCatalogRead` pasa solo `Linea` (última línea).
- Campo JSON no presente asignado a String -> `""`; null asignado a String -> runtime error 94. Número JSON pasa por `CDec` dependiente de es-ES. Boolean a texto produce True/False.
- `typekeyCatalog` usa PK `(typekey, entriesId)` y tamaños nchar: typekey 10, id 35, number 10, text 70, entriesId 35, entriesNumber 10. `entriesText` es nvarchar(MAX). Duplicate PK y truncados son fatales en import.
- `typekeyIdEntriesId` es nvarchar(MAX) sin PK; permite duplicados. Las comillas no escapadas en su INSERT producen error fatal.
- Los ids de catálogo se insertan bajo baseType; los flatrates guardan el typekey leído por `typekeyCatalogRead` en `typekeyIdEntriesId`.
- `catalogPaths` se reemplaza durante el loop, por lo tanto queda la última; array vacío reutiliza valor de una fila anterior. `displayType` no se asigna a la variable declarada y se persiste vacío.
- `compararModelo` agrega seed `flatrates_number='0'` por entrada; `nuevaLine` compara solo rubrikText, text, awSheetOID, number y flatrates_text y no se reinicia entre entradas de catálogo. El UPDATE de valor aplica a todas las filas que cumplen la condición legacy; se indexan por esa condición para no recorrer el pivote completo en cada operación.
- `SELECT DISTINCT *` de tarifas elimina duplicados por todas las columnas según collation `Latin1_General_CI_AS`. Los desempates siguen `ORDER BY flatrates_number, flatrates_awSheetOID, typekeyIdEntriesId` y las restantes columnas en el orden físico del DDL.
- El CSV legacy demuestra que la primera fila por flatrates_number que usa el Excel es el primer registro del heap en el orden exportado. En una transformación puramente en memoria el orden físico del heap de SQL Server no puede reproducirse; la emulación usa orden de inserción determinista. Las 14 operaciones que dependen de la colocación física pueden seguir variando; requieren contrastar el CSV/Excel en cada validación.
- Los valores de pivote y los campos comparados en `compararModelo` pasan por `Trim` VB6 (espacios ASCII iniciales y finales), no por solo `trimEnd`.
- El CSV del pivote legacy confirmó que `UPDATE Type_X` acumula valores en todas las filas coincidentes de la condición, no solo en la semilla más reciente. El transformer indexa filas por condición SQL normalizada para replicarlo.
- Si el UPDATE de la semilla falla, `Resume Next` sigue ejecutándose y la condición avanza igualmente. Cada sentencia UPDATE SQL es atómica: no se aplican cambios parciales si falla.
- La relación de catálogo es `catalogPaths LIKE '%'+Mid(entriesId, InStr('_'))+'%'`. `_`, `%`, corchetes T-SQL y collation CI_AS alteran la coincidencia. Sin `_`, Mid falla y conserva el suffix anterior, inicialmente vacío.
- Errores dentro de `compararModelo` se omiten (equivalente a `On Error Resume Next`); el informe incluye `ignoredSqlErrors`.
- DDA descarta `KN`, nulos y toda operación cuya frecuencia no sea exactamente uno. Busca el primer flatrate con número normalizado (quita espacio, `)` y `ZAX`). ZAX prevalece sobre `)`.
- En Excel la cabecera usa `nomCampo` y no `nomCampoVisible`; Excel puede coercionar cadenas numéricas. Fuente de cabecera tamaño 12, dos filas vacías y título en fila 3.
- DDL confirma `Latin1_General_CI_AS`; la comparación es case-insensitive y accent-sensitive. La aproximación JS usa `Intl.Collator`, no el motor SQL Server. `comparativaBMW_DDA` pide `DISTINCT nomCampo` sin `ORDER BY`; el port conserva orden de inserción de los typekeys suministrados, ya que la salida SQL no define un orden garantizado.
- El Excel real demuestra que valores vacíos BMW quedan como celdas vacías y los valores AW numéricos como enteros. Las celdas DDA/BMW se colorean según las reglas VB6; no se colorean cabeceras ni columna vacía C.
- Prueba de pivote del CSV: `BMW_LEGACY_PIVOT_CSV="ruta\al\export.csv" bun test --test-name-pattern "legacy-equivalent pivot rows"`. El export tiene comillas, CRLF embebido, null como campo sin comillas y puede anteponer `'` al `-1`; el test contempla esos casos. El rebuild completo requiere S3 accesible. En la última comprobación, S3 respondió `ENOTFOUND s3-eu.solera.farm`, por lo que no se pudo terminar esa comparación.

## Persistencia SQL legacy

El transformer persiste el pivote para que la aplicación Acciona que consulta `BMW_Labour` siga viendo las ediciones. La escritura se ejecuta después de `buildLegacyPivot` y antes de parsear/comparar el bloque DDA, siguiendo el orden `Comparar Types` → `Generar Excel` de `BMW_API2.frm`.

### Tablas escritas

1. **`[dbo].[{AxCode}_{Edicion}]`**: mismo contrato de lectura que la tabla que creaba `generarTabla`. Mantiene 15 columnas fijas en el orden legacy y una columna `type_{typekey} nchar(10)` por cada typekey completado, en orden de solicitud. No tiene PK ni índices.
2. **`dbo.nomCamposTabla`**: una fila por typekey con `brand`, `Model`, `NomTable`, `nomCampo`, `Orden`, `estado`, `visible` y `nomCampoVisible`. La otra aplicación descubre aquí la tabla y sus columnas. `brand` se toma de `ReportMetadata.brand` (default `manufacturer`); `Model` se toma de `ReportMetadata.model` (default `series` normalizada, eliminando apóstrofes). `estado` y `visible` se escriben explícitamente como `'1'`, coherente con los defaults del DDL confirmado.

El DDL de `nomCamposTabla` confirmado para el entorno es:

```sql
brand nchar(10) NULL,
Model nchar(10) NOT NULL,
NomTable nchar(12) NULL,
nomCampo nchar(10) NULL,
Orden numeric(18,0) NULL,
estado char(1) DEFAULT '1' NULL,
visible char(1) DEFAULT '1' NULL,
nomCampoVisible nchar(10) NULL
```

La base usa `Latin1_General_CI_AS`. La tabla de pivote hereda ese collation y conserva las columnas de texto `nvarchar` del `CREATE TABLE` legacy. Las filas de semilla cuyo número es `'0'`, los NULLs y los valores `type_` se insertan tal como los produce el pivote.

### Reemplazo y seguridad

- Se construye `__bmw_tmp_<uuid>` en `dbo`, se carga con bulk insert y se verifica el recuento antes de tocar la tabla pública.
- Dentro de una transacción `SERIALIZABLE`, `sp_getapplock` serializa reemplazos de la misma edición. Si la tabla ya existe, se reemplazan sus filas y columnas dinámicas `type_`; se preserva el objeto SQL (y sus permisos asociados). Para una tabla nueva, la tabla temporal toma el nombre final dentro de la transacción. Las filas de `nomCamposTabla` se reemplazan en la misma transacción. Un error revierte tabla y metadatos juntos.
- El reemplazo mantiene el esquema y los valores legacy; sí mejora la idempotencia: repetir la misma edición reemplaza, en lugar de fallar en `CREATE TABLE` y dejar duplicados de `nomCamposTabla`.
- Los identificadores SQL se validan y se citan; todos los valores van parametrizados/bulk. Credenciales solo desde `SQL_*`, nunca se registran. La conexión usa SQL Authentication con `mssql`/`tedious`.
- `SQL_ENABLED` está habilitada por defecto y puede ponerse a `false` para generar solo el reporte local. En producción, configura `SQL_SERVER`, `SQL_DATABASE=BMW_Labour`, `SQL_USER`, `SQL_PASSWORD` y los ajustes TLS mediante secretos del despliegue. Si conectas por IP con cifrado, `SQL_TLS_SERVER_NAME` permite fijar el nombre DNS del certificado. El usuario necesita permisos de creación/reemplazo en `dbo` y lectura/escritura acotada de `nomCamposTabla`. `tedious` está fijado a 19.2.2 para mantener compatibilidad con Bun 1.3 en la imagen Docker.

### Etapas y fallos

El job muestra `persisting` entre `pivoting` y `parsing-dda`. Con SQL habilitado, un fallo de persistencia falla el reporte: no debe aparecer como completado si la aplicación consumidora no tiene la tabla. La escritura por tabla es atómica; los artefactos del informe S3 pueden estar incompletos si falla después de otras etapas.

No se escriben las tablas staging `typekeyCatalog`/`typekeyIdEntriesId`, `LoRaro` ni `RegistrosQ`, ni la tabla `BMW_DDA`; esta última se gestiona por separado. `pivot.json` se mantiene como diagnóstico. El Visor Excel alternativo `BMW_Visor.frm:aExcel_Click` queda fuera.

### Validación de SQL

- Unit tests de DDL, quoting, mapeo de filas, seeds, NULLs y metadatos: `bun test`.
- Integración de reemplazo/repetición/rollback contra un SQL Server 2022 desechable: `bun run test:sql` (Docker; la contraseña `sa` se genera aleatoriamente durante la ejecución y no se escribe en archivos).
- No usar credenciales productivas para pruebas. La comparación con el CSV legacy sigue disponible con `BMW_LEGACY_PIVOT_CSV` y requiere acceso a S3 para reconstruir el pivote.
