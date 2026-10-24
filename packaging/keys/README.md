# Repository signing keys

This directory holds the **public** keys for the visend package repositories
hosted on gh-pages (`repo.visend.vishota.com`). CI copies everything here to
the root of the gh-pages branch.

The private parts live in GitHub Actions secrets and never enter this repo.

## apt (Debian/Ubuntu)

Generate once, locally:

    gpg --quick-generate-key "visend repo <vishota@vishota.com>" rsa3072 sign 0
    gpg --armor --export <KEYID> > apt-repo-public.asc

- public  -> commit `apt-repo-public.asc` here
- private -> export the secret key and store it as the `APT_GPG_KEY` secret:

      gpg --armor --export-secret-keys <KEYID>   # paste into APT_GPG_KEY

Users trust the key with:

    curl -fsSL https://repo.visend.vishota.com/apt-repo-public.asc | sudo tee /etc/apt/trusted.gpg.d/visend.asc

## apk (Alpine)

    apk add alpine-sdk   # on any alpine box/container
    abuild-keygen -a -n  # creates ~/.abuild/<email>.rsa[-.pub]

- public  (`~/.abuild/*.rsa.pub`)  -> commit here
- private (`~/.abuild/*.rsa`)      -> store as the `APK_SIGN_KEY` secret (PEM text)

The CI job signs `APKINDEX.tar.gz` with `abuild-sign` inside an alpine
container and publishes the `.rsa.pub` next to the repository.
