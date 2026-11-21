#!/usr/bin/env python3
"""Dump the tools of every ArtCraft MCP server to markdown inventories.

Reads the pack's opencode.json, spawns every server listed in
mcp.servers (regardless of `disabled`, which only tells OpenCode not
to connect), runs the MCP handshake (initialize + initialized +
tools/list, following cursors) and writes one markdown file per
server to resources/artcraft/inventory/.

The ArtCraft servers speak line-delimited JSON-RPC (ndjson) on stdio,
not LSP-style Content-Length framing.

Usage: python3 tools/artcraft/inventory.py [--only name,...]
"""

import json
import os
import re
import selectors
import subprocess
import sys
import time
from datetime import date
from pathlib import Path

PACK_ROOT = Path(__file__).resolve().parent.parent.parent
CONFIG_PATH = PACK_ROOT / "opencode.json"
OUT_DIR = PACK_ROOT / "resources" / "artcraft" / "inventory"

INIT_TIMEOUT = 30.0
TOOLS_TIMEOUT = 30.0


def send(proc, payload):
    proc.stdin.write(json.dumps(payload).encode() + b"\n")
    proc.stdin.flush()


def recv_response(proc, sel, want_id, timeout):
    buf = b""
    deadline = time.monotonic() + timeout
    while True:
        nl = buf.find(b"\n")
        if nl != -1:
            line, buf = buf[:nl], buf[nl + 1 :]
            line = line.strip()
            if line:
                msg = json.loads(line)
                if msg.get("id") == want_id:
                    return msg
            continue
        if time.monotonic() > deadline:
            raise TimeoutError(f"no reply for id={want_id} within {timeout}s")
        if not sel.select(max(0.0, deadline - time.monotonic())):
            continue
        chunk = os.read(proc.stdout.fileno(), 65536)
        if not chunk:
            raise EOFError("the server closed stdout")
        buf += chunk


def list_tools(proc, sel):
    tools = []
    cursor = None
    req_id = 2
    while True:
        params = {}
        if cursor:
            params["cursor"] = cursor
        send(proc, {"jsonrpc": "2.0", "id": req_id, "method": "tools/list", "params": params})
        resp = recv_response(proc, sel, req_id, TOOLS_TIMEOUT)
        if "error" in resp:
            raise RuntimeError(resp["error"].get("message", "tools/list failed"))
        result = resp.get("result", {})
        tools.extend(result.get("tools", []))
        cursor = result.get("nextCursor")
        req_id += 1
        if not cursor:
            return tools


def clean(text):
    return re.sub(r"\s+", " ", (text or "").strip())


def dump(name, entry):
    proc = subprocess.Popen(
        entry["command"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    sel = selectors.DefaultSelector()
    sel.register(proc.stdout, selectors.EVENT_READ)
    try:
        send(
            proc,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "artcraft-inventory", "version": "0.1"},
                },
            },
        )
        init = recv_response(proc, sel, 1, INIT_TIMEOUT)
        if "error" in init:
            return name, 0, f"initialize: {init['error'].get('message')}"
        send(proc, {"jsonrpc": "2.0", "method": "notifications/initialized"})
        tools = list_tools(proc, sel)
    except Exception as e:  # noqa: BLE001 - the dump reports any failure
        return name, 0, f"{type(e).__name__}: {e}"
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    lines = [
        f"# {name}",
        "",
        f"CLI: `{' '.join(entry['command'])}` · {len(tools)} tool · dumped {date.today().isoformat()}",
        "",
    ]
    for tool in tools:
        desc = clean(tool.get("description"))
        lines.append(f"- `{tool.get('name', '?')}` — {desc}" if desc else f"- `{tool.get('name', '?')}`")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / f"{name}.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return name, len(tools), ""


def main():
    only = []
    args = sys.argv[1:]
    if args and args[0] == "--only":
        only = args[1].split(",")

    with open(CONFIG_PATH, encoding="utf-8") as f:
        servers = json.load(f).get("mcp", {}).get("servers", {})

    print(f"{'MCP':16} {'tool':>5}  note")
    print("-" * 60)
    failures = 0
    total_tools = 0
    for name, entry in servers.items():
        if only and name not in only:
            continue
        name, count, err = dump(name, entry)
        total_tools += count
        if err:
            failures += 1
            print(f"{name:16} {count:5}  {err}")
        else:
            print(f"{name:16} {count:5}")
    print("-" * 60)
    print(f"{total_tools} tool across {len(servers) if not only else len(only)} server, {failures} failed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
