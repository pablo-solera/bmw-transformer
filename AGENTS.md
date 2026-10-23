# BMW Transformer engineering notes

- Bun, TypeScript strict, ESM NodeNext; relative imports llevan sufijo `.js`.
- Mantener separadas las reglas legacy de infraestructura (S3/Redis/Excel) y probar transformaciones con fixtures deterministas.
- La única escritura permitida en BMW_Labour es el pivote final `[AxCode]_[Edicion]` y sus filas en `nomCamposTabla`, desde `src/sql/` tras construir el pivote. No escribir staging (`typekeyCatalog`, `typekeyIdEntriesId`), `LoRaro` ni `RegistrosQ`.
- La persistencia SQL reemplaza atómicamente tabla y metadata; no añadir DDL ad hoc, SQL por concatenación de valores, ni credenciales en código. Mantener SQL_USER/SQL_PASSWORD fuera del repo y no loguear configuración ni secretos.
- No normalizar bugs legacy sin instrucción explícita. Cada diferencia o aproximación se documenta en `docs/legacy-mapping.md`.
- No registrar ficheros LST, payloads BMW, credenciales ni valores DDA en logs.
