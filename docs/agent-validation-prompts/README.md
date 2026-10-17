# Agent Setup Validation

Use the installed direct CLI and paired RemNote CLI Bridge, not an MCP client.

1. Run `remnote-cli status`; verify the intended KB, protocol and write-policy flags.
2. Run `remnote-cli sdk capabilities --status supported --mode read`.
3. Read one explicitly selected known Rem ID. Do not perform writes for a setup check.
4. Report actual command results and any permission/capability failure without
   exposing the private token or raw KB content.

For real write acceptance, use the explicitly authorized
[guarded integration tests](../guides/integration-testing.md). A read-only setup
check never substitutes for real card creation, native readback and replay proof.
