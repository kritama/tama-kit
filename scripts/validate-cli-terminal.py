#!/usr/bin/env python3
"""Smoke-test the installed CLI with an actual terminal on macOS and Linux."""

import errno
import os
import pty
import re
import select
import signal
import sys
import tempfile
import time


def scenario(node, cli, answers, expected, dry_run=False):
    with tempfile.TemporaryDirectory(prefix="tama-kit-terminal-") as root:
        pid, terminal = pty.fork()
        if pid == 0:
            os.chdir(root)
            args = [node, cli, "bootstrap", "--no-color"]
            if dry_run:
                args.append("--dry-run")
            os.execv(node, args)
        transcript = b""
        pending = b""
        deadline = time.monotonic() + 30
        exited = False
        try:
            while time.monotonic() < deadline:
                if select.select([terminal], [], [], 0.1)[0]:
                    try:
                        chunk = os.read(terminal, 65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        chunk = b""
                    transcript += chunk
                    pending += chunk
                    # readline redraws can include ANSI control bytes; each
                    # complete prompt still ends with the literal ': '.
                    plain = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", pending)
                    if answers and plain.endswith(b": "):
                        os.write(terminal, answers.pop(0))
                        pending = b""
                child, status = os.waitpid(pid, os.WNOHANG)
                if child:
                    exited = True
                    assert os.waitstatus_to_exitcode(status) == 0, transcript.decode(errors="replace")
                    break
            assert exited, "CLI did not exit after terminal input: " + transcript.decode(errors="replace")
            assert not answers, "CLI did not consume the expected questions"
            assert expected in transcript, transcript.decode(errors="replace")
            assert not os.listdir(root), "Terminal preview/cancellation wrote project files"
        finally:
            if not exited:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            os.close(terminal)


node, cli = sys.argv[1:]
scenario(node, cli, [b"\x03"], b"Setup paused")
scenario(node, cli, [b"\x04"], b"Setup paused")
scenario(
    node,
    cli,
    [b"\n", b"no\n", b"1\n", b"no\n", b"no\n", b"4567\n", b"1\n"],
    b"Tama host port: 4567",
    dry_run=True,
)
print("Installed CLI terminal preview, Ctrl-C, and EOF passed without writes.")
