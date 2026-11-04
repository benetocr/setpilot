# Non-blocking TCP server on 127.0.0.1, newline-delimited JSON.
#
# No threads: Live runs Python on its main thread and only when it calls in,
# so everything here is polled from Live's own callbacks (update_display,
# receive_midi, and the song position listener). Nothing blocks.

import errno
import json
import os
import socket
import time

PORTS = list(range(8790, 8800))


def _now_ms():
    return time.time() * 1000.0


class Client(object):
    def __init__(self, sock, addr):
        self.sock = sock
        self.addr = addr
        self.inbuf = b""
        self.outbuf = b""
        self.authed = False
        self.alive = True


class Server(object):
    def __init__(self, token, log=None, discovery_path=None, ports=None):
        self.token = token
        self.log = log or (lambda m: None)
        self.discovery_path = discovery_path
        self.ports = ports or PORTS
        self.sock = None
        self.port = 0
        self.clients = []
        self.on_connect = None      # fn(client)
        self.on_message = None      # fn(client, msg)

    # ------------------------------------------------------------ lifecycle
    def start(self, info=None):
        for port in self.ports:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind(("127.0.0.1", port))
                s.listen(4)
                s.setblocking(False)
                self.sock = s
                self.port = port
                break
            except socket.error:
                s.close()
        if not self.sock:
            self.log("no free port in %r" % (self.ports,))
            return False
        self.write_discovery(info or {})
        self.log("listening on 127.0.0.1:%d" % self.port)
        return True

    def write_discovery(self, info):
        if not self.discovery_path:
            return
        try:
            d = os.path.dirname(self.discovery_path)
            if not os.path.isdir(d):
                os.makedirs(d)
            data = dict(info)
            data.update({"port": self.port, "token": self.token, "pid": os.getpid(), "at": int(time.time())})
            tmp = self.discovery_path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(data, f)
            try:
                os.chmod(tmp, 0o600)
            except Exception:
                pass
            os.replace(tmp, self.discovery_path)
        except Exception as e:
            self.log("discovery file: %s" % e)

    def stop(self):
        for c in list(self.clients):
            self.drop(c, "bye")
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass
            self.sock = None
        if self.discovery_path:
            try:
                with open(self.discovery_path) as f:
                    if json.load(f).get("port") == self.port:
                        os.remove(self.discovery_path)
            except Exception:
                pass

    # ------------------------------------------------------------ polling
    def poll(self, handle=True):
        """Accept, read and write without blocking. With handle=False incoming
        messages are only buffered (used inside Live notifications, where the
        set must not be changed)."""
        if not self.sock:
            return
        while True:
            try:
                s, addr = self.sock.accept()
            except socket.error:
                break
            s.setblocking(False)
            try:
                s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except Exception:
                pass
            self.clients.append(Client(s, addr))
        for c in list(self.clients):
            self._read(c)
            if handle:
                self._dispatch(c)
            self._write(c)

    def _read(self, c):
        while c.alive:
            try:
                data = c.sock.recv(65536)
            except socket.error as e:
                if e.args and e.args[0] in (errno.EAGAIN, errno.EWOULDBLOCK, getattr(errno, "WSAEWOULDBLOCK", -1)):
                    return
                self.drop(c)
                return
            if not data:
                self.drop(c)
                return
            c.inbuf += data
            if len(c.inbuf) > 16 * 1024 * 1024:
                self.drop(c)
                return

    def _dispatch(self, c):
        while c.alive and b"\n" in c.inbuf:
            line, c.inbuf = c.inbuf.split(b"\n", 1)
            if not line.strip():
                continue
            try:
                msg = json.loads(line.decode("utf-8"))
            except Exception:
                continue
            if not c.authed:
                if msg.get("t") == "auth" and msg.get("token") == self.token:
                    c.authed = True
                    if self.on_connect:
                        self.on_connect(c)
                else:
                    self.drop(c)
                continue
            if self.on_message:
                self.on_message(c, msg)

    def _write(self, c):
        while c.alive and c.outbuf:
            try:
                n = c.sock.send(c.outbuf)
            except socket.error as e:
                if e.args and e.args[0] in (errno.EAGAIN, errno.EWOULDBLOCK, getattr(errno, "WSAEWOULDBLOCK", -1)):
                    return
                self.drop(c)
                return
            c.outbuf = c.outbuf[n:]

    def has_input(self):
        return any(b"\n" in c.inbuf for c in self.clients)

    # ------------------------------------------------------------ sending
    def send(self, c, msg):
        if not c.alive or not c.authed:
            return
        c.outbuf += (json.dumps(msg, separators=(",", ":")) + "\n").encode("utf-8")
        if len(c.outbuf) > 64 * 1024 * 1024:
            self.drop(c)
            return
        self._write(c)

    def broadcast(self, msg):
        line = None
        for c in self.clients:
            if c.alive and c.authed:
                if line is None:
                    line = (json.dumps(msg, separators=(",", ":")) + "\n").encode("utf-8")
                c.outbuf += line
                self._write(c)

    def drop(self, c, why=None):
        if why:
            try:
                c.sock.send((json.dumps({"t": why}) + "\n").encode("utf-8"))
            except Exception:
                pass
        c.alive = False
        try:
            c.sock.close()
        except Exception:
            pass
        if c in self.clients:
            self.clients.remove(c)

    def authed_clients(self):
        return [c for c in self.clients if c.alive and c.authed]
