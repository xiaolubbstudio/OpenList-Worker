import app from "./index"
import { OpenListDB } from "./durable-objects/OpenListDB"
import { StudioPresence } from "./durable-objects/StudioPresence"
import { PRESENCE_PATH, handleStudioPresence } from "./server/studio-presence"

// Durable Object 类（DB_DRIVER=do 时使用），需在 wrangler.toml 声明
// new_sqlite_classes = ["OpenListDB"] 与对应的 binding。
export { OpenListDB }
// 素材库成员在线：wrangler.jsonc 里唯一允许的 Durable Object（见 scripts/studio-check-isolation.mjs）。
export { StudioPresence }

export default {
  fetch(request: Request, env: any, ctx: any) {
    // Do not expose first-owner setup before deployment secrets are installed.
    if (!env.JWT_SECRET) return new Response("Backend initialization in progress", { status: 503 });
    if (new URL(request.url).pathname === PRESENCE_PATH) return handleStudioPresence(request, env);
    if (new URL(request.url).pathname === "/api/public/init/setup") return Response.json({code:403,message:"Administrator setup is managed by deployment",data:null},{status:403});
    return app.fetch(request, env, ctx);
  },
}
