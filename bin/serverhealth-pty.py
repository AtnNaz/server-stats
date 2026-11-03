#!/usr/bin/env python3
"""Node Stats panel terminali: systemd soketinden gelen bağlantı için bir PTY'de giriş kabuğu açar.

serverhealth-term@.service tarafından, terminal için seçilen kullanıcıyla çalıştırılır; soket stdin/stdout'tur.
Gelen veri çerçevelidir: [tür 1 bayt][uzunluk 4 bayt][veri]; tür 0 = klavye girdisi, 1 = boyut (sütun, satır).
Giden veri kabuğun ham çıktısıdır. Bağlantı kapanınca kabuğa SIGHUP gönderilir.
"""
import fcntl
import os
import pty
import pwd
import select
import signal
import struct
import sys
import termios

SOCK_IN, SOCK_OUT = 0, 1
MAX_PACKET = 1024 * 1024


def shell_env(user):
    env = {
        'TERM': 'xterm-256color',
        'COLORTERM': 'truecolor',
        'HOME': user.pw_dir,
        'USER': user.pw_name,
        'LOGNAME': user.pw_name,
        'SHELL': user.pw_shell,
        'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin',
        'LANG': os.environ.get('LANG', 'C.UTF-8'),
    }
    for key in ('XDG_RUNTIME_DIR',):
        if key in os.environ:
            env[key] = os.environ[key]
    return env


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))


def write_all(fd, data):
    while data:
        n = os.write(fd, data)
        data = data[n:]


def main():
    user = pwd.getpwuid(os.getuid())
    if os.getuid() == 0:
        sys.exit('Terminal root olarak açılmaz.')
    shell = user.pw_shell if user.pw_shell and os.access(user.pw_shell, os.X_OK) else '/bin/bash'

    pid, master = pty.fork()
    if pid == 0:
        try:
            os.chdir(user.pw_dir)
        except OSError:
            os.chdir('/')
        os.execve(shell, ['-' + os.path.basename(shell)], shell_env(user))

    set_size(master, 80, 24)
    pending = b''
    try:
        while True:
            ready, _, _ = select.select([SOCK_IN, master], [], [])
            if master in ready:
                try:
                    out = os.read(master, 65536)
                except OSError:
                    out = b''
                if not out:
                    break
                write_all(SOCK_OUT, out)
            if SOCK_IN in ready:
                chunk = os.read(SOCK_IN, 65536)
                if not chunk:
                    break
                pending += chunk
                while len(pending) >= 5:
                    kind = pending[0]
                    size = struct.unpack('>I', pending[1:5])[0]
                    if size > MAX_PACKET:
                        return
                    if len(pending) < 5 + size:
                        break
                    data, pending = pending[5:5 + size], pending[5 + size:]
                    if kind == 0:
                        write_all(master, data)
                    elif kind == 1 and size == 4:
                        cols, rows = struct.unpack('>HH', data)
                        set_size(master, cols, rows)
    except (BrokenPipeError, ConnectionResetError):
        pass
    finally:
        try:
            os.killpg(os.getpgid(pid), signal.SIGHUP)
        except OSError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass


if __name__ == '__main__':
    main()
