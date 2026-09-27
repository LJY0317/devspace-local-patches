# DevSpace downstream source

This repository contains [Waishnav/DevSpace](https://github.com/Waishnav/devspace)
source plus local changes. The upstream MIT license and contributor notices remain in the
tree. Its last verified upstream base when this independent public history was created was
`531d3f973f09f7b6b4993c9ff58f80a4514b9ba2` on `upstream/main`.

The local changes cover managed worktree ownership, restart-safe process provenance,
bounded command and read behavior, capability-gated progress, privacy-safe request and
incident diagnostics, and timer-driven idle lifecycle. Diagnostic evidence is generated
only on demand or on the corresponding failure path; private logs, authentication state,
and host-specific incident records are not part of this repository.

Use the upstream [README](README.md) and [setup guide](docs/setup.md) for the public
product workflow. For a source checkout, install the Node.js and pnpm versions declared
in `package.json`, then run `pnpm install`, `pnpm test`, and `pnpm build`. A source build
does not replace or restart any already-running DevSpace server.

This repository begins with one independent source commit. Future upstream updates must
compare with the recorded base, reapply the local behavior to a fresh upstream tree,
verify the affected contracts, and integrate the resulting source. A normal Git rebase
onto upstream is not available from this snapshot.
