# Script for Starting and Stopping Mock Provider

## Goal

Create a convenient control script (e.g. `scripts/mock-provider.sh`) to start,
stop, restart, check status, and view logs of the mock capture server,
and wire it into `package.json` scripts.

## Steps

- [x] Write `scripts/mock-provider.sh` supporting `start`, `stop`, `restart`,
  `status`, `logs` commands with PID file management and port checking
- [x] Make the script executable (`chmod +x`)
- [x] Add convenience npm scripts (`capture:start`, `capture:stop`,
  `capture:status`, `capture:logs`) to `package.json`
- [x] Document the script in `README.md` and `AGENTS.md`
- [x] Test the script (`start`, `status`, `stop`) to ensure robust operation
- [x] Run linter subagent to verify formatting and linting clean state

## Notes

- PID file: `.capture-server.pid` (or in `/tmp` / project root, ignored in `.gitignore`)
- Log file: `capture/server.log`
- Port: default 8787 or `$PORT`
