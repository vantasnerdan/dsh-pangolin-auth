# dsh-pangolin-auth

A proper Cordis replacement for the DSH Web connection plugin that trusts
Pangolin's authenticated identity header instead of DSH launch tokens and
browser cookies.

This release targets **DeepSeek Harness 0.1.5-rc.2 exactly**. The setup CLI
refuses other DSH versions.

## Architecture

The package owns a complete `connection` service implementation derived from
`@deepseek-ai/dsh-client-connection@0.1.5-rc.2`. Its bundle patch disables the
shipped `connection` row and inserts `pangolin-connection`, including a
compatible browser `./client` entry. It does not assign to another service,
wrap methods, mutate prototypes, or modify the installed DSH package.

The replacement preserves DSH's Host/Origin trust fence, RPC and exact Fetch
registries, HTTP bridge, request limits, recovery behavior, and browser client.
Authentication changes are limited to these owned behaviors:

- `Remote-User` is required by default for the index, HTTP API, and WebSocket
  handshake. The header name is configurable.
- DSH does not mint a launch token, accept a query token, or issue an auth
  cookie.
- The URL announced by `dsh web` is the configured external HTTPS origin.
- The DSH Web server must bind to `127.0.0.1`; startup fails otherwise.

## Security requirements

This plugin is safe only when all of the following are true:

1. Pangolin is the only network path to the loopback DSH listener.
2. Pangolin removes any client-supplied value for the configured identity
   header and writes its own value only after successful SSO.
3. Pangolin forwards the identity header on ordinary HTTP requests and
   WebSocket upgrade requests.
4. Pangolin preserves the external `Host` authority. Browser `Origin` must
   match that authority; a rewritten Host with a forwarded external Origin is
   rejected.
5. The configured public domain routes to `http://127.0.0.1:<dsh-port>` on the
   agent VM; the DSH port is not exposed to the LAN or Internet.
6. The VM and DSH process are operated as one trusted user. DSH remains a
   single-owner application, not a multi-tenant authorization system.

The default identity header is Pangolin's `Remote-User`. The CLI accepts only
Pangolin's `Remote-User`, `Remote-Email`, `Remote-Name`, and `Remote-Role`
headers; routing or browser-controlled headers are rejected. A nonempty value
proves only that the trusted proxy authenticated a user; this plugin
intentionally does not create per-user DSH permissions.

## Build a tarball

Requires Node.js 22.19 or newer.

```sh
npm ci --legacy-peer-deps
npm test
npm run build
npm pack
```

The tarball contains the Host plugin, browser plugin, setup CLI, bundle patch,
license, and notice.

## Install on an agent VM

Stop the DSH Web process first. The Web profile supports live patch reload, but
bundle selection is startup-owned; installing into a running process can
otherwise expose a transient failed composition.

```sh
dsh --version
# Must print: 0.1.5-rc.2

dsh plugin --profile web add /path/to/dsh-pangolin-auth-0.1.0.tgz
dsh plugin --profile web exec dsh-pangolin-auth -- setup \
  --profile web \
  --domain agent-name.example.com

dsh web --no-open
```

`--domain` is a bare `host` or `host:port`, never a URL. Setup writes
`https://<domain>` as the public origin. Each VM can run the same tarball with a
different domain.

To use another Pangolin identity header:

```sh
dsh plugin --profile web exec dsh-pangolin-auth -- setup \
  --profile web \
  --domain agent-name.example.com \
  --identity-header remote-email
```

Setup is idempotent. Running it again updates the one managed profile section
and moves the bundle to the end of the profile bundle list without duplicating
it. It preserves unrelated profile patch rows and manifest fields. Every
change creates a profile-content backup under:

```text
$DSH_HOME/profiles/web/.dsh-pangolin-auth/backups/
```

The CLI prints the precise backup directory after a change.

## Verify after restart

Open the Pangolin HTTPS URL in a browser that has completed Pangolin SSO. There
should be no DSH token-enrollment page and no DSH browser-auth cookie.

Expected negative checks from the VM are:

```sh
# Missing Pangolin identity: 401
curl -i -H 'Host: agent-name.example.com' http://127.0.0.1:3080/

# Untrusted Host even with a forged identity: 403
curl -i \
  -H 'Host: attacker.example.com' \
  -H 'Remote-User: forged' \
  http://127.0.0.1:3080/api/unknown
```

A request sent directly from the VM with the correct Host and a forged identity
will be accepted because it originates inside the trusted loopback boundary.
That is why the DSH listener must remain inaccessible to untrusted local users
and processes.

## Change the domain

Stop DSH Web, rerun setup with the new domain, then restart:

```sh
dsh plugin --profile web exec dsh-pangolin-auth -- setup \
  --profile web \
  --domain new-agent-name.example.com
```

No source or package file contains a deployment domain.

## Uninstall

Stop DSH Web, remove the managed configuration, then remove the package:

```sh
dsh plugin --profile web exec dsh-pangolin-auth -- uninstall --profile web
dsh plugin --profile web remove dsh-pangolin-auth
```

The first command removes only this package's marked patch section and bundle
selection. The second removes the npm dependency. Restarting then restores the
shipped DSH connection provider.

To restore a saved profile-content backup explicitly:

```sh
dsh plugin --profile web exec dsh-pangolin-auth -- restore \
  --profile web \
  --backup /absolute/path/printed/by/setup
```

Restore is restricted to backup directories owned by the selected profile.

## Compatibility and maintenance

The Host and Client transport sources are pinned to DSH tag
`dsh-v0.1.5-rc.2` (`fb2c4b9e69`). A new DSH release may change the connection
service, browser module protocol, or composition row. Publish a separately
tested plugin version for that DSH release instead of bypassing the version
check.

The package does not activate itself, open a port, edit shipped presets, or
modify a live DSH process. Only its setup CLI edits the selected user profile.
