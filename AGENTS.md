# BMW Transformer engineering notes

- Bun, TypeScript strict, ESM NodeNext; relative imports llevan sufijo `.js`.
- Mantener separadas las reglas legacy de infraestructura (S3/Redis/Excel) y probar transformaciones con fixtures deterministas.
- No añadir escrituras a BMW_Labour: este servicio solo carga datos a memoria y sube reportes a S3.
- No normalizar bugs legacy sin instrucción explícita. Cada diferencia o aproximación se documenta en `docs/legacy-mapping.md`.
- No registrar ficheros LST, payloads BMW, credenciales ni valores DDA en logs.
