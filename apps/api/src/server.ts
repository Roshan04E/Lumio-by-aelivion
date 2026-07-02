import { env } from "./config/env";
import { createApp } from "./app";
import { ensureStorage } from "./services/storage.service";

await ensureStorage();

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`Lumio API listening on http://localhost:${env.PORT}`);
});
