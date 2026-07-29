const rawPort = process.env.KACHINA_WEB_PORT?.trim();
const port = rawPort ? Number(rawPort) : 47831;
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new Error("KACHINA_WEB_PORT must be an integer between 1024 and 65535.");
}

const origin = `http://127.0.0.1:${port}`;
const response = await fetch(`${origin}/api/shutdown`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Origin: origin
  },
  body: "{}",
  signal: AbortSignal.timeout(5_000)
});

if (!response.ok) {
  throw new Error(`Kachina shutdown request failed with status ${response.status}.`);
}

console.log("Kachina shutdown requested.");
