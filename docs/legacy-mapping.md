# Mapeo de Acciona BMW VB6 a bmw-transformer

## Pipeline portado

| Acciona VB6 | Port TypeScript | Comportamiento relevante |
|---|---|---|
| `BMW_API2.frm:1296-1309` `iniciarCargaAutomatica` | `pipeline/run-report.ts` | Solo se importan typekeys COMPLETED; se ejecuta el flujo en memoria |
| `BMW_API2.frm:2325-2352` `cargaCompleta` | `pipeline/import-data.ts` | Elige marcador completado más reciente por typekey |
| `BMW_API2.frm:1074-1106` `typekeysRead` | `pipeline/import-data.ts` | Catálogo `{baseType}/{baseType}_catalog.json`; al leer CRLF, `aa` duplica la primera línea y omite la última |
| `BMW_API2.frm:1108-1139` `typekeyCatalogRead` | `pipeline/import-data.ts` | HG busca `{typekey}/{hg}/{typekey}_{hg}.json`; usa última línea VB6 para CRLF |
| `API_BMW.bas:260-295` `readComponentCatalogBMW` | `pipeline/import-data.ts` | Una fila por entry; acceso de `entries` obligatorio |
| `API_BMW.bas:296-349` `readComponentFlatrateGroupsMW` | `pipeline/import-data.ts` | Un rate por fila; `catalogPaths` se queda con la última ruta; `displayType` por typo queda vacío |
| `API_BMW.bas:369-378` `BorradoDatos` | Pipeline en memoria | No se conservan staging rows entre ejecuciones; no afecta al Excel |
| `BMW_API2.frm:1349-1401` `generarTabla` | `pipeline/pivot.ts` | Nombre `<AxCode>_<Edicion>`, typekeys y columnas de pivote |
| `BMW_API2.frm:1403-1558` `compararModelo` | `pipeline/pivot.ts` | `LIKE '%suffix%'`, fila semilla, estado anterior y errores `Resume Next` contabilizados |
| `BMW_API2.frm:1324-1347` `codigoEstrujen` | `pipeline/pivot.ts` | Extracción SA con `Mid(InStr + 19, 4)` literal |
| `BMW_API2.frm:2163-2259` `comparativaBMW_DDA` | `pipeline/pivot.ts`, `report/workbook.ts` | Operación única, búsqueda normalizada, red cells y ExcelJS |
| `LstVerbundListingParser.cs` (rama dotnet) | `dda/parse-lst.ts` | Offsets Q exactos del código que llena `RegistrosQ` |

## Semántica del parser LST (rama dotnet)

El parser usa Encoding.Latin1, busca `ID = Q` que contenga `P A R T`, corta en el próximo `ID = <algo>`, y omite líneas en blanco, banners, cliente y cabeceras `VB S A`, `CO I C`, `P A R T`. Normaliza cadena vacía a null. Campos: WU/tiempo offset 10 length 5, Operacion offset 16 length 10, KL 29/1, texto 31/41, y demás offsets según `LstVerbundListingParser.cs`.

En la referencia `WTCO015-LISTE.LST` se extraen 2051 filas Q; 509 filas cumplen `Operacion <> KN` y `COUNT(Operacion)=1`, coincidiendo exactamente con operación y tiempo de las filas 4..512 de `1IX_04.xlsx`.

## Reglas y bugs preservados

- `vbTrim` solo elimina espacio ASCII; `vbMid` usa índices VB de base 1; `InStr` devuelve base 1 y 0 cuando no encuentra.
- `vbLineInputLines` reconoce CR y CRLF; LF queda dentro de la línea. Así, el JSON pretty serializado con LF por el fetcher se lee como una sola línea larga; con CRLF, `typekeysRead` duplica primera línea/omite última y `typekeyCatalogRead` pasa solo `Linea` (última línea).
- Campo JSON no presente asignado a String -> `""`; null asignado a String -> runtime error 94. Número JSON pasa por `CDec` dependiente de es-ES. Boolean a texto produce True/False.
- `typekeyCatalog` usa PK `(typekey, entriesId)` y tamaños nchar: typekey 10, id 35, number 10, text 70, entriesId 35, entriesNumber 10. `entriesText` es nvarchar(MAX). Duplicate PK y truncados son fatales en import.
- `typekeyIdEntriesId` es nvarchar(MAX) sin PK; permite duplicados. Las comillas no escapadas en su INSERT producen error fatal.
- Los ids de catálogo se insertan bajo baseType; los flatrates guardan el typekey leído por `typekeyCatalogRead` en `typekeyIdEntriesId`.
- `catalogPaths` se reemplaza durante el loop, por lo tanto queda la última; array vacío reutiliza valor de una fila anterior. `displayType` no se asigna a la variable declarada y se persiste vacío.
- `compararModelo` agrega seed `flatrates_number='0'` por entrada; `nuevaLine` compara solo rubrikText, text, awSheetOID, number y flatrates_text y no se reinicia entre entradas de catálogo.
- La relación de catálogo es `catalogPaths LIKE '%'+Mid(entriesId, InStr('_'))+'%'`. `_`, `%`, corchetes T-SQL y collation CI_AS alteran la coincidencia. Sin `_`, Mid falla y conserva el suffix anterior, inicialmente vacío.
- Errores dentro de `compararModelo` se omiten (equivalente a `On Error Resume Next`); el informe incluye `ignoredSqlErrors`.
- DDA descarta `KN`, nulos y toda operación cuya frecuencia no sea exactamente uno. Busca el primer flatrate con número normalizado (quita espacio, `)` y `ZAX`). ZAX prevalece sobre `)`.
- En Excel la cabecera usa `nomCampo` y no `nomCampoVisible`; Excel puede coercionar cadenas numéricas. Fuente de cabecera tamaño 12, dos filas vacías y título en fila 3.
- DDL confirma `Latin1_General_CI_AS`; la comparación es case-insensitive y accent-sensitive. La aproximación JS usa `Intl.Collator`, no el motor SQL Server. `comparativaBMW_DDA` pide `DISTINCT nomCampo` sin `ORDER BY`; el port conserva orden de inserción de los typekeys suministrados, ya que la salida SQL no define un orden garantizado.
- El Excel real demuestra que valores vacíos BMW quedan como celdas vacías y los valores AW numéricos como enteros. Las celdas DDA/BMW se colorean según las reglas VB6; no se colorean cabeceras ni columna vacía C.

## Fuera de alcance sin efecto material en el Excel

No se escriben tablas SQL ni se recrea persistencia/PK `LoRaro`; no se modifica `RegistrosQ`; no se guarda el pivote en una tabla SQL. Se conserva `pivot.json` como diagnóstico del resultado calculado en memoria. El Visor Excel alternativo `BMW_Visor.frm:aExcel_Click` queda fuera (es una exportación distinta y referencia `cells(4,0)`).
