/// <reference types="vite/client" />

import type { KachinaApi } from "../shared/types";

declare global {
  interface Window {
    kachinaApi: KachinaApi;
  }
}

export {};
