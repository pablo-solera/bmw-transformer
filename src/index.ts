import { app } from "./app.js";
import { config } from "./config.js";
import { ensureBucket } from "./storage.js";

await ensureBucket();
app.listen(config.port, config.HOST, () => console.log(`bmw-transformer listening on http://${config.HOST}:${config.port}`));
