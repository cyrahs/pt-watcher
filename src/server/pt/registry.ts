import type { PtAdapter } from "./types";
import { MTeamAdapter } from "./mteam";
import { env, getSettings } from "../config";

let adapters: PtAdapter[] | null = null;

export function getAdapters(): PtAdapter[] {
  if (adapters) return adapters;
  adapters = [];
  if (env.mtApiKey) {
    adapters.push(
      new MTeamAdapter({
        apiKey: env.mtApiKey,
        baseUrl: env.mtBaseUrl,
        modes: getSettings().searchModes,
      }),
    );
  }
  return adapters;
}

export function getAdapter(siteId: string): PtAdapter | undefined {
  return getAdapters().find((a) => a.siteId === siteId);
}

/** settings 变更后重建 adapter（modes 等参数可能变化） */
export function resetAdapters() {
  adapters = null;
}
