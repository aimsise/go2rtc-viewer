#!/usr/bin/env python3
# secret-guard.py — PreToolUse hook for the go2rtc-viewer repo.
#
# .env-hygiene rationale:
#   This is a LAN-only security-camera app. Real private LAN IPs (192.168.x /
#   10.x / 172.16-31.x) and RTSP/DVR URL credentials are SECRETS for this repo:
#   they reveal the user's home network layout and camera logins. The project
#   convention is that those real values live ONLY in the gitignored .env (and
#   the generated, gitignored cameras.json). Committed files must use ${VAR}
#   env-placeholders or RFC5737 documentation IPs (192.0.2.x / 198.51.100.x /
#   203.0.113.x).
#
#   This hook intercepts Write/Edit and BLOCKS the call when the NEW content
#   being written to a *committed* file contains a real private IPv4 or a
#   literal "://user:pass@" URL credential. .env* and cameras.json are exempt
#   because that is exactly where the real values are supposed to go.
#
#   Robustness: any malformed/unexpected stdin or unexpected tool -> ALLOW
#   (exit 0). The guard must never crash or block legitimate edits.

import json
import os
import re
import sys

# Real private IPv4 ranges (RFC1918). Deliberately does NOT match RFC5737 doc
# IPs (192.0.2.x / 198.51.100.x / 203.0.113.x) which are allowed in commits.
#   - the 10/8 branch requires a FULL 4 octets (10.x.x.x) so version strings
#     like "10.2.3" are not misread as a LAN IP.
PRIVATE_IP_RE = re.compile(
    r"\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b"
)

# Literal URL credential: scheme://userinfo@host where userinfo contains a
# colon (user:pass). We reject only when the userinfo has NO "${" AND is not a
# generic placeholder — so ${RTSP_USER}:${RTSP_PASS}@ env forms and doc examples
# like rtsp://user:pass@... (the add-form placeholder) are allowed.
URL_CRED_RE = re.compile(r"://([^/\s@]+:[^/\s@]+)@")

# Generic placeholder userinfos seen in docs/examples (NOT real credentials).
PLACEHOLDER_WORDS = {
    "user", "pass", "password", "username", "usr", "pwd",
    "<user>", "<pass>", "user_name", "your_user", "your_pass",
}


def allow():
    # Exit 0 with no output -> tool proceeds normally.
    sys.exit(0)


def block(reason: str):
    # Confirmed block mechanism: emit a PreToolUse deny decision (exit 0), and
    # also write to stderr so the message is visible regardless of consumer.
    out = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }
    print(json.dumps(out))
    print(reason, file=sys.stderr)
    sys.exit(2)


def is_exempt(file_path: str) -> bool:
    base = os.path.basename(file_path or "")
    # .env, .env.example, .env.local, etc. are the gitignored secret store /
    # committed template; cameras.json is generated (gitignored).
    return base.startswith(".env") or base == "cameras.json"


def scan(content: str):
    """Return a human-readable reason string if content is unsafe, else None."""
    if not content:
        return None

    m = PRIVATE_IP_RE.search(content)
    if m:
        return (
            f"secret-guard: refusing to write a real private LAN IP "
            f"'{m.group(0)}' into a committed file. Put real IPs in .env "
            f"(as ${{VAR}}) and use an RFC5737 placeholder (192.0.2.x) here."
        )

    for um in URL_CRED_RE.finditer(content):
        userinfo = um.group(1)
        if "${" in userinfo:
            continue  # env-placeholder form like ${RTSP_USER}:${RTSP_PASS}@ — allowed
        if all(p.lower() in PLACEHOLDER_WORDS for p in userinfo.split(":")):
            continue  # generic doc example like user:pass — allowed
        return (
            f"secret-guard: refusing to write literal URL credentials "
            f"'://{userinfo}@' into a committed file. Use an env-placeholder "
            f"form like ${{RTSP_USER}}:${{RTSP_PASS}}@ and keep real creds in .env."
        )

    return None


def main():
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            allow()
        data = json.loads(raw)
    except Exception:
        # Malformed / unreadable stdin -> never break the tool.
        allow()
        return

    try:
        tool_name = data.get("tool_name", "")
        if tool_name not in ("Write", "Edit"):
            allow()

        tool_input = data.get("tool_input") or {}
        file_path = tool_input.get("file_path", "")

        if is_exempt(file_path):
            allow()

        if tool_name == "Write":
            content = tool_input.get("content", "")
        else:  # Edit
            content = tool_input.get("new_string", "")

        reason = scan(content if isinstance(content, str) else "")
        if reason:
            block(reason)

        allow()
    except SystemExit:
        raise
    except Exception:
        # Any unexpected error -> allow, so we never wedge legitimate edits.
        allow()


if __name__ == "__main__":
    main()
