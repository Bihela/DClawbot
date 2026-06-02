# DClawbot

This project is configured with [Vercel Labs opensrc](https://github.com/vercel-labs/opensrc).

## What is opensrc?

`opensrc` is a CLI tool by Vercel Labs designed to fetch dependency source code and download it locally (or to a global cache) so AI models can have direct context of the libraries your project uses.

## Setup Details

1. **Git Repository:** Initialized.
2. **NPM Project:** Configured with `opensrc` added to `devDependencies`.
3. **Git Exclusion:** `.gitignore` includes `opensrc/` and `.opensrc/` to prevent external dependency repository source files from being committed to Git.

## How to use

Run the following command to download the source of any NPM package (e.g., `lodash` or `react`) to analyze it:
```bash
npx opensrc <package-name>
```
