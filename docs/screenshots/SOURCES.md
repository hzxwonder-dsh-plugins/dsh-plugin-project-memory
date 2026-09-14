# Screenshot provenance

The memory plugin has no graphical panel. The README image is a rendered
verification report, not a fabricated product screenshot.

| File | Source | Scope |
| --- | --- | --- |
| `memory-test-output.svg` | Captured output of `npm test` in this repository on 2026-09-12 | 14 automated tests passed; it covers storage, CAS, concurrency, policy, process maintenance, and credential boundaries |

The SVG preserves the test names and final counts from
`/private/tmp/dsh-memory-test-output.txt`. Its SHA-256 is:

```text
ff7ff4e2d1f05fd381034aea7d93cb609fd4181c0d99c507e322f2d7c5a35e08  memory-test-output.svg
```

A full Harness Web startup and interactive Session test remains a separate
runtime check. The repository README records the current host limitation and
does not infer UI health from this report alone.
