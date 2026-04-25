import type {
  ConsentEvent,
  DatasourcesStartConsentRequest,
  DatasourcesStartConsentResponse,
} from "@ft5/ipc-contracts";

import type { OAuthConsentBroker } from "../../oauth/consent-broker.js";

export interface StartConsentDeps {
  broker: OAuthConsentBroker;
  sendToWindows: (event: ConsentEvent) => void;
}

export async function handleDatasourcesStartConsent(
  req: DatasourcesStartConsentRequest,
  deps: StartConsentDeps,
): Promise<DatasourcesStartConsentResponse> {
  const startOpts = req.datasourceId !== undefined
    ? { providerId: req.providerId, datasourceId: req.datasourceId }
    : { providerId: req.providerId };

  const { sessionId } = await deps.broker.start(startOpts);

  const unsubscribe = deps.broker.subscribe((event) => {
    if (event.sessionId !== sessionId) return;
    deps.sendToWindows(event);
    const terminal =
      event.event === "consent-completed" ||
      event.event === "consent-cancelled" ||
      event.event === "consent-failed" ||
      event.event === "consent-timeout";
    if (terminal) unsubscribe();
  });

  return { sessionId };
}
