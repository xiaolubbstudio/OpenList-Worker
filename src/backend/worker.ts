import app from "./index"
import { OpenListDB } from "./durable-objects/OpenListDB"

// Durable Object 类（DB_DRIVER=do 时使用），需在 wrangler.toml 声明
// new_sqlite_classes = ["OpenListDB"] 与对应的 binding。
export { OpenListDB }

export default {
  fetch(request: Request, env: any, ctx: any) {
    // Do not expose first-owner setup before deployment secrets are installed.
    if (!env.JWT_SECRET) return new Response("Backend initialization in progress", { status: 503 });
    if (new URL(request.url).pathname === "/api/public/init/setup") return Response.json({code:403,message:"Administrator setup is managed by deployment",data:null},{status:403});
    return app.fetch(request, env, ctx);
  },
}
