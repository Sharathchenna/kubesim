import posthog from "posthog-js";

type EventProperties = Record<string, boolean | number | string>;

function isConfigured() {
  return process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN && process.env.NEXT_PUBLIC_POSTHOG_HOST;
}

export function capture(event: string, properties?: EventProperties) {
  if (!isConfigured()) return;

  posthog.capture(event, properties);
}

export function captureException(error: Error) {
  if (!isConfigured()) return;

  posthog.captureException(error);
}
