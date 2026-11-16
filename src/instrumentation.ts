export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateSecrets } = await import("./backend/config");
    validateSecrets();
    const { startTelemetry } = await import("./backend/otel");
    startTelemetry();
  }
}
