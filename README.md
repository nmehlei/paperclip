# NME Paperclip image

This branch (`nme-image`) builds the Paperclip image NME runs: the stock upstream image
[`ghcr.io/paperclipai/paperclip`](https://github.com/paperclipai/paperclip) plus Debian Chromium and
fonts, published as `ghcr.io/nmehlei/paperclip:<upstream version>-nme.<n>`. It carries no Paperclip
source and no source changes; there is nothing to rebase.

Our additions to Paperclip live in NME-IaC (`solutions/paperclip`): the Azure DevOps plugins
(build waits, merge confirmations) and the start-time patches. NME-IaC pins the image by digest.

## Release

1. Bump `BASE` in the `Dockerfile` (tag and digest together:
   `docker buildx imagetools inspect ghcr.io/paperclipai/paperclip:<version>`) and push to
   `nme-image`. The workflow builds and smoke-tests: Chromium renders a page as `node`, the
   Hermes adapter file that NME-IaC's start-time patch edits
   (`packages/adapters/hermes/src/gateway/server/execute.ts`) must exist, and so must NME-IaC's
   start path (`server/dist/index.js` and the `tsx` loader; upstream itself starts
   `server/dist-runtime/index.mjs`, a bundle the patch cannot reach).
2. Tag the commit `nme/v<version>-nme.<n>` and push the tag; the workflow pushes the image. A tag
   whose version does not match `BASE` fails, and so does one that is already published (a
   re-run, also via "Run workflow" on the tag, never replaces an image). A new `<n>` on the same
   base refreshes the Chromium packages.
3. Pin the new digest in NME-IaC `solutions/paperclip/ansible/group_vars/all.yml`.

The earlier source fork (branch `nme`, tags up to `nme/v2026.1023.0-nme.5`) carried an Azure DevOps
merge sweep; that is now the NME-IaC plugin `nme.azure-devops-merges`.
