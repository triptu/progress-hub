// The central hub's Worker as Cloudflare runs it. Everything it does is in ../src/central/, which the tests run as it is.
import { DurableObject } from "cloudflare:workers";
import { CentralHub, handle, type Env, type HubContext } from "../src/central/worker.ts";

export class Hub extends DurableObject<Env> {
  private readonly hub = new CentralHub(this.ctx as unknown as HubContext, this.env.FILES);

  override fetch(request: Request): Promise<Response> {
    return this.hub.fetch(request);
  }

  override alarm(): void {
    this.hub.alarm();
  }

  override webSocketClose(socket: WebSocket): void {
    socket.close();
  }
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
};
