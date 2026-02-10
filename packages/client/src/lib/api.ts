import type { Api } from "@repo/cdn";
import { hc } from "hono/client";

const CDN_URL = import.meta.env.VITE_CDN_URL || "http://localhost:8787";

export const apiClient = hc<Api>(CDN_URL);
