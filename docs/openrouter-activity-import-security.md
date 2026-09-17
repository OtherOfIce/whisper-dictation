# OpenRouter activity import security

## Recommendation

Use a temporary management key for a one-off import, then remove it from OpenRouter. Do not add a persistent management-key setting to Local Whisper.

OpenRouter does not document read-only or activity-only scopes for management keys. Its management-key route list includes analytics, but the same credential can also create, update, and delete inference keys, BYOK credentials, guardrails, observability destinations, workspaces, and budgets. Management keys cannot call model completion endpoints, which limits one kind of misuse, but they remain broad account-level administrative secrets. [OpenRouter management API keys](https://openrouter.ai/docs/guides/overview/auth/management-api-keys) [OpenRouter workspaces](https://openrouter.ai/docs/guides/features/workspaces/overview)

## What can be imported

`GET /api/v1/activity` accepts an `api_key_hash` filter and returns activity for the last 30 completed UTC days. Rows are grouped by date, model, and provider endpoint and include request count and usage cost. This is enough to backfill a local aggregate cost ledger for the dictation key. It is not enough to assign exact historical costs to individual transcript records because the endpoint does not enumerate requests or generation IDs. [OpenRouter activity API](https://openrouter.ai/docs/api/api-reference/analytics/get-user-activity)

The current UTC day is absent by design. Keep any per-response costs already recorded locally for today, or repeat the import after the day closes. An importer should upsert rows by source, key hash, date, model, and endpoint so rerunning it cannot double-count spend.

## Safest one-off flow

1. Open OpenRouter's [Management API Keys page](https://openrouter.ai/settings/management-keys) and confirm that the UI offers a way to remove the key before creating it. OpenRouter's public API docs do not document a programmatic endpoint for deleting management keys themselves.
2. Create a new key named for the import, for example `Local Whisper one-time activity import`.
3. Pass it to a dedicated import action through a masked field or standard input. Do not put it in chat, command-line arguments, environment files, application settings, crash reports, or logs.
4. Keep the plaintext only in process memory. Never include the authorization header or response request object in diagnostic output.
5. Use `GET /api/v1/keys` only if the importer still needs to resolve the dictation inference key's hash. Then request `/api/v1/activity?api_key_hash=...` and persist only the returned accounting fields.
6. Validate the imported row count, date range, and summed cost before committing the transaction. The total covers completed UTC days only.
7. Clear the secret from memory as far as the runtime permits, close the import screen, and remove the temporary management key from the OpenRouter dashboard immediately.

The documented `DELETE /api/v1/keys/{hash}` route deletes ordinary inference keys. It should not be treated as a way to revoke a management key. [Delete an API key](https://openrouter.ai/docs/api/api-reference/api-keys/delete-keys)

## Revocation finding

OpenRouter's public documentation directs users to the Management API Keys dashboard to create and manage these credentials, but it does not explicitly document management-key deletion or revocation. Dashboard removal is therefore part of the recommended procedure, subject to confirming that control in the signed-in UI. We should not claim programmatic revocation support without further first-party confirmation.
