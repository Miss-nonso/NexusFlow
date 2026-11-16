import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
let sdk: NodeSDK | undefined;
export function startTelemetry() {
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT && !sdk) {
    sdk = new NodeSDK({
      serviceName: `nexusflow-${process.env.SERVICE_ROLE || "web"}`,
      traceExporter: new OTLPTraceExporter(),
    });
    sdk.start();
  }
}
export async function stopTelemetry() {
  await sdk?.shutdown();
}
