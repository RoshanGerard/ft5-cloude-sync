## ADDED Requirements

### Requirement: Credential forms reconnect an existing datasource via `datasourceId`

The `AwsAccessKeyForm` and `CustomForm` credential-form components SHALL accept an optional `datasourceId` prop and, when it is present, include it in the call `window.api.sync.authenticateStart({ providerId, datasourceId })` so the resulting credential write targets the EXISTING datasource (re-authentication) rather than minting a new one. This mirrors `OAuthForm`, which already accepts and threads `datasourceId` on the reconnect path. When `datasourceId` is omitted (the add-datasource path), the call SHALL NOT include the field, preserving the new-datasource behaviour.

This makes the credential-form reconnect path — previously implied by the `{ providerId, datasourceId? }` call contract but never exercised by any caller — explicit and testable, so non-OAuth datasources (e.g. Amazon S3) can reconnect from the file explorer's shared reconnect view.

#### Scenario: Access-key form threads datasourceId on the reconnect path

- **WHEN** `AwsAccessKeyForm` is rendered with `datasourceId="ds-9"` and submitted with valid credentials
- **THEN** `window.api.sync.authenticateStart` is called exactly once with `{ providerId: "amazon-s3", datasourceId: "ds-9" }`, then `window.api.sync.authenticateComplete({ correlationId, completion: { kind: "credentials-form", values } })` is called exactly once with the returned `correlationId`; the response's `datasourceId` is `"ds-9"` (the existing datasource is re-authed, not replaced by a new id)

#### Scenario: Access-key form omits datasourceId on the add path

- **WHEN** `AwsAccessKeyForm` is rendered WITHOUT a `datasourceId` prop (the add-datasource dialog flow) and submitted with valid credentials
- **THEN** `window.api.sync.authenticateStart` is called with `{ providerId: "amazon-s3" }` and the request object does NOT carry a `datasourceId` field, preserving the new-datasource creation behaviour
