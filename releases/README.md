# Release manifests

Each release manifest freezes the exact source used for cross-package verification and package publication. A manifest is named after the central ecosystem release, for example `0.1.0.json`.

Create the manifest only after every package repository has its final reviewed commit. Each of the 15 package entries must contain:

- the exact `authmodules/<repository>` name;
- the full lowercase 40-character commit revision;
- the protected `v<version>` tag;
- the exact independently managed package version.

Do not use placeholder revisions, branch names, shortened hashes, version ranges, or mutable workflow input JSON. The central release workflow checks out every package tag and rejects the run unless the resulting commit matches the recorded revision.
