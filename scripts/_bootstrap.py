"""The single place the Python floor is enforced.

Every entry point imports this first. Keep the version in one spot so the
guard, pyproject.toml, .python-version and install.sh cannot drift apart.
"""

import sys

REQUIRES = (3, 14)

if sys.version_info < REQUIRES:
    raise SystemExit(
        "error: job-scan requires Python %d.%d or newer — no backports, no "
        "compatibility shims.\n"
        "       Running under %s (%s).\n"
        "       Fix: run ./install.sh — it locates a suitable interpreter and "
        "pins it at\n"
        "            ~/.job-scan/bin/python, which is what the skill invokes."
        % (
            REQUIRES[0],
            REQUIRES[1],
            ".".join(map(str, sys.version_info[:3])),
            sys.executable,
        )
    )
