#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from flask import Flask, request, jsonify, send_from_directory, make_response, Response
import urllib.request
import urllib.parse
import urllib.error
import json
import time
import os

app = Flask(__name__)

@app.after_request
def after_request(response):
    response.headers.add('Access-Control-Allow-Origin', '*')
    response.headers.add('Access-Control-Allow-Headers', 'Content-Type,Authorization')
    response.headers.add('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS')
    return response

def fetch_with_retry(url, max_retries=3, timeout=45):
    last_error = None
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0",
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "ar,en;q=0.9",
                "Referer": "http://barqtv.fit/"
            })
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
                try:
                    return json.loads(data.decode("utf-8"))
                except json.JSONDecodeError:
                    return {"raw": data.decode("utf-8", errors="ignore")}
        except urllib.error.HTTPError as e:
            return {"error": f"HTTP {e.code}", "details": e.reason}
        except Exception as e:
            last_error = str(e)
            if attempt < max_retries - 1:
                time.sleep(1.5)
    return {"error": f"Failed after {max_retries} attempts: {last_error}"}

@app.route("/")
def index():
    response = make_response(send_from_directory(".", "index.html"))
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return response

@app.route("/manifest.json")
def manifest():
    response = make_response(send_from_directory(".", "manifest.json"))
    response.headers['Content-Type'] = 'application/json'
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return response

@app.route("/sw.js")
def sw():
    response = make_response(send_from_directory(".", "sw.js"))
    response.headers['Content-Type'] = 'application/javascript'
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    response.headers['Service-Worker-Allowed'] = '/'
    return response

@app.route("/images/<path:filename>")
def images(filename):
    return send_from_directory("images", filename)

@app.route("/logo1.png")
def logo():
    return send_from_directory(".", "logo1.png")

@app.route("/api")
def api():
    host = request.args.get("host", "").strip()
    user = request.args.get("user", "").strip()
    pwd = request.args.get("pass", "").strip()
    action = request.args.get("action", "").strip()
    extra = request.args.get("extra", "")
    if not all([host, user, pwd, action]):
        return jsonify({"error": "Missing parameters"}), 400
    if host.endswith("/"): host = host[:-1]
    url = f"{host}/player_api.php?username={urllib.parse.quote(user)}&password={urllib.parse.quote(pwd)}&action={action}{extra}"
    timeout = 60 if action == "get_live_streams" else 35
    result = fetch_with_retry(url, max_retries=3, timeout=timeout)
    if "error" in result:
        return jsonify(result), 502
    return jsonify(result)

@app.route("/stream")
def stream_proxy():
    url = request.args.get("url", "").strip()
    if not url:
        return jsonify({"error": "Missing url parameter"}), 400
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0",
            "Accept": "*/*",
            "Referer": "http://barqtv.fit/"
        })
        resp = urllib.request.urlopen(req, timeout=30)
        content_type = resp.headers.get('Content-Type', 'application/octet-stream')
        def generate():
            while True:
                chunk = resp.read(8192)
                if not chunk:
                    break
                yield chunk
        return Response(
            generate(),
            content_type=content_type,
            headers={
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-cache'
            }
        )
    except Exception as e:
        return jsonify({"error": "Stream failed", "details": str(e)}), 502

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
