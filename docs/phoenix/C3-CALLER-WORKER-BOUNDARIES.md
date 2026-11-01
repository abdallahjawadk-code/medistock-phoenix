# C3 private caller and worker boundaries

This foundation reuses the caller-scoped original reader and worker transport from #266, retaining their source history. It has no route, worker parser entrypoint, UI activation or SQL. The source reader requires the server-authenticated caller, current annual authority, the exact C2 capability, returned owner/year/original identity, canonical base64 and independently checked size/SHA-256. It constructs no service client.

The worker transport accepts a server-owned file entry and a pinned reviewed manifest. It copies source bytes, passes no environment credentials, restricts V8 heap/stack, enforces a ten-second deadline, validates bounded pages and waits for actual termination before completing. Unit fault-injection tests cover this boundary; compiling and running the real parser entrypoint is the separate #278 integration gate. This foundation alone is not hosted Worker or Auth acceptance.

The source files match the boundaries independently reviewed in #278 source `979cbf23`. Fourteen focused unit cases, focused types and lint are local prerequisites; current-source full CI and authenticated preservation acceptance remain mandatory. Hosted original-read activation inherits the documented platform-read compatibility HOLD. No hosted role or database change is included.
