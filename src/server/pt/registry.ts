import type { PtAdapter } from "./types";
import { MTeamAdapter } from "./mteam";
import { getSettings } from "../config";

let adapters: PtAdapter[] | null = null;

export function getAdapters(): PtAdapter[] {
  if (adapters) return adapters;
  adapters = [];
  const s = getSettings();
  if (s.mtApiKey) {
    adapters.push(
      new MTeamAdapter({
        apiKey: s.mtApiKey,
        baseUrl: s.mtBaseUrl,
        modes: s.searchModes,
        categories: s.searchCategories,
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
