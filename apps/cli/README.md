# xcodit

Terminal coding agent. Installs into `~/.xcodit` on Linux and macOS.

Requires **Node 22+**.

## Install

Linux and macOS (no sudo):

```sh
curl -fsSL https://xcodit.dev/install.sh | bash
```

or:

```sh
npm i -g xcodit-ai --prefix ~/.xcodit
export PATH="$HOME/.xcodit/bin:$PATH"
```

Windows (PowerShell):

```powershell
npm i -g xcodit-ai --prefix "$env:USERPROFILE/.xcodit"
$env:Path = "$env:USERPROFILE/.xcodit;$env:Path"
```

Plain `npm i -g xcodit-ai` only works if your npm prefix is already writable (nvm, fnm, Homebrew). On Ubuntu it is not.

```sh
xcodit --demo
xcodit login
xcodit
```
