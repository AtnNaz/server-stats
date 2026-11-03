#!/usr/bin/env python3
"""Node Stats yapay zekâ komutları: systemd soketinden gelen tek bir komutu çalıştırıp çıktısını döner.

serverhealth-exec@.service tarafından, terminal için seçilen kullanıcıyla çalıştırılır; soket stdin/stdout'tur.
Gelen: tek satır JSON {"command": "...", "timeout": 30, "sudo_password": "..."(isteğe bağlı)}.
Giden: tek satır JSON {"code": 0, "output": "...", "truncated": false, "timedOut": false}.
Komut terminal olmadan çalışır. Şifre verilirse komut tek bir "sudo ..." olmalıdır; "sudo -k -S" ile
çalıştırılır ve şifre yalnızca sudo'nun girişine yazılır (kayda ya da çıktıya geçmez).
"""
import json
import os
import pwd
import select
import shlex
import signal
import subprocess
import sys
import time

MAX_REQUEST = 16 * 1024
MAX_OUTPUT = 64 * 1024
MAX_TIMEOUT = 600
# Kabuğun yorumlayacağı karakterler: şifreli sudo komutunda hiçbiri olmamalı (panel de denetler).
UNSAFE = set(';&><`$(){}\\\n\r!*?[]~|')


def env_for(user):
    return {
        'HOME': user.pw_dir,
        'USER': user.pw_name,
        'LOGNAME': user.pw_name,
        'SHELL': user.pw_shell,
        'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin',
        'LANG': os.environ.get('LANG', 'C.UTF-8'),
        'TERM': 'dumb',
        'SYSTEMD_PAGER': '',
        'PAGER': 'cat',
        'NO_COLOR': '1',
    }


def reply(obj):
    data = (json.dumps(obj, ensure_ascii=False) + '\n').encode('utf-8')
    while data:
        data = data[os.write(1, data):]


def read_request():
    data = b''
    while b'\n' not in data and len(data) < MAX_REQUEST:
        chunk = os.read(0, 4096)
        if not chunk:
            break
        data += chunk
    line = data.split(b'\n', 1)[0]
    return json.loads(line.decode('utf-8'))


def main():
    if os.getuid() == 0:
        reply({'error': 'root'})
        sys.exit(1)
    try:
        req = read_request()
        command = req['command']
        if not isinstance(command, str) or not command.strip() or len(command) > 2000 or '\0' in command:
            raise ValueError('command')
        timeout = min(max(int(req.get('timeout', 30)), 1), MAX_TIMEOUT)
        password = req.get('sudo_password')
        argv = ['/bin/bash', '-c', command]
        if password is not None:
            if not isinstance(password, str) or not password or any(c in password for c in '\r\n\0'):
                raise ValueError('password')
            parts = shlex.split(command)
            if any(c in UNSAFE for c in command) or len(parts) < 2 or parts[0] != 'sudo' or parts[1].startswith('-'):
                raise ValueError('sudo_form')
            argv = ['sudo', '-k', '-S', '-p', '', '--'] + parts[1:]
    except Exception:
        reply({'error': 'bad_request'})
        return

    user = pwd.getpwuid(os.getuid())
    proc = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE if password is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        cwd=user.pw_dir if os.path.isdir(user.pw_dir) else '/',
        env=env_for(user),
        start_new_session=True,
    )
    if password is not None:
        # Şifre bir kez yazılıp giriş kapatılır; sudo -k önbelleği kullanmadığı için onu mutlaka kendisi okur.
        try:
            proc.stdin.write((password + '\n').encode('utf-8'))
            proc.stdin.close()
        except BrokenPipeError:
            pass
        password = None
    output = b''
    truncated = False
    timed_out = False
    deadline = time.monotonic() + timeout
    fd = proc.stdout.fileno()
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            timed_out = True
            break
        ready, _, _ = select.select([fd], [], [], left)
        if not ready:
            continue
        chunk = os.read(fd, 65536)
        if not chunk:
            break
        if len(output) < MAX_OUTPUT:
            output += chunk[:MAX_OUTPUT - len(output)]
        if len(output) >= MAX_OUTPUT:
            truncated = True
            break
    if timed_out or truncated:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
    try:
        code = proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        code = proc.wait()
    reply({'code': code, 'output': output.decode('utf-8', 'replace'), 'truncated': truncated, 'timedOut': timed_out})


if __name__ == '__main__':
    main()
