"""Regression check for AGENTS.md pitfall 10: keys must still reach Ink after
the pre-Ink terminal probes.

The tui-test harness (xterm.js) never answers the probes, so it only covers
the timeout path. This runs teaminal (seeded) in a pty that answers like
three kinds of terminal, presses q, and checks the app quits:

  kitty   answers the kitty keyboard query + DA1 -> mode pushed, popped on exit
  plain   answers DA1 only                       -> mode never pushed
  silent  answers nothing (probe times out)      -> mode never pushed

The background-color probe (OSC 11, for the 'auto' theme) runs after it; the
kitty mode also answers that with a color, plain with DA1 only.

Usage: python3 -I scripts/check-probe-handoff.py   (from the repo root)
"""
import fcntl
import os
import pty
import select
import struct
import sys
import tempfile
import termios
import time

REPO = os.getcwd()
QUERY = b'\x1b[?u\x1b[c'
ANSWERS = {'kitty': b'\x1b[?0u\x1b[?62;22c', 'plain': b'\x1b[?62;22c', 'silent': b''}
BG_QUERY = b'\x1b]11;?\x1b\\\x1b[c'
BG_ANSWERS = {
    'kitty': b'\x1b]11;rgb:f7f7/f7f7/f7f7\x1b\\\x1b[?62;22c',
    'plain': b'\x1b[?62;22c',
    'silent': b'',
}


def run(mode: str) -> dict:
    xdg = tempfile.mkdtemp(prefix='teaminal-probe-')
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(REPO)
        os.environ.update({'TEAMINAL_SEED': 'fixtures', 'TZ': 'UTC', 'XDG_CONFIG_HOME': xdg})
        os.execvp('bun', ['bun', 'run', 'bin/teaminal.tsx'])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))

    out, answered, bg_answered, q_at, exited = b'', False, False, None, False
    deadline = time.time() + 30
    while time.time() < deadline:
        if select.select([fd], [], [], 0.05)[0]:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                chunk = b''
            if not chunk:
                exited = True
                break
            out += chunk
        if not answered and QUERY in out:
            answered = True
            if ANSWERS[mode]:
                os.write(fd, ANSWERS[mode])
        if not bg_answered and BG_QUERY in out:
            bg_answered = True
            if BG_ANSWERS[mode]:
                os.write(fd, BG_ANSWERS[mode])
        if q_at is None and b'Ada Byron' in out:
            time.sleep(0.5)
            os.write(fd, b'q')
            q_at = time.time()
        if q_at is not None and time.time() - q_at > 5:
            break
    if not exited:
        exited = os.waitpid(pid, os.WNOHANG)[0] == pid
    if not exited:
        os.kill(pid, 9)
    return {
        'probe_seen': answered,
        'bg_probe_seen': bg_answered,
        'quit_on_q': exited,
        'pushed': b'\x1b[>1u' in out,
        'popped': b'\x1b[<u' in out,
    }


def main() -> int:
    ok = True
    for mode in ('kitty', 'plain', 'silent'):
        r = run(mode)
        want_mode = mode == 'kitty'
        good = (
            r['probe_seen']
            and r['bg_probe_seen']
            and r['quit_on_q']
            and r['pushed'] == want_mode
            and r['popped'] == want_mode
        )
        ok = ok and good
        print(f"{'ok  ' if good else 'FAIL'} {mode:6} {r}")
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
