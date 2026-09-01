Hermes ACP Windows runtime
==========================

Pylon portable releases include a complete Git for Windows PortableGit tree in
runtime\\git. It is used only when an Agent has provider=hermes and runs through
the Windows subprocess ACP transport. Other Agents do not inherit this runtime
path or its environment variables.

The Hermes batch fallback defaults to 30 seconds. Set
HERMES_CONCURRENT_TOOL_TIMEOUT_S in that Agent's `env` map to override it; the
variable is passed only to the Hermes child process.

The tree is downloaded and verified by scripts\\prepare_hermes_runtime.py during
the portable release build. portable-git.json records the pinned upstream asset
and SHA-256. Keep the license and notice files shipped inside runtime\\git when
redistributing the release.

A source checkout does not need to carry the binary tree. Run:

  python scripts/prepare_hermes_runtime.py

before building a portable release. The script is idempotent and verifies an
existing tree before reusing it.
