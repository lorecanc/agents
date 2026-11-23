#!/usr/bin/env python3
"""Smoke test degli MCP server ArtCraft via stdio.

Legge un file opencode.json, spawna ogni server in mcp.servers,
esegue l'handshake MCP (initialize + initialized + tools/list) e
riporta protocollo, numero di tool e un campione di nomi.

I server ArtCraft usano JSON-RPC a righe (ndjson) su stdio, non
l'incapsulamento Content-Length di LSP.

Uso: python3 resources/artcraft/mcp-smoke.py [percorso/opencode.json] [--only nome,...]
"""

import json
import os
import selectors
import subprocess
import sys
import time

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
            # notifiche o risposte di altri id: ignora e continua
            continue
        if time.monotonic() > deadline:
            raise TimeoutError(f"nessuna risposta per id={want_id} entro {timeout}s")
        if not sel.select(max(0.0, deadline - time.monotonic())):
            continue
        chunk = os.read(proc.stdout.fileno(), 65536)
        if not chunk:
            raise EOFError("il server ha chiuso stdout")
        buf += chunk


def smoke(name, argv):
    proc = subprocess.Popen(
        argv,
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
                    "clientInfo": {"name": "artcraft-smoke", "version": "0.1"},
                },
            },
        )
        init = recv_response(proc, sel, 1, INIT_TIMEOUT)
        if "error" in init:
            return name, False, 0, [], f"initialize: {init['error'].get('message')}"
        send(proc, {"jsonrpc": "2.0", "method": "notifications/initialized"})
        send(proc, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        resp = recv_response(proc, sel, 2, TOOLS_TIMEOUT)
        if "error" in resp:
            return name, False, 0, [], f"tools/list: {resp['error'].get('message')}"
        tools = resp.get("result", {}).get("tools", [])
        sample = [t.get("name", "?") for t in tools[:5]]
        return name, True, len(tools), sample, ""
    except Exception as e:  # noqa: BLE001 - il smoke test riporta qualunque fallimento
        return name, False, 0, [], f"{type(e).__name__}: {e}"
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    config_path = sys.argv[1]
    only = []
    if len(sys.argv) > 3 and sys.argv[2] == "--only":
        only = sys.argv[3].split(",")

    with open(config_path, encoding="utf-8") as f:
        config = json.load(f)
    servers = config.get("mcp", {}).get("servers", config.get("mcp", {}))

    rows = []
    for name, entry in servers.items():
        if only and name not in only:
            continue
        if entry.get("disabled", False):
            rows.append((name, None, 0, [], "disabled"))
            continue
        rows.append(smoke(name, entry["command"]))

    print(f"\n{'MCP':16} {'OK':4} {'tool':>5}  note / campione")
    print("-" * 78)
    failures = 0
    for name, ok, count, sample, err in rows:
        if ok is None:
            print(f"{name:16} {'--':4} {0:5}  disabled")
        elif ok:
            print(f"{name:16} {'si':4} {count:5}  {', '.join(sample)}")
        else:
            failures += 1
            print(f"{name:16} {'NO':4} {count:5}  {err}")

    print("-" * 78)
    total = len(rows)
    print(f"{total} server, {failures} falliti")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
