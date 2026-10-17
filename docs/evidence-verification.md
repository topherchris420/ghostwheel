# Exported evidence and independent verification

Select a locally recorded run in **Forensic replay**, then **Export verifiable evidence**. This exports a full `ghostwheel-evidence-v1` event ledger, unlike the view-only snapshot playback JSON.

```sh
python scripts/verify-evidence.py evidence.json
```

The standalone Python verifier checks hash links, initial metadata, frame projections, run summaries and the saved head. It does not trust an embedded "verified" flag and does **not** reproduce the underlying simulation physics. Hash chaining alone is not proof of provenance: anyone able to rewrite the whole local ledger can also rewrite its head.

## External anchoring or investigator-managed signatures

Record the head hash in an independently trustworthy medium, then verify:

```sh
python scripts/verify-evidence.py evidence.json --expected-head <previously-published-hash>
```

Or manage an **Ed25519 private key outside GHOSTWHEEL**, sign the exact exported bytes and share the corresponding public key via an authenticated separate channel:

```sh
openssl genpkey -algorithm ED25519 -out investigator.pem
openssl pkey -in investigator.pem -pubout -out investigator-public.pem
openssl pkeyutl -sign -inkey investigator.pem -rawin -in evidence.json -out evidence.sig
python scripts/verify-evidence.py evidence.json --signature evidence.sig --public-key investigator-public.pem
```

No signing keys are bundled with the app or uploaded to the hosted simulator. A matching signature establishes key possession and file-byte integrity, not vehicle realism, safety certification, or a trustworthy timestamp.
