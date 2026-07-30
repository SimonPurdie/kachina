import type { KachinaWindowApi } from "../shared/types";

interface ApiErrorResponse {
  error?: string;
}

export interface ElectronRendererHost {
  kind: "electron";
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<boolean>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onWindowStateChanged: KachinaWindowApi["onWindowStateChanged"];
}

export interface WebRendererHost {
  kind: "web";
  close: () => Promise<void>;
  onShutdown: (listener: () => void) => () => void;
}

export type RendererHost = ElectronRendererHost | WebRendererHost;

interface ShutdownEventSource {
  addEventListener: (type: "shutdown", listener: () => void) => void;
  close: () => void;
}

type ShutdownEventSourceFactory = (url: string) => ShutdownEventSource;

export async function closeWebHost(
  host: WebRendererHost,
  closeWindow: () => void,
  showFallback: () => void
): Promise<void> {
  await host.close();
  closeWindow();
  showFallback();
}

export async function requestWebShutdown(
  fetchImplementation: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImplementation("/api/shutdown", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: "{}"
  });

  if (response.ok) {
    return;
  }

  let message = `Kachina shutdown failed with status ${response.status}.`;
  try {
    const body = (await response.json()) as ApiErrorResponse;
    if (body.error) {
      message = body.error;
    }
  } catch {
    // Preserve the status-based message when the response is not JSON.
  }
  throw new Error(message);
}

export function subscribeToWebShutdown(
  listener: () => void,
  createEventSource: ShutdownEventSourceFactory = (url) => new EventSource(url)
): () => void {
  const eventSource = createEventSource("/api/events");
  eventSource.addEventListener("shutdown", () => {
    eventSource.close();
    listener();
  });
  return () => {
    eventSource.close();
  };
}

export function getRendererHost(): RendererHost {
  const windowApi = window.kachinaWindowApi;
  if (!windowApi) {
    return {
      kind: "web",
      close: () => requestWebShutdown(),
      onShutdown: (listener) => subscribeToWebShutdown(listener)
    };
  }

  return {
    kind: "electron",
    minimize: () => windowApi.windowMinimize(),
    toggleMaximize: () => windowApi.windowToggleMaximize(),
    close: () => windowApi.windowClose(),
    isMaximized: () => windowApi.isWindowMaximized(),
    onWindowStateChanged: (listener) => windowApi.onWindowStateChanged(listener)
  };
}
