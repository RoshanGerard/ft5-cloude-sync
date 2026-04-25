import type {
  DatasourcesCancelConsentRequest,
  DatasourcesCancelConsentResponse,
} from "@ft5/ipc-contracts";

import type { OAuthConsentBroker } from "../../oauth/consent-broker.js";

export interface CancelConsentDeps {
  broker: OAuthConsentBroker;
}

export async function handleDatasourcesCancelConsent(
  req: DatasourcesCancelConsentRequest,
  deps: CancelConsentDeps,
): Promise<DatasourcesCancelConsentResponse> {
  await deps.broker.cancel({ sessionId: req.sessionId });
}
