# deptrail

deptrail explores the dependency trees of a repository that holds several independent
JavaScript roots, such as a monorepo with a few pnpm and npm projects side by side. It finds
every root, parses each one into a normalized dependency graph and serves a local web viewer
that answers these questions across all roots at once:

- Which packages have issues, and what fixes them?
- Who pulls this package in, and through which direct dependency?
- What does this package pull in?

After the scan, deptrail looks up every package in its registry and in the OSV.dev
vulnerability database in the background, and the viewer opens on **Issues** for all roots.
Issues lists the vulnerable and deprecated packages at any depth and the direct dependencies
with an update, grouped by package or by direct dependency. Under each package a Via line names
the packages that pull it in, with workspace packages shown as violet pills, here and in
Explore. Each row acts on exactly one root:
**Add fix** adds the recommended fix of a package to the changes of that root, and **Update…**
opens the version choice of a direct dependency. **Add recommended fixes…** adds the
recommended fix of every vulnerable package to the roots you check.

**Changes** lists the changes of each root. deptrail previews them in a temporary copy of the
root and, only after you confirm, writes them to the repository. It never commits.

**Explore** shows the structure of one root in three modes: **Dependents**, a column trail
from the workspace packages to the selected package; **Dependencies**, a tree; and
**Graph**, around the package or, with no package selected, of the whole root. Badges mark a vulnerable or deprecated
package, an update with its size (`↑ 1.1.0 minor`) and, on every ancestor, how many
vulnerable packages lie below it (`1 vulnerable below · high`). A `dup` badge marks a package
with several versions in the repository, and **Options** can show only those.

In a git repository, the source switcher in the header shows any branch, tag or the last commit
instead of the working tree, read-only and without checking it out, and **Compare** shows what
changed in dependencies and vulnerabilities between two of them.

The root switcher in the header shows which root every view works on, either one root or All
roots, and only controls that name a root change it. Global search finds a package by name or
by `name@range` in every root. The roots panel on the left lists the roots with their health
and workspace packages, and the details panel on the right says why the selected package is
there, which advisories affect it and what to do about it: re-lock within the range it asks
for, update a range in a workspace `package.json`, update parent packages, or override the
version. Both side panels collapse to give the center more room.

## Usage

```
npx @loomhelix/deptrail [path] [--port <n>] [--no-open] [--json] [--offline]
```

After `npm install --global @loomhelix/deptrail`, the same command is `deptrail [path] [options]`.

| Argument | Meaning |
|---|---|
| `path` | Repository to scan. Defaults to the current directory. |
| `--port <n>` | Port for the local server. Defaults to a free port. |
| `--no-open` | Print the viewer URL without opening a browser. |
| `--json` | Print the normalized scan as JSON to stdout and exit, without starting the server. The output has no registry or vulnerability data, and nothing is sent over the network. |
| `--offline` | Send no requests to registries or OSV.dev. The viewer shows the dependency trees without registry or vulnerability data, and actions are unavailable. **Resolve versions** still runs the package manager, which uses the network as it is configured to. |
| `-h`, `--help` | Print the options and environment variables and exit. |
| `-v`, `--version` | Print the version and exit. |

| Variable | Use |
|---|---|
| `DEPTRAIL_CACHE_DIR` | Cache directory instead of `~/.cache/deptrail`. |
| `DEPTRAIL_OSV_URL` | Base URL of an OSV-compatible API, such as a mirror, instead of `https://api.osv.dev`. |
| `npm_config_registry` | Default registry, as with npm. The name is matched case-insensitively, so `NPM_CONFIG_REGISTRY` works too. |
| `npm_config_userconfig` | User config file to read instead of `~/.npmrc`. |

Without `--json`, deptrail prints `deptrail: <url>`, opens that URL in the default browser and
keeps serving until it receives Ctrl+C. Errors that happen while serving are printed to stderr
as one line each, with credentials redacted.

## Keyboard

The global keys do nothing while focus is in a text field:

| Key | Action |
|---|---|
| `⌘K`, `Ctrl+K`, `/` | Focus search |
| `[` | Collapse or expand the roots panel |
| `]` | Collapse or expand the details panel |
| `1` `2` `3` `4` | Go to Issues, Changes, Explore, or Compare |
| `?` | Show keyboard shortcuts |
| `Esc` | Close the open menu, popover, or dialog |

Issues, Changes, the roots panel, the tree and the trail are one Tab stop each. Inside
them, ↑ and ↓ move, Home and End jump to the first and last row, ← and → collapse and expand
(and move between trail columns), Enter selects, and Tab moves into the row's buttons. Add,
Apply, Revert and Clear write files or change the list, so they run only from their buttons
and no single key triggers them.

## Roots and sources

A root is a directory with its own `pnpm-lock.yaml`, `package-lock.json` or
`npm-shrinkwrap.json`, a `pnpm-workspace.yaml`, a `package.json` with `workspaces`, or a
standalone `package.json`. Directories that belong to a workspace of an enclosing root are
workspace packages of that root, not roots of their own. `node_modules`, `.git` and
directories ignored by a `.gitignore` are skipped: the one at the top and the ones in
subdirectories, each applied to its own subtree. deptrail reads plain names (`vendor`),
directory names (`cache/`) and paths (`/build`, `dev/copy`) and skips lines with wildcards or
`!`, so a pattern it cannot read shows a directory rather than hides one.

Each root is built from the best source available. The roots panel shows a badge on a root
that was not built from its lockfile:

| Badge | Source | Accuracy |
|---|---|---|
| none | The root's lockfile | Exact. |
| `installed` | The root's `node_modules`, when there is no usable lockfile | Exact for the last install in this checkout. |
| `resolved today` | A lockfile generated in a temporary directory with `pnpm install --lockfile-only` or `npm install --package-lock-only` | Approximate: versions are resolved as of today, not as they were last installed. |
| `manifest only` | The `package.json` files of the root | Direct dependencies only. |

Roots with `resolved today` or `manifest only` show a **Resolve versions** button. It
copies the root's manifests and configuration (`package.json` files, `.npmrc`,
`pnpm-workspace.yaml`) into a temporary directory, runs the package manager there with
`--ignore-scripts` to generate a lockfile without installing packages, rebuilds the root from
that lockfile and deletes the temporary directory. When the package manager is missing, fails
or runs longer than five minutes, the root falls back to `manifest only` and its warnings
explain why. Stopping deptrail with Ctrl+C also stops a running package manager and deletes its
temporary directory.

## Branches and comparison

When the scanned directory is inside a git repository, the header has a source switcher to the
left of the root switcher. It shows the working tree and the checked-out branch, and its menu
lists the last commit (`HEAD`), local branches, remote-tracking branches and tags, newest first,
with a filter field. Choosing one shows Issues, Explore, search and details for that commit
without checking it out: deptrail lists the commit's files with `git ls-tree` and reads them
with `git cat-file`, finds the roots with the same rules and the same `.gitignore` files, and
builds each root from its lockfile, or from its `package.json` files when the lockfile is
missing or does not parse. A commit never reads `node_modules`, files inside a submodule are
not read (the notice names the submodules it skips), and symlinks in a commit are not followed,
so a `.npmrc` or `package.json` that is a symlink counts as missing there. **Resolve
versions** is not offered on a commit: it would run the package manager with that commit's
`.npmrc` and `pnpm-workspace.yaml`, which a read-only view does not trust. A remote-tracking
branch shows its state as of the last fetch; deptrail never fetches.

The source is part of the page address (`ref`), so a reload or a link opens the same branch,
and a branch that moved since shows its new commit. While a commit is shown, the switcher is
highlighted and a notice says which commit it is and that it is read-only. Changes and actions
apply to the working tree only: **Changes** says so, the action buttons give that reason, and
**Refresh** offers **Reload branch** instead of **Rescan files**. **Back to working tree** returns.
Changes added in the working tree stay while you look at a branch. deptrail keeps up to four
commits open and drops the least recently used one; a page whose commit was dropped reloads
and opens it again.

**Compare** compares the source in the header with a base you pick: by default the remote's
default branch (`origin/HEAD`), or the working tree when the header already shows that branch.
**Since merge base** compares with the last common commit of the two instead, so only what the
branch itself changed shows up. For each root that changed, Compare lists the vulnerable and
deprecated versions that the target introduces or resolves, the direct dependencies whose
range changed or that were added or removed in each workspace package, and the package versions
added, removed, upgraded, downgraded or changed. Package versions and risk are compared only
when both sides are built from a lockfile or installed `node_modules`; otherwise a note says
which side is approximate, and only direct dependencies are compared. A root inside a git
submodule that only one side can read is listed with a note instead of being compared.
**Swap** exchanges base and target. A package that exists in the target opens in the details panel.

## Actions

Every change belongs to one root. The details panel has an **Actions** block for a vulnerable
package and for a direct dependency of a workspace package. **Add to changes** puts the chosen
fix or version into the changes of the selected package's root, which the **Changes** view
lists. Once the change is there, the button reads **✓ In changes · Review** and opens it in
**Changes**. When the changes hold the same goal with another choice, the panel names that
choice ("In changes: Override to 1.0.1"), and **Replace in changes** swaps it for the
one you picked, in place and in one step. When the new choice conflicts with another change,
the old one stays.

In **Issues**, each root of a package has its own row with its own button:

- **Add fix** adds the recommended fix to the changes of that row's root only. The
  recommended fix is the same one the details panel recommends. The button then reads
  **✓ In changes** and opens the change in **Changes**.
- **Update…** selects a direct dependency in that root, opens the details panel and moves
  focus to its version choice.
- **Add recommended fixes…** asks which roots to cover, adds the recommended fix of every
  vulnerable package to each checked root and reports what it added and skipped per root.

**Changes** has a section for each root with changes. **Edit** on a change selects its
package in that root and opens **Actions** with the change's choice. **Save change** then
replaces the change in place. **Clear** removes every change of a root at once and offers
**Undo** for 10 seconds to bring them back. The roots panel shows how many changes each root
has. Changes live in memory until deptrail stops.

Actions are available for a root that scanned from its lockfile, with pnpm or npm on the
`PATH`, and not with `--offline`. A root may have workspace packages outside its directory
only when it is a pnpm root, its `pnpm-workspace.yaml` declares them and they lie inside the
scanned repository. Otherwise actions stay unavailable and the panel gives the reason: an npm
root with such packages, a package outside the repository, or a lockfile importer that
`pnpm-workspace.yaml` does not declare. deptrail runs `pnpm --version` or `npm --version` in the root
directory, so `packageManager` and Corepack apply; otherwise the panel says why actions are
unavailable. A safe version is a published version that is not a prerelease and is not
affected by any advisory of the package.

| Action | Offered for | What it writes |
|---|---|---|
| **Re-lock** | A vulnerable package when one safe version satisfies every range that requests it | The lockfile only: every locked copy of the affected version moves to the highest such safe version. |
| **Update parent packages** | A vulnerable package that a parent's range keeps on an affected version | The lockfile, where parents move to versions that accept a safe version, plus the raised range of a direct dependency in each workspace `package.json` that needs it, or its catalog entry in `pnpm-workspace.yaml`. The parent versions that accept a safe version are found in the published manifests, up to five levels above the package. When some ranges already admit a safe version, the chain also re-locks those, and its title starts with **Re-lock and update**. |
| **Override** | A vulnerable package, as the alternative to the chain | One override `"name@<X": "X"` and the lockfile. `X` is the highest safe version in the current major; when there is none, the lowest safe version above the current one, with the warning "major jump". The override goes where the root already declares overrides, otherwise to `pnpm-workspace.yaml` for pnpm 10 or later, to `pnpm.overrides` in the root `package.json` for older pnpm, and to `overrides` in the root `package.json` for npm. npm does not allow an override of a direct dependency of the root package, so for such a package the panel suggests the update instead. |
| **Update** | A direct dependency | The version marked **in range**, the highest within the current ranges, is a re-lock and writes only the lockfile. **latest** or any other published version rewrites the range in each selected workspace `package.json`, or the catalog entry, and the lockfile. The range keeps its form (`^2.0.0` becomes `^3.0.0`, `~2.0.0` becomes `~3.0.0`, an exact version stays exact), and any other range becomes `^<version>`. `workspace:`, git, `file:` and `link:` specifiers, URLs, dist-tags and `peerDependencies` are never edited. |

An item with the same goal as another item, a fix of the same package version or an update of
the same package, is refused, and so is an item that sets a range, an override or a re-lock to
a different value than another item; the message names the other item.

**Preview** copies the root's manifests, `.npmrc`, `pnpm-workspace.yaml` and lockfile into a
temporary directory, and for pnpm also the pnpmfile and the files named in
`patchedDependencies`. It applies the changes to the copy and runs
`pnpm install --lockfile-only --ignore-scripts` or
`npm install --package-lock-only --ignore-scripts --no-audit --no-fund` there. When the root's
`package.json` names no `packageManager`, the temporary directory pins the version found in the
root for Corepack, and the preview stops when the copy reports another version. A re-lock adds a
temporary override for the package manager run and removes it again, so only the lockfile keeps
the new version. The preview then shows:

- whether each goal is met, and for a fix that is not, which package still requires the
  affected version;
- packages that are new in the root and vulnerable or deprecated;
- warnings, including `WARN` lines of the package manager, a change of the lockfile format,
  each other parent whose version of a re-locked or overridden package moves (marked
  "downgrade" when it moves down), and the package manager version used;
- every file that would change with its diff (the lockfile diff loads on demand and stops at
  2 MB), and the package versions removed, added and changed.

Nothing in the repository changes during a preview. Editing the changes or rescanning the
root makes the preview stale, and only a current preview can be applied.

**Apply…** opens a confirmation that lists unmet goals first, then the files to write, and a
checkbox to run install afterwards: `pnpm install --frozen-lockfile` or `npm ci` in the root
directory, with the project's own script settings. The checkbox is checked when the root has a
`node_modules` directory. Apply refuses to write when any file it copied for the preview has
changed since. It writes exactly the previewed files, each to a temporary file that is renamed
into place, the lockfile last, and restores the files already written when a write fails. A
file it cannot restore is named in the error, and **Revert files** restores it later.
Install runs for at most 15 minutes and its output is shown live. A failed install leaves the
files written. deptrail then rescans the root, and the applied changes leave the list;
changes added after the preview stay. The root's section shows the outcome first: the goals
met and the files written. When install did not run, it says that `node_modules` was not
updated and which command to run when ready. When the selected package moved to another
version, the details panel follows it there and says so.

A workspace package can belong to more than one root: a package outside this root that
another root also lists, or a package inside this root that another root lists, for example
a root elsewhere whose `pnpm-workspace.yaml` points into this one. Only roots built from their
lockfile count. When a change writes such a package's `package.json`, the other root's
lockfile does not change. The preview then warns once per such root, names up to three of the
shared `package.json` files and says to run the package manager's install in that root. The
Apply dialog marks those files, and the outcome names the roots to update. The install you
confirm also writes `node_modules` in the packages outside the root, and the dialog says so
under the checkbox. An apply or revert is refused with a 409 while another root that shares a
workspace package applies or reverts.

**Revert files** restores the files the last apply wrote and removes the ones it created, as
long as each of them still has the content deptrail wrote. It is available until the next
apply in that root or until deptrail stops, also when other actions are unavailable, except
while the root scans. It does not touch `node_modules`. After the revert, the applied changes
are back in the list in their order, except those that duplicate or conflict with a change
added since; the outcome names the skipped ones. When install ran during the apply, the
outcome says that `node_modules` still has the applied versions and which command to run.

One preview, apply or revert runs per root at a time. While one runs, **Resolve versions**
for that root and **Rescan files** are refused. **Cancel** stops a preview at any point and an apply
while install runs; the files already written stay. Ctrl+C stops a running package manager and
deletes the temporary directories, and an install that has not started yet does not start. deptrail never commits, never creates branches and never
runs a package manager in the repository except for the install you confirm.

## Network

Unless `--offline` is given, deptrail sends these requests after the scan:

| Destination | What is sent |
|---|---|
| The package's registry in that root: the scope's registry when `.npmrc` declares one, otherwise the default registry | `GET <registry>/<name>` (`@scope%2fname` for scoped names) for the abbreviated packument, with `If-None-Match` when a cached ETag exists and `Authorization` when credentials for that registry are configured. |
| OSV.dev (`https://api.osv.dev`, or `DEPTRAIL_OSV_URL`) | `POST /v1/querybatch` with the name and version of every checked package, then `POST /v1/query` with the name of each package that has known vulnerabilities, to load all of its advisories. |

- Every request carries `User-Agent: deptrail/<version> node/<Node.js version>` and nothing
  else that identifies you.
- A scope is private when the user config or the `.npmrc` of any root declares a registry for
  it (`@acme:registry=...`). Packages in private scopes are never sent to OSV.dev, from any
  root, and neither are packages without an exact version (`manifest only`). A root that
  fails to scan contributes no `.npmrc` settings, so no credentials and no private scopes,
  until it scans successfully; a scope that it declared in an earlier successful scan stays
  private while deptrail runs.
- Dependencies declared with `workspace:`, `file:` or `link:` specs or from git are sent
  nowhere, and the details panel says that they are not checked. Workspace packages and
  placeholders are sent nowhere either. Known limitation: a dependency declared as a direct
  `https://…/x.tgz` URL in an npm lockfile is still treated as a registry package.
- At most 16 requests run at a time per origin (scheme, host and port). OSV.dev receives up
  to 1000 versions per batch request. A request that fails with a network error, HTTP 429 or
  a 5xx status is retried twice, after 1 s and 4 s, honoring `Retry-After` up to 30 s.
- HTTP proxies are not supported, nor are custom CA files (`cafile`, `ca`), client
  certificates (`cert`, `key`) and `strict-ssl=false`. TLS uses the Node.js default
  certificate store plus `NODE_EXTRA_CA_CERTS`.
- When a registry or OSV.dev cannot be reached, the roots panel reports the problem per
  origin, expired cached data is shown with its date, and the rest of the viewer keeps
  working.
- When a registry answers HTTP 401, its packages that have not been requested yet with the
  same credentials fail without a request, and the roots panel suggests checking the token in
  `.npmrc`. A 403 fails only that package. **Recheck registry and OSV** tries again.
- **Recheck registry and OSV**, in the **Refresh ▾** menu of the header, treats every cached entry as expired, retries failed lookups
  and reads each root's `.npmrc` again, so a token corrected there takes effect without a
  restart. The user config is read once at startup.
- With `--offline`, **Resolve versions** still runs the package manager, which uses the
  network as it is configured to.
- For the parent chain of a fix, actions request the packument of a parent again with the
  declared dependencies of every published version, not only of the versions in use. A
  preview checks the packages it adds with the registry and OSV.dev under the same rules.
  **Preview** and install run the package manager, which uses the network as it is configured
  to.

## Security model

- The server binds to `127.0.0.1` only.
- Every run generates a random token. The URL that deptrail prints and opens carries it once;
  the server then replaces it with an `HttpOnly`, `SameSite=Strict` cookie named
  `deptrail_token_<port>` and removes it from the address bar. Because the cookie name carries
  the port, several deptrail instances can run side by side without signing each other out.
  Requests without the token are rejected.
- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS
  rebinding. Every request with a method other than `GET` and `HEAD` must also carry a
  matching `Origin`, and a request body must be JSON (`Content-Type: application/json`) of at
  most 64 KB. `GET` requests never change anything.
- Every response carries `X-Frame-Options: DENY` and
  `Content-Security-Policy: frame-ancestors 'none'`, so no other page can frame the viewer.
- Registry settings are read from the root's `.npmrc`, the user config (`~/.npmrc` or
  `npm_config_userconfig`) and the `npm_config_registry` variable. Credentials
  (`//host/:_authToken`, `:_auth`, `:username` with `:_password`, and user info in a registry
  URL) are held in the server's memory and sent only with requests to the registry they
  belong to, matched by host, port and the longest path prefix. On a redirect they are looked
  up again for the new URL, so they never reach another host. Unscoped `_authToken` and
  `_auth` are ignored with a warning, as npm 9 and later do.
- Credentials never reach the browser, the API, the `--json` output, the cache or the error
  output; known secret values are replaced in error messages, enrichment problems and
  package-manager output, including job logs and previews. The API and the `--json` output
  only report whether a root has registry authentication configured (`hasAuth`). Enrichment problems in the API name only
  the registry origin (`scheme://host[:port]`), never a path or credentials, and the `--json`
  output never contains registry URLs.
- deptrail writes inside the repository only when you apply previewed changes or revert
  them, and only to manifests, `pnpm-workspace.yaml` and the lockfile: the root's manifests,
  `pnpm-workspace.yaml` and lockfile inside the root directory, and outside it only the
  `package.json` of a pnpm workspace package that the root's `pnpm-workspace.yaml` declares,
  resolved to its real path and required to stay inside that package's directory and the
  scanned repository. It never creates a new file outside the root directory: an outside
  `package.json` is replaced through a temporary file in the same directory that is renamed
  over it. The install you confirm also writes `node_modules` in those packages. The browser sends
  only choices (the root, the package, the option, a version and workspace packages), never
  paths or file contents, and the server derives every edit from its own data. Temporary work
  happens under the system temporary directory, and everything else goes to the cache
  directory described below.
- A preview copies the root's `.npmrc`, credentials included, into its temporary directory,
  which only your user can read, and deletes the directory when the preview ends or deptrail
  stops. This is the only place where deptrail itself writes credentials to disk.
- In a preview the package manager always runs with `--ignore-scripts`. For pnpm, the copy
  includes `.pnpmfile.cjs` or the configured pnpmfile: it is project code, and pnpm runs it
  during the preview as it would during install, because without it the lockfile would not
  match a real install. In the repository the package manager runs only for the install you
  confirm, with the project's own script settings.
- Branches only read git. deptrail runs `git` directly, never through a shell, and only these
  commands: `git --version`, `git rev-parse` (the top of the repository, the scanned
  directory's prefix and `HEAD`), `git symbolic-ref -q HEAD`, `git for-each-ref`, `git ls-tree`,
  `git cat-file --batch` and `git merge-base`. It never fetches, pushes, changes git
  configuration, stashes, checks out, creates worktrees or moves refs. Every environment variable
  whose name starts with `GIT_` is removed, so a variable such as `GIT_DIR` cannot point git at
  another repository, and `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_NO_LAZY_FETCH=1`
  and `LC_ALL=C` are set.
- The browser sends a ref name, which must not start with `-` and must equal a name that
  `git for-each-ref` lists (or `HEAD`). deptrail resolves it to a commit id; only commit ids
  reach git's command line, after `--end-of-options`, and only blob ids reach `cat-file`.
- A partial clone downloads missing objects when they are read. With git 2.44 or later,
  `GIT_NO_LAZY_FETCH=1` prevents that; with an older git, branches are unavailable in a partial
  clone.
- On another branch, registry settings come from that branch's `.npmrc` and
  `pnpm-workspace.yaml`, but registry credentials come only from the working tree's `.npmrc`,
  the user configuration and the environment, matched to their registry as described above, so
  a registry that only a branch configures receives no credentials. Lines of a branch's
  `.npmrc` that reference an environment variable (`${...}`) are ignored, so a branch cannot
  put an environment value into a registry address, and the package manager never runs with a
  branch's configuration.

## Cache

deptrail caches in `~/.cache/deptrail`, or in `DEPTRAIL_CACHE_DIR` when it is set:

| Path | Contents |
|---|---|
| `<key>.json` | Parsed roots, keyed by the repository path, the root path and the lockfile contents. |
| `registry/` | Registry metadata per registry and package name: dist-tags, the version list, deprecation messages and the declared dependency ranges of the versions in use. |
| `osv/matches/` | The vulnerability ids that OSV.dev reports for each `name@version`. |
| `osv/packages/` | Every advisory of each package that has known vulnerabilities. |
| `registry-versions/` | Per registry and package name, the declared dependency ranges of every published version, loaded only for the parent chain of a fix. |

Registry and OSV.dev entries expire after 12 hours, so a second run within that time only
requests what is missing from the cache. An expired registry entry is revalidated with its
ETag. Files are named by a SHA-256 hash and never contain registry URLs or credentials.
Metadata of private packages (version lists and deprecation messages) is stored, as npm's own
cache does. Writes are atomic, and a corrupt entry is ignored and fetched again.

## Requirements

- Node.js 22 or later.
- macOS or Linux. On Windows, deptrail cannot start pnpm or npm yet, so actions and
  **Resolve versions** are unavailable there.
- pnpm or npm on the `PATH` for actions and for **Resolve versions**; scanning
  lockfiles, `node_modules` and manifests needs neither. Actions use the package manager of
  the root's lockfile.
- Network access to the registries and to OSV.dev only for registry and vulnerability data;
  without it, or with `--offline`, the viewer shows the dependency trees without registry or
  vulnerability data. With `--offline`, actions are unavailable.
- git 2.24 or later on the `PATH` for branches and Compare (2.44 or later in a partial clone).
  Without it, everything else works and the header says "Branches unavailable" with the reason.

## Development

`pnpm playground` builds deptrail and starts it on a temporary monorepo with two roots, `shop` (pnpm) and `shop-npm` (npm), backed by a fake npm registry and a fake OSV.dev, so nothing reaches the network. It prints the viewer URL and the path of the temporary monorepo. The monorepo is a git repository: `main` is checked out, the branch `fix/child-lib` fixes the vulnerable `child-lib`, `main` moved on after that branch started, and there are a tag `v1.0.0` and a remote-tracking `origin/main`, so the source switcher and Compare can be tried. It needs pnpm, npm and git on the `PATH`. Press Ctrl+C to stop it and remove everything it created.

`pnpm build && DEPTRAIL_WALKTHROUGH=1 pnpm e2e walkthrough.spec.ts` goes through the same monorepo at 1440 × 900 and saves numbered screenshots of each step to `test-results/walkthrough/`. Any other `pnpm e2e` run clears `test-results/`, so run the walkthrough last.
