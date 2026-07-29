/// <reference types="vite/client" />

import type { KachinaApi, KachinaWindowApi } from "../shared/types";

declare global {
  interface Window {
    kachinaApi?: KachinaApi;
    kachinaWindowApi?: KachinaWindowApi;
  }
}

export {};
