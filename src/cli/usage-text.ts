export const USAGE_HINT = 'Run deptrail --help to see the options.'

export const USAGE_TEXT = `Usage: deptrail [path] [options]

Explores the dependency trees of every JavaScript root in a repository and
serves a local viewer of their issues, dependents and fixes.

Arguments:
  path                    Repository to scan. Defaults to the current directory.

Options:
  --port <n>              Port for the local server. Defaults to a free port.
  --no-open               Print the viewer URL without opening a browser.
  --json                  Print the normalized scan as JSON and exit, without
                          starting the server or using the network.
  --offline               Send no requests to registries or OSV.dev.
  -h, --help              Show this help and exit.
  -v, --version           Print the version and exit.

Environment:
  DEPTRAIL_CACHE_DIR      Cache directory instead of ~/.cache/deptrail.
  DEPTRAIL_OSV_URL        Base URL of an OSV-compatible API instead of
                          https://api.osv.dev.
  npm_config_registry     Default registry, as with npm.
  npm_config_userconfig   User config file to read instead of ~/.npmrc.

Documentation: https://github.com/loomhelix/deptrail#readme
`
