# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 2.2.x   | ✅ |
| 2.1.x   | ✅ |
| < 2.0   | ❌ |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

To report a vulnerability, use GitHub's private vulnerability
reporting feature:
1. Go to https://github.com/j-srodka/agent86/security/advisories
2. Click "Report a vulnerability"
3. Describe the issue, steps to reproduce, and potential impact

You will receive a response within 7 days. If the vulnerability is
confirmed, a fix will be prioritized and a new release cut. You will
be credited in the release notes unless you request otherwise.

## Scope

Agent86 is a local tooling library and MCP server. It reads and
writes files on disk within the `root_path` provided by the caller.
It does not make network requests, transmit data externally, or
handle authentication. Security issues most relevant to this project:

- Path traversal in `root_path` or `destination_file` op arguments
- Snapshot cache poisoning via malicious `snapshot_id` values
- Arbitrary file write via `apply_batch` ops targeting paths outside
  the snapshot root
