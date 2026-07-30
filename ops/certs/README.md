# TLS trust material

The release runner connects with `sslmode=verify-full` against an **explicit,
checksum-pinned** Supabase CA certificate (canonical memory v11 §3.2/§3.3).

## Files

| file | committed | purpose |
|---|---|---|
| `supabase-prod-ca.crt` | **no** | the CA certificate, supplied per machine |
| `supabase-prod-ca.crt.sha256` | **yes** | the pinned digest the runner enforces |

## One-time setup

1. Supabase dashboard → **Project Settings → Database → SSL Configuration** →
   download the certificate.
2. Save it as `ops/certs/supabase-prod-ca.crt`.
3. Run once:

   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File ops\pin-supabase-ca.ps1
   ```

That records the SHA-256 into the pin file. Commit **only** the pin file.

## Why pin at all

The certificate is public, not a secret. Pinning is not about confidentiality —
it fixes *which* trust root is acceptable. Without a pin, "a file exists at this
path" proves nothing: a substituted or truncated file would still be loaded and
`verify-full` would validate against the wrong root. With a pin, any change fails
closed, before the password prompt.

## Why not `sslrootcert=system`

It was the previous approach and is **not** used. It delegates trust to whatever
the OS store happens to contain, which varies per machine and is not verifiable
from inside the runner. v11 permits it only after an automated test on the target
Windows machine proves the OS store actually validates this host under
`verify-full` for **both** `psql` and `pg_dump`. Until that test exists and
passes, an unproven trust root is worse than a missing one — it fails silently
open rather than closed.

`sslmode=require` and weaker are never acceptable: they encrypt without
authenticating the server, so they do not protect against interception.
