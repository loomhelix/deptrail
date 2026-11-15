# deptrail

[![npm](https://img.shields.io/npm/v/@loomhelix/deptrail)](https://www.npmjs.com/package/@loomhelix/deptrail)
[![CI](https://github.com/loomhelix/deptrail/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/loomhelix/deptrail/actions/workflows/ci.yml)

A local viewer for the dependencies of every JavaScript project in a repository: what is
vulnerable, deprecated or outdated, who pulls it in, and how to fix it.

## Why

`npm audit` and `pnpm audit` check one project at a time and stop at "package X is
vulnerable". deptrail looks at all pnpm and npm projects of a repository at once and answers:

- Which projects are affected, and through which direct dependency?
- Can the fix stay within the current ranges, or does a parent have to move?
- What exactly changes in the lockfile?

## Quick start

Run it in your repository:

| | |
|---|---|
| npm | `npx @loomhelix/deptrail` |
| pnpm | `pnpm dlx @loomhelix/deptrail` |
| Yarn 2+ | `yarn dlx @loomhelix/deptrail` |
| Bun | `bunx @loomhelix/deptrail` |

It opens the viewer in your browser. Ctrl+C stops it.

## Features

- **Issues**: vulnerable (from [OSV.dev](https://osv.dev)) and deprecated packages at any depth,
  and direct dependencies with an update, each with the packages that pull it in.
- **Explore**: who depends on a package, what it depends on, and a graph.
- **Fixes**: re-lock, update the parents, override, or update a direct dependency. Each fix is
  previewed in a temporary copy with the diff of every file, and written only after you
  confirm. deptrail never commits.
- **Branches and Compare**: any branch or tag without a checkout, and what changed between two.

## Safety

- Runs on your machine only: the viewer listens on `127.0.0.1` with a per-run token.
- Changes files only after you confirm a preview, and never runs project scripts in a preview.
- Sends only package names and versions to your registries and OSV.dev; `--offline` sends
  nothing. Registry tokens go only to their own registry.

## Options

```
deptrail [path] [--port <n>] [--no-open] [--json] [--offline]
```

| Option | Meaning |
|---|---|
| `path` | Repository to scan, the current directory by default. |
| `--port <n>` | Port of the local server. |
| `--no-open` | Print the URL without opening a browser. |
| `--json` | Print the dependency graph as JSON and exit. |
| `--offline` | Make no network requests. |

## Requirements

- Node.js 22+, macOS or Linux.
- pnpm or npm for fixes, git for branches. Scanning needs neither.
- In npm roots, overrides need npm 11.2+ (Node.js 22 ships npm 10). On Windows, fixes are not
  available yet.

## More

[Reference](https://github.com/loomhelix/deptrail/blob/main/docs/reference.md) · [Security](https://github.com/loomhelix/deptrail/blob/main/SECURITY.md) · [MIT License](https://github.com/loomhelix/deptrail/blob/main/LICENSE)
