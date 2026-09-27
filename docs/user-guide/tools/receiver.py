"""Receives screenshots from capture-helper.js and saves them as PNG files.

    python3 docs/user-guide/tools/receiver.py

Listens on 127.0.0.1:8767 only, accepts PNG data from the local dev server
(http://localhost:3000), and writes docs/user-guide/images/<name>.png.
Run optimize.py afterwards to turn screenshots into small JPEGs.
"""
import base64
import os
import re
from http.server import BaseHTTPRequestHandler, HTTPServer

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "images")


class Handler(BaseHTTPRequestHandler):
    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "http://localhost:3000")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_POST(self):
        match = re.match(r"^/save\?name=([a-z0-9-]{2,60})$", self.path)
        body = self.rfile.read(int(self.headers.get("content-length", 0))).decode()
        if not match or not body.startswith("data:image/png;base64,"):
            self.send_response(400)
            self.cors()
            self.end_headers()
            return
        data = base64.b64decode(body.split(",", 1)[1])
        with open(os.path.join(OUT, match.group(1) + ".png"), "wb") as file:
            file.write(data)
        self.send_response(200)
        self.cors()
        self.end_headers()
        self.wfile.write(str(len(data)).encode())

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print("Saving screenshots to", os.path.normpath(OUT))
    HTTPServer(("127.0.0.1", 8767), Handler).serve_forever()
