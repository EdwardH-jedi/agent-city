# Contract freeze record (lead)

Contracts v1 frozen 2026-10-02 after the lead's review of role 01's deliverable. Rulings: `packages/schema/src/workspace-m1/INTERFACE.md` §11.
Any later change = lead-approved versioned delta (consumers, migration/compatibility impact).

Verification at freeze (isolated runner): `bun --no-env-file test packages/schema/src/workspace-m1` 244 pass / 0 fail (role 01 report; re-run by the lead below); `bun run typecheck` exit 0.

## SHA-256 of the frozen contract files

```
587f0269ef1aaa1c4e850f26677063f2e6281860a8138bb0f6d8a58467dd6cbd  fixtures/vectors.json
4a694f905c94a39f2bdd711cce6834f69bd65e02a9726e8ae1447cc55dbd3c09  fixtures/sample.ts
f02e8a11e6fc0bb9a36cf95d5333a3172cfc59bda3437b211fe2eb6e60ffa3d4  INTERFACE.md
d06c72922e267ae718179b8b62f1fd57b6696490dc16bcf5c73101e7e3c53bc0  binding.ts
477639cdb8973c398bd4a25be6e6764c3ab386c16e2ff2aff9dfefd386d5ef55  canonical.ts
95319bca5ac1c3c43247f2d779500107b1be9a7c980388ed47bd099c8daeb051  decision.ts
5d71591108623ab447572560c6c82b360085a92ce273b6a8540ae0d646d94893  hash.ts
c87c49d8ab357e4354574f43f60237bf1aeeea564f905ed0e6a07348822a3fc8  ids.ts
00f0db7eb102bc3bcb83e2e37e86c81a57e0486fa22f035d2f20c93e653e0f4c  index.ts
3eadfab83da0af2cec35f93cf0eba2718b5e5b011b367d9e535e3e0f5a6d2f87  ports.ts
c903b45eb7bfc32d488a0d0509f2b6ed3f31b4f1d198beba707ca5c2c78ef65d  primitives.ts
b3a96d5b84c5ce3b3a88042b94c167812060b08a56c0e852d2044fc711ed6319  proposal.ts
58ddedb4e79b6846869e8087f6a8f81607ba9410c1dba1a0f68276e3e2acedde  result.ts
43f6e969cb4db5aa72c42f6cef7f46991681ce45736b154f39b7e8b0fdf23ffc  rows.ts
30e5fc7d1ac8cb6c0a84f091ac33432a98b9e93cf2c8dc0603f889462a82a2ba  state.ts
```
