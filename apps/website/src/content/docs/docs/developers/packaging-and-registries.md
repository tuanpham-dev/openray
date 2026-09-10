---
title: Packaging and registries
description: Pack an extension into a .orx archive and publish a registry from any static host.
---

## Packing

An extension packs into a `.orx` archive — a zip carrying the manifest, prebuilt command
bundles, and assets under a top-level `extension/` directory. `node_modules`, `.git` and
`.DS_Store` are left out, and one file is added: `extension/openray.pack.json`, recording the
format version, the API version, the list of APIs the extension uses, and when it was packed.

```sh
npx openray pack                            # dist/<name>-<version>.orx
npx openray publish ext-a ext-b --out dist  # + dist/index.json
```

Because archives ship **prebuilt**, installing one needs no git, npm, or compiler on the
user's machine. Packing is where things are checked instead. The extension must:

- build cleanly,
- use only APIs this OpenRay provides — the list is recorded in `openray.pack.json` and
  re-checked at install,
- avoid native binaries and install scripts,
- carry a LICENSE if it inlines third-party code.

## Running a registry

A **registry** is nothing more than a directory like the one `publish` writes: an `index.json`
catalogue, the archives, and each extension's icon, screenshots and README alongside them. Serve
it from anywhere static. There is no backend.

A **local directory** works too — point OpenRay at a path rather than a URL and it reads the
catalogue straight off disk, which makes a shared folder or a `dist/` build a working registry
with no server at all.

Users add one under Settings → Add Extension → Registries and browse it with the
[Store](/docs/extensions/store) command.

A registry's CI needs no checkout of this repository — it installs the CLI as a dependency:

```yaml
# .github/workflows/pages.yml — publish a registry from a repo of extensions
name: Publish registry
on: { push: { branches: [main] } }
permissions: { contents: read, pages: write, id-token: write }
jobs:
  build:
    runs-on: ubuntu-latest
    environment: { name: github-pages }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install
      - run: npx openray publish extensions/*/ --out dist
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
      - uses: actions/deploy-pages@v4
```

Publishing a new version is then a `git push`. `dist/` need not be committed — CI
regenerates it.

The worked example of all of this is the default registry's own repository,
[OpenRay Extensions](https://tuanpham-dev.github.io/openray-extensions/): a folder per
extension, a Pages workflow, nothing else.

## Two things to know before running your own

Catalog entries may point `file` at an absolute URL, so a registry that outgrows GitHub
Pages' 100 GB/month can keep `index.json` there and move archives to Releases assets
without any app change.

**Archives are unsigned, and the checksum is optional.** `sha256` on a catalogue entry is a
field a catalogue *may* declare. When it is there, OpenRay verifies it on download and refuses a
mismatch. When it is absent — which a hand-written catalogue can simply leave out — the archive
is installed with no verification at all. Either way it says nothing about who published the
file. Adding a registry is the trust decision — see
[Trust and security](/docs/extensions/trust-and-security).

Archives produced by `openray publish` always carry a `sha256`.

## Related

- [CLI reference](/docs/developers/cli)
- [The Store](/docs/extensions/store)
