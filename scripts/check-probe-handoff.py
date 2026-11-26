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

None of the three may switch mouse reporting on (the `mouse` setting is off by
default). Then, in the kitty terminal with `"mouse": true`, the app must
switch reporting on and back off however it ends: q, Ctrl+C, and the SIGINT /
SIGTERM / SIGHUP signals (which must still end it); and switch it off while
$EDITOR runs (menu, Ctrl+O), back on after.

Usage: python3 -I scripts/check-probe-handoff.py   (from the repo root)
"""
import fcntl
import json
import os
import pty
import select
import signal
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


MOUSE_ON = b'\x1b[?1000h'
MOUSE_OFF = b'\x1b[?1000l'
EDITOR_MARK = b'EDITOR-RAN'
# Keys (sent one by one, apart), or a signal.
ENDINGS = {'q': [b'q'], 'ctrl-c': [b'\x03'], 'editor': [b'\x1b', b'\x0f', b'q'],
           'SIGINT': signal.SIGINT, 'SIGTERM': signal.SIGTERM, 'SIGHUP': signal.SIGHUP}


def run(mode: str, mouse: bool = False, end: str = 'q') -> dict:
    xdg = tempfile.mkdtemp(prefix='teaminal-probe-')
    if mouse:
        os.makedirs(os.path.join(xdg, 'teaminal'))
        with open(os.path.join(xdg, 'teaminal', 'config.json'), 'w') as f:
            json.dump({'mouse': True}, f)
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(REPO)
        os.environ.update({'TEAMINAL_SEED': 'fixtures', 'TZ': 'UTC', 'XDG_CONFIG_HOME': xdg,
                           'VISUAL': 'printf ' + EDITOR_MARK.decode()})
        os.execvp('bun', ['bun', 'run', 'bin/teaminal.tsx'])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))

    out, answered, bg_answered, q_at, exited, status = b'', False, False, None, False, None
    # Keys still to send, and when the next one is due. Output keeps being read
    # in between: a blocked write to a full pty would make the app read them
    # all as one chunk.
    keys, key_at = [], 0.0
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
            how = ENDINGS[end]
            if isinstance(how, list):
                keys, key_at = list(how), time.time()
            else:
                os.kill(pid, how)
            q_at = time.time()
        if keys and time.time() >= key_at:
            os.write(fd, keys.pop(0))
            key_at = time.time() + 0.6
            q_at = time.time()
        if q_at is not None and time.time() - q_at > 5:
            break
    for _ in range(20):
        done, status = os.waitpid(pid, os.WNOHANG)
        if done == pid:
            exited = True
            break
        time.sleep(0.1)
    else:
        exited = False
        status = None
        os.kill(pid, 9)
        os.waitpid(pid, 0)
    on, off = out.rfind(MOUSE_ON), out.rfind(MOUSE_OFF)
    mark = out.find(EDITOR_MARK)
    return {
        # Off before the editor printed, on again after it.
        'editor_between': mark >= 0
        and out.rfind(MOUSE_OFF, 0, mark) > out.rfind(MOUSE_ON, 0, mark) >= 0
        and out.find(MOUSE_ON, mark) >= 0,
        'any_mouse_mode': b'\x1b[?1000' in out or b'\x1b[?1006' in out,
        'signal': signal.Signals(os.WTERMSIG(status)).name
        if status is not None and os.WIFSIGNALED(status) else None,
        'mouse_on': on >= 0,
        'mouse_off_last': off > on >= 0,
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
            and not r['any_mouse_mode']
        )
        ok = ok and good
        print(f"{'ok  ' if good else 'FAIL'} {mode:6} {r}")
    for end in ENDINGS:
        r = run('kitty', mouse=True, end=end)
        good = (
            r['quit_on_q']
            and r['mouse_on']
            and r['mouse_off_last']
            and r['popped']
            and r['signal'] == (end if end.startswith('SIG') else None)
            and r['editor_between'] == (end == 'editor')
        )
        ok = ok and good
        print(f"{'ok  ' if good else 'FAIL'} mouse {end:7} {r}")
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
