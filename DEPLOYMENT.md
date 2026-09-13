# Hosted Deployment

These steps are provider-neutral. The hosting platform must support an OCI container, runtime secrets, HTTPS termination, and an inbound health check.

## 1. Prepare and build

Run the offline gates before producing an image:

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
pnpm scan:secrets
docker build -t aroflo-connector:0.1.0 .
```

Do not bake an environment file or secret into the image. The image runs as a non-root user.

## 2. Create runtime secrets

Create these five independent secrets in the provider's secret store:

- `AROFLO_UENCODED`
- `AROFLO_PENCODED`
- `AROFLO_ORG_ENCODED`
- `AROFLO_SECRET_KEY`
- `MCP_ACCESS_TOKEN` using a new, high-entropy value

Mount or inject them only at runtime. Rotate the AroFlo credentials that were shared in chat before exposing a public endpoint. Leave `AROFLO_HOST_IP` unset unless AroFlo requires and has approved the deployment's fixed egress IP.

## 3. Configure the service

- Select HTTP transport.
- Keep `AROFLO_WRITE_ENABLED` and `AROFLO_FINANCIAL_WRITES_ENABLED` exactly `false`.
- Keep the writable-area allowlist empty.
- Set `PORT` to the platform's assigned internal port, normally `3000`.
- Bind to the address required by the platform.
- Set `MCP_ALLOWED_HOSTS` to the exact public hostname or hostnames when binding outside loopback.
- Terminate HTTPS at the platform or trusted reverse proxy; do not expose plain HTTP publicly.
- Route the protected MCP endpoint at `/mcp` and pass its bearer token from the client.
- Route `/healthz` for a non-sensitive health check. It does not require the MCP token.

Permit inbound traffic only through the HTTPS edge. Restrict secret access and deployment changes to authorized operators.

## 4. Validate read-only operation

1. Start the container and confirm `/healthz` returns a successful non-sensitive status over HTTPS.
2. Confirm MCP discovery shows the six read/preview tools and no create/update tools.
3. From a secure environment with the same runtime secrets and both write flags false, run `pnpm smoke:read-only`.
4. Confirm it reports only connection state and task/client counts.
5. Run `pnpm scan:secrets` against the source, built output, documentation, manifest, MCP configuration, and an extracted copy of the delivery archive.

Do not perform a live POST, create, update, delete, or archive during acceptance.

## 5. Connect ChatGPT

Configure the compatible ChatGPT MCP client with the public HTTPS `/mcp` URL and the MCP access token. Local stdio cannot serve other devices.

## 6. Enable writes only after approval

Make ordinary writes a separate reviewed deployment change after the user accepts read-only results:

1. Approve the exact non-financial areas.
2. Enable the ordinary write flag and set only those areas in the allowlist.
3. Restart and verify discovery plus preview/confirmation behavior.

Make invoice writes a second separate reviewed change:

1. Confirm AroFlo invoice permission and obtain separate user approval.
2. Enable the financial write flag and include `invoices` in the allowlist while the ordinary flag remains enabled.
3. Restart and verify only the intended tools and areas are exposed.

Writes remain create/update only. There is no delete or archive route, and POST requests are never automatically retried.

## Rollback and rotation

Reset both write flags to `false`, empty the writable-area allowlist, and restart the service. Confirm create/update tools disappear from discovery. If any secret may have been exposed, revoke it, create a replacement in the secret store, restart, and rerun read-only validation and secret scanning.
