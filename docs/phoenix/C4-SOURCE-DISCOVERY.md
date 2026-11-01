# Scoped reviewed-profile availability

GET `/api/central-needs/annual-source-capabilities?ownerOrgId=UUID&planningYear=YYYY` authenticates the real caller and checks current owner-scoped view authority before returning metadata. Query keys are exact and non-duplicated. It returns only profile IDs, numeric versions and registration hashes from one snapshotted server registry shared by discovery, C3 read and C4 commit. No mapping, review text, workbook bytes or row values are disclosed.

Read availability is separate from commit state: empty registry, missing C4 candidate, inactive candidate, insufficient current edit authority, or ready. Only the precise PostgREST missing-function code counts as candidate absence; malformed or other failures remain unavailable. Authority is rechecked before delivery. Responses are `no-store`. The default registry remains EMPTY and does not query the unapplied C4 contract merely to report that state.

This is explicit selection of a reviewed profile, not automatic source recognition. The selected-profile extraction fingerprint is not a registry-wide uniqueness claim. No template is selected by filename or silently chosen first, and a known held/conflicting source requires review rather than a dropdown override. Canonical material approval, missing-row review, annual quantity and allocation remain separate.

Injected tests cover exact scope, cross-owner refusal, immutable metadata, missing/inactive/forbidden states and revocation. Disposable actual Auth/HTTP acceptance verifies availability without business effects. No real registrations, source files, Production SQL or permission changes are included; the employee review UI is a later slice.
