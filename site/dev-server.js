#!/usr/bin/env node
/**
 * Zero-dependency static dev server with live reload.
 *
 * Usage:
 *   node dev-server.js [port]
 *
 * Serves the directory this script lives in, and injects a tiny
 * live-reload client into every HTML response. When any file under
 * this directory changes, connected browser tabs auto-refresh.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 8080;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const IGNORED_DIRS = new Set(["node_modules", ".git", ".next"]);

const LIVERELOAD_SNIPPET = `
<script>
(function () {
  var es;
  function connect() {
    es = new EventSource("/__livereload");
    es.onmessage = function (e) {
      if (e.data === "reload") location.reload();
    };
    es.onerror = function () {
      es.close();
      setTimeout(connect, 1000);
    };
  }
  connect();
})();
</script>
</body>`;

// ---- SSE client registry ----
const clients = new Set();

function broadcastReload() {
  for (const res of clients) {
    res.write("data: reload\n\n");
  }
  console.log(`[reload] notified ${clients.size} client(s)`);
}

// ---- File watching ----
//
// fs.watch (inotify/ReadDirectoryChangesW) is unreliable here: this project
// lives on a Windows drive mounted into WSL via DrvFs, and DrvFs does not
// propagate inotify events. Polling with mtime snapshots works regardless
// of the underlying filesystem, at the cost of a periodic directory walk.
const POLL_INTERVAL_MS = 400;
let snapshot = new Map(); // path -> mtimeMs

function walkFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function takeSnapshot() {
  const files = walkFiles(ROOT, []);
  const next = new Map();
  for (const file of files) {
    try {
      next.set(file, fs.statSync(file).mtimeMs);
    } catch {
      // file may have been removed mid-walk; skip it
    }
  }
  return next;
}

function pollForChanges() {
  const next = takeSnapshot();
  let changed = next.size !== snapshot.size;
  if (!changed) {
    for (const [file, mtime] of next) {
      if (snapshot.get(file) !== mtime) {
        changed = true;
        break;
      }
    }
  }
  snapshot = next;
  if (changed) broadcastReload();
}

snapshot = takeSnapshot();
setInterval(pollForChanges, POLL_INTERVAL_MS);

// ---- HTTP server ----
function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const resolved = path.normalize(path.join(root, decoded));
  if (!resolved.startsWith(root)) return null; // path traversal guard
  return resolved;
}

const server = http.createServer((req, res) => {
  if (req.url === "/__livereload") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  let filePath = safeJoin(ROOT, req.url);
  if (!filePath) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        // fall back to trying a .html extension (e.g. /areas -> /areas.html)
        const withHtml = filePath + ".html";
        fs.readFile(withHtml, (err2, data2) => {
          if (err2) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("404 Not Found: " + req.url);
            return;
          }
          sendFile(res, withHtml, data2);
        });
        return;
      }
      sendFile(res, filePath, data);
    });
  });
});

function sendFile(res, filePath, data) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || "application/octet-stream";

  if (ext === ".html") {
    let html = data.toString("utf-8");
    if (html.includes("</body>")) {
      html = html.replace("</body>", LIVERELOAD_SNIPPET);
    } else {
      html += LIVERELOAD_SNIPPET.replace("</body>", "");
    }
    res.writeHead(200, { "Content-Type": mime });
    res.end(html);
    return;
  }

  res.writeHead(200, { "Content-Type": mime });
  res.end(data);
}

server.listen(PORT, () => {
  console.log(`\n  Dev server running:  http://localhost:${PORT}/`);
  console.log(`  Watching for changes under: ${ROOT}`);
  console.log(`  Press Ctrl+C to stop.\n`);
});

process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});
